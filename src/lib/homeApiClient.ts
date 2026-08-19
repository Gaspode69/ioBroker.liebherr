export const HOME_API_BASE_URL = 'https://home-api.smartdevice.liebherr.com';

/** Appliance metadata returned by the HomeAPI device endpoint. */
export interface LiebherrDevice {
	/** Stable appliance identifier (serial number). */
	deviceId: string;
	/** User-defined appliance nickname. */
	nickname?: string;
	/** Appliance category reported by Liebherr. */
	deviceType?: string;
	/** Optional product image URL. */
	imageUrl?: string;
	/** Product or model name. */
	deviceName?: string;
}

/** Common fields shared by all HomeAPI control capabilities. */
export interface BaseControl {
	/** OpenAPI discriminator for the control schema. */
	type: string;
	/** Capability name, for example temperature or nightmode. */
	name: string;
	/** Optional appliance zone identifier. */
	zoneId?: number;
	/** Optional relative zone position. */
	zonePosition?: string;
	/** Forward-compatible fields supplied by future API versions. */
	[key: string]: unknown;
}

/** Boolean HomeAPI capability. */
export interface ToggleControl extends BaseControl {
	/** Toggle control discriminator. */
	type: 'ToggleControl';
	/** Current toggle state. */
	value: boolean;
}

/** Temperature capability for one appliance zone. */
export interface TemperatureControl extends BaseControl {
	/** Temperature control discriminator. */
	type: 'TemperatureControl';
	/** Appliance zone identifier. */
	zoneId: number;
	/** Current measured temperature. */
	value: number;
	/** Current target temperature. */
	target: number;
	/** Minimum supported target. */
	min: number;
	/** Maximum supported target. */
	max: number;
	/** Temperature unit reported by the appliance. */
	unit: string;
	/** Optional discrete target values. */
	setTemperatureSteps?: number[];
	/** Whether discrete target values are enforced. */
	setTemperatureStepsEnabled?: boolean;
}

export type LiebherrControl = TemperatureControl | ToggleControl | BaseControl;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Callbacks invoked while consuming a HomeAPI control event stream. */
export interface ControlStreamHandlers {
	/** Called once the server has accepted the SSE request. */
	onOpen?: () => void;
	/** Called sequentially for every valid controls event. */
	onControls: (controls: LiebherrControl[]) => Promise<void> | void;
	/** Called for malformed individual events; the stream continues afterwards. */
	onMalformedEvent?: (error: LiebherrResponseError) => void;
}

/** HTTP error returned by the Liebherr HomeAPI. */
export class LiebherrApiError extends Error {
	/**
	 * @param message Safe error message without credentials.
	 * @param status HTTP status code.
	 * @param retryAfterMs Server-requested retry delay.
	 */
	public constructor(
		message: string,
		public readonly status?: number,
		public readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = 'LiebherrApiError';
	}
}

/** Malformed JSON or schema error returned by the HomeAPI. */
export class LiebherrResponseError extends Error {
	/** @param message Safe response validation message. */
	public constructor(message: string) {
		super(message);
		this.name = 'LiebherrResponseError';
	}
}

/** Transport-level error which deliberately excludes request headers. */
export class LiebherrNetworkError extends Error {
	/** Creates a credential-safe network error. */
	public constructor() {
		super('The Liebherr HomeAPI request could not be completed');
		this.name = 'LiebherrNetworkError';
	}
}

/** Injectable API client options, primarily used by tests. */
export interface HomeApiClientOptions {
	/** Override for the HomeAPI origin. */
	baseUrl?: string;
	/** Fetch implementation. */
	fetch?: FetchLike;
	/** Request timeout in milliseconds. */
	requestTimeoutMs?: number;
}

/** Body accepted by the HomeAPI temperature control endpoint. */
export interface SetTemperatureRequest {
	/** Appliance zone to update. */
	zoneId: number;
	/** Requested target temperature. */
	target: number;
	/** Temperature unit reported by the capability. */
	unit: string;
}

/** Body accepted by the HomeAPI toggle control endpoints. */
export interface SetToggleRequest {
	/** Requested toggle value. */
	value: boolean;
	/** Zone required by zone-associated controls. */
	zoneId?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
	if (value === null) {
		return undefined;
	}

	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.ceil(seconds * 1000);
	}

	const date = Date.parse(value);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - now);
	}

	return undefined;
}

/**
 * Validates a HomeAPI device response.
 *
 * @param payload Parsed JSON response.
 * @returns Validated device metadata.
 */
export function parseDevices(payload: unknown): LiebherrDevice[] {
	if (!Array.isArray(payload)) {
		throw new LiebherrResponseError('The HomeAPI device response is not an array');
	}

	return payload.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.deviceId !== 'string' || entry.deviceId.length === 0) {
			throw new LiebherrResponseError(`The HomeAPI device at index ${index} is malformed`);
		}

		return {
			deviceId: entry.deviceId,
			nickname: optionalString(entry.nickname),
			deviceType: optionalString(entry.deviceType),
			imageUrl: optionalString(entry.imageUrl),
			deviceName: optionalString(entry.deviceName),
		};
	});
}

/**
 * Validates the common fields of a HomeAPI controls response.
 *
 * @param payload Parsed JSON response.
 * @returns Forward-compatible control records.
 */
export function parseControls(payload: unknown): LiebherrControl[] {
	if (!Array.isArray(payload)) {
		throw new LiebherrResponseError('The HomeAPI controls response is not an array');
	}

	return payload.map((entry, index) => {
		if (
			!isRecord(entry) ||
			typeof entry.type !== 'string' ||
			entry.type.length === 0 ||
			typeof entry.name !== 'string' ||
			entry.name.length === 0
		) {
			throw new LiebherrResponseError(`The HomeAPI control at index ${index} is malformed`);
		}

		const control: BaseControl = {
			...entry,
			type: entry.type,
			name: entry.name,
		};
		if (typeof entry.zoneId === 'number' && Number.isFinite(entry.zoneId)) {
			control.zoneId = entry.zoneId;
		} else {
			delete control.zoneId;
		}
		if (typeof entry.zonePosition === 'string') {
			control.zonePosition = entry.zonePosition;
		} else {
			delete control.zonePosition;
		}
		return control;
	});
}

/** Minimal client for the Liebherr SmartDevice HomeAPI. */
export class HomeApiClient {
	private readonly baseUrl: string;
	private readonly fetch: FetchLike;
	private readonly requestTimeoutMs: number;

	/**
	 * @param apiKey HomeAPI credential, used only in the api-key header.
	 * @param options Optional injectable client settings.
	 */
	public constructor(
		private readonly apiKey: string,
		options: HomeApiClientOptions = {},
	) {
		this.baseUrl = (options.baseUrl ?? HOME_API_BASE_URL).replace(/\/$/, '');
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
	}

	/** @returns All appliances associated with the configured API key. */
	public async getDevices(): Promise<LiebherrDevice[]> {
		return parseDevices(await this.get('/v1/devices'));
	}

	/**
	 * @param deviceId Appliance identifier returned by getDevices.
	 * @returns All currently reported capabilities for the appliance.
	 */
	public async getControls(deviceId: string): Promise<LiebherrControl[]> {
		return parseControls(await this.get(`/v1/devices/${encodeURIComponent(deviceId)}/controls`));
	}

	/**
	 * Consumes realtime control updates until the server closes the stream or the signal is aborted.
	 *
	 * @param deviceId Appliance identifier returned by getDevices.
	 * @param handlers Stream lifecycle and event callbacks.
	 * @param signal Signal used by the adapter to stop the long-lived request.
	 */
	public async streamControls(deviceId: string, handlers: ControlStreamHandlers, signal: AbortSignal): Promise<void> {
		let response: Response;
		try {
			response = await this.fetch(`${this.baseUrl}/v1/sse/devices/${encodeURIComponent(deviceId)}/controls`, {
				method: 'GET',
				headers: {
					Accept: 'text/event-stream',
					'Cache-Control': 'no-cache',
					'api-key': this.apiKey,
				},
				signal,
			});
		} catch {
			if (signal.aborted) {
				return;
			}
			throw new LiebherrNetworkError();
		}

		if (!response.ok) {
			throw this.createApiError(response);
		}
		if (!response.body) {
			throw new LiebherrResponseError('The HomeAPI SSE response has no body');
		}

		handlers.onOpen?.();
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let dataLines: string[] = [];

		const dispatch = async (): Promise<void> => {
			if (dataLines.length === 0) {
				return;
			}
			const data = dataLines.join('\n');
			dataLines = [];
			let controls: LiebherrControl[];
			try {
				controls = parseControls(JSON.parse(data) as unknown);
			} catch (error) {
				const responseError =
					error instanceof LiebherrResponseError
						? error
						: new LiebherrResponseError('The HomeAPI SSE event contains invalid JSON');
				handlers.onMalformedEvent?.(responseError);
				return;
			}
			await handlers.onControls(controls);
		};

		try {
			while (!signal.aborted) {
				const { done, value } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				let newline = buffer.indexOf('\n');
				while (newline >= 0) {
					let line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.endsWith('\r')) {
						line = line.slice(0, -1);
					}
					if (line === '') {
						await dispatch();
					} else if (line.startsWith('data:')) {
						const value = line.slice(5);
						dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
					}
					newline = buffer.indexOf('\n');
				}
				if (done) {
					if (buffer.startsWith('data:')) {
						const value = buffer.slice(5).replace(/\r$/, '');
						dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
					}
					await dispatch();
					return;
				}
			}
		} catch {
			if (!signal.aborted) {
				throw new LiebherrNetworkError();
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Sets the target temperature of one appliance zone.
	 *
	 * @param deviceId Appliance identifier returned by getDevices.
	 * @param request Validated temperature request.
	 */
	public async setTemperature(deviceId: string, request: SetTemperatureRequest): Promise<void> {
		await this.post(`/v1/devices/${encodeURIComponent(deviceId)}/controls/temperature`, request);
	}

	/**
	 * Sets one supported boolean appliance control.
	 *
	 * @param deviceId Appliance identifier returned by getDevices.
	 * @param controlName Capability name returned by getControls.
	 * @param request Validated toggle request.
	 */
	public async setToggle(deviceId: string, controlName: string, request: SetToggleRequest): Promise<void> {
		await this.post(
			`/v1/devices/${encodeURIComponent(deviceId)}/controls/${encodeURIComponent(controlName)}`,
			request,
		);
	}

	private async get(path: string): Promise<unknown> {
		const response = await this.request(path, { method: 'GET' });

		try {
			return await response.json();
		} catch {
			throw new LiebherrResponseError('The HomeAPI returned invalid JSON');
		}
	}

	private async post(path: string, body: SetTemperatureRequest | SetToggleRequest): Promise<void> {
		await this.request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	private async request(path: string, init: RequestInit): Promise<Response> {
		let response: Response;
		try {
			response = await this.fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					Accept: 'application/json',
					...init.headers,
					'api-key': this.apiKey,
				},
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch {
			throw new LiebherrNetworkError();
		}

		if (!response.ok) {
			throw this.createApiError(response);
		}

		return response;
	}

	private createApiError(response: Response): LiebherrApiError {
		return new LiebherrApiError(
			`The Liebherr HomeAPI returned HTTP ${response.status}`,
			response.status,
			parseRetryAfter(response.headers.get('retry-after')),
		);
	}
}
