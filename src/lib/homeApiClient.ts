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

/** Minimal read-only client for the Liebherr SmartDevice HomeAPI. */
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

	private async get(path: string): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetch(`${this.baseUrl}${path}`, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					'api-key': this.apiKey,
				},
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch {
			throw new LiebherrNetworkError();
		}

		if (!response.ok) {
			throw new LiebherrApiError(
				`The Liebherr HomeAPI returned HTTP ${response.status}`,
				response.status,
				parseRetryAfter(response.headers.get('retry-after')),
			);
		}

		try {
			return await response.json();
		} catch {
			throw new LiebherrResponseError('The HomeAPI returned invalid JSON');
		}
	}
}
