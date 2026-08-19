/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { mapControl, reconcileDeviceIds, toIdSegment, type MappedState } from './lib/controlMapper';
import {
	HomeApiClient,
	LiebherrApiError,
	LiebherrNetworkError,
	LiebherrResponseError,
	type LiebherrDevice,
	type LiebherrControl,
} from './lib/homeApiClient';
import { calculateRetryDelay } from './lib/retry';
import { maskDeviceId, redactDeviceId } from './lib/privacy';
import {
	ControlValidationError,
	processStateWrite,
	type ControlWrite,
	type WritableControl,
} from './lib/writeController';

const DEFAULT_POLLING_INTERVAL_SECONDS = 300;
const MIN_POLLING_INTERVAL_SECONDS = 30;
const MAX_POLLING_INTERVAL_SECONDS = 86_400;
const CONTROL_READBACK_DELAY_MS = 2_000;
const SSE_RECONNECT_DELAY_MS = 5_000;

interface SseSession {
	deviceId: string;
	deviceKey: string;
	controller?: AbortController;
	reconnectTimer?: ioBroker.Timeout;
	consecutiveFailures: number;
}

/** ioBroker adapter for the Liebherr SmartDevice HomeAPI integration. */
class Liebherr extends utils.Adapter {
	private client?: HomeApiClient;
	private pollTimer: ioBroker.Timeout | undefined;
	private pollingIntervalMs = DEFAULT_POLLING_INTERVAL_SECONDS * 1000;
	private consecutiveFailures = 0;
	private readonly knownDevices = new Map<string, string>();
	private readonly writableControls = new Map<string, WritableControl>();
	private readonly subscribedWritableStates = new Set<string>();
	private readonly writesInProgress = new Set<string>();
	private readonly sseSessions = new Map<string, SseSession>();
	private enableSse = true;
	private unloading = false;

	/** @param options Adapter startup options supplied by js-controller. */
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'liebherr',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		await this.setConnection(false);
		this.pollingIntervalMs = this.getPollingIntervalMs(this.config.pollingInterval);
		this.enableSse = this.config.enableSse !== false;

		const apiKey = this.config.apiKey?.trim();
		if (!apiKey) {
			this.log.warn('No Liebherr HomeAPI key is configured');
			return;
		}

		await this.extendObject('devices', {
			type: 'folder',
			common: { name: 'Liebherr devices' },
			native: {},
		});
		await this.loadKnownDevices();

		this.client = new HomeApiClient(apiKey);
		await this.pollAndSchedule();
	}

	private getPollingIntervalMs(configuredInterval: number): number {
		if (!Number.isFinite(configuredInterval)) {
			return DEFAULT_POLLING_INTERVAL_SECONDS * 1000;
		}

		const seconds = Math.min(
			MAX_POLLING_INTERVAL_SECONDS,
			Math.max(MIN_POLLING_INTERVAL_SECONDS, Math.round(configuredInterval)),
		);
		if (seconds !== configuredInterval) {
			this.log.warn(
				`Polling interval ${configuredInterval} seconds is outside the supported range; using ${seconds} seconds`,
			);
		}
		return seconds * 1000;
	}

	private async loadKnownDevices(): Promise<void> {
		const objects = await this.getAdapterObjectsAsync();
		for (const object of Object.values(objects)) {
			if (object.type !== 'device' || typeof object.native.deviceId !== 'string') {
				continue;
			}

			const relativeId = object._id.startsWith(`${this.namespace}.`)
				? object._id.slice(this.namespace.length + 1)
				: object._id;
			const deviceKey = relativeId.split('.')[1];
			if (deviceKey) {
				this.knownDevices.set(object.native.deviceId, deviceKey);
			}
		}
	}

	private async pollAndSchedule(): Promise<void> {
		if (this.unloading || !this.client) {
			return;
		}

		let nextDelay = this.pollingIntervalMs;
		try {
			const errors = await this.pollOnce();
			if (errors.length === 0) {
				this.consecutiveFailures = 0;
				await this.setConnection(true);
			} else {
				this.consecutiveFailures++;
				await this.setConnection(false);
				nextDelay = Math.max(
					...errors.map(error =>
						calculateRetryDelay(this.pollingIntervalMs, this.consecutiveFailures, error),
					),
				);
			}
		} catch (error) {
			this.consecutiveFailures++;
			await this.setConnection(false);
			this.logApiError(error, 'discovering devices');
			nextDelay = calculateRetryDelay(this.pollingIntervalMs, this.consecutiveFailures, error);
		}

		if (!this.unloading) {
			this.pollTimer = this.setTimeout(() => void this.pollAndSchedule(), nextDelay);
		}
	}

	private async pollOnce(): Promise<unknown[]> {
		const client = this.client;
		if (!client) {
			return [];
		}

		const devices = await client.getDevices();
		const reconciliation = reconcileDeviceIds(
			this.knownDevices.keys(),
			devices.map(device => device.deviceId),
		);

		for (const missingDeviceId of reconciliation.missing) {
			this.stopSseSession(missingDeviceId);
			const deviceKey = this.knownDevices.get(missingDeviceId);
			if (deviceKey) {
				await this.disableDeviceWrites(deviceKey);
				await this.updateState(
					`devices.${deviceKey}.info.available`,
					'Device available',
					'indicator.connected',
					'boolean',
					false,
				);
			}
		}

		const errors: unknown[] = [];
		for (const device of devices) {
			const deviceKey = await this.updateDevice(device);
			try {
				await this.syncDeviceControls(device.deviceId, deviceKey);
				this.ensureSseSession(device.deviceId, deviceKey);
			} catch (error) {
				errors.push(error);
				await this.disableDeviceWrites(deviceKey);
				await this.setState(`devices.${deviceKey}.info.available`, { val: false, ack: true });
				this.logApiError(error, `reading controls for device ${maskDeviceId(device.deviceId)}`);
			}
		}

		return errors;
	}

	private async syncDeviceControls(deviceId: string, deviceKey: string): Promise<void> {
		const client = this.client;
		if (!client) {
			throw new LiebherrNetworkError();
		}

		const controls = await client.getControls(deviceId);
		await this.applyControls(deviceId, deviceKey, controls, true);
	}

	private async applyControls(
		deviceId: string,
		deviceKey: string,
		controls: LiebherrControl[],
		disableMissingWrites: boolean,
	): Promise<void> {
		const seenWritableIds = new Set<string>();
		for (const control of controls) {
			const mapping = mapControl(control);
			if (!mapping) {
				this.log.debug(`Unsupported or malformed control type "${control.type}" (${control.name}) ignored`);
				continue;
			}

			if (mapping.scope === 'zone' && mapping.zoneId !== undefined) {
				await this.updateZoneControl(
					deviceId,
					deviceKey,
					mapping.zoneId,
					mapping.zonePosition,
					mapping.states,
					seenWritableIds,
				);
			} else {
				await this.updateDeviceControl(deviceId, deviceKey, mapping.states, seenWritableIds);
			}
		}
		if (disableMissingWrites) {
			await this.disableDeviceWrites(deviceKey, seenWritableIds);
		}
	}

	private ensureSseSession(deviceId: string, deviceKey: string): void {
		if (!this.enableSse || this.unloading) {
			return;
		}
		const existing = this.sseSessions.get(deviceId);
		if (existing) {
			existing.deviceKey = deviceKey;
			return;
		}

		const session: SseSession = { deviceId, deviceKey, consecutiveFailures: 0 };
		this.sseSessions.set(deviceId, session);
		this.connectSse(session);
	}

	private connectSse(session: SseSession): void {
		const client = this.client;
		if (this.unloading || !client || this.sseSessions.get(session.deviceId) !== session) {
			return;
		}

		const controller = new AbortController();
		session.controller = controller;
		void client
			.streamControls(
				session.deviceId,
				{
					onOpen: () => {
						this.log.debug(`Realtime stream connected for device ${maskDeviceId(session.deviceId)}`);
					},
					onControls: async controls => {
						await this.applyControls(session.deviceId, session.deviceKey, controls, false);
						await this.setState(`devices.${session.deviceKey}.info.available`, { val: true, ack: true });
						await this.setConnection(true);
						session.consecutiveFailures = 0;
					},
					onMalformedEvent: () => {
						this.log.warn(
							`Malformed realtime control event ignored for device ${maskDeviceId(session.deviceId)}`,
						);
					},
				},
				controller.signal,
			)
			.then(() => {
				if (!controller.signal.aborted) {
					this.scheduleSseReconnect(session, new LiebherrNetworkError());
				}
			})
			.catch(error => {
				if (!controller.signal.aborted) {
					this.logApiError(error, `receiving realtime updates for device ${maskDeviceId(session.deviceId)}`);
					this.scheduleSseReconnect(session, error);
				}
			});
	}

	private scheduleSseReconnect(session: SseSession, error: unknown): void {
		if (this.unloading || this.sseSessions.get(session.deviceId) !== session) {
			return;
		}
		session.controller = undefined;
		session.consecutiveFailures++;
		const delay = this.calculateSseReconnectDelay(session.consecutiveFailures, error);
		this.log.debug(
			`Realtime stream for device ${maskDeviceId(session.deviceId)} reconnects in ${Math.ceil(delay / 1000)} seconds`,
		);
		session.reconnectTimer = this.setTimeout(() => {
			session.reconnectTimer = undefined;
			this.connectSse(session);
		}, delay);
	}

	private calculateSseReconnectDelay(consecutiveFailures: number, error: unknown): number {
		if (
			error instanceof LiebherrApiError &&
			(error.status === 404 || error.status === 412 || error.status === 422 || error.status === 429)
		) {
			return calculateRetryDelay(this.pollingIntervalMs, consecutiveFailures, error);
		}
		return calculateRetryDelay(SSE_RECONNECT_DELAY_MS, consecutiveFailures, error);
	}

	private stopSseSession(deviceId: string): void {
		const session = this.sseSessions.get(deviceId);
		if (!session) {
			return;
		}
		this.sseSessions.delete(deviceId);
		session.controller?.abort();
		this.clearTimeout(session.reconnectTimer);
	}

	private async updateDevice(device: LiebherrDevice): Promise<string> {
		const deviceKey = this.knownDevices.get(device.deviceId) ?? toIdSegment(device.deviceId);
		this.knownDevices.set(device.deviceId, deviceKey);
		const deviceRoot = `devices.${deviceKey}`;

		await this.extendObject(deviceRoot, {
			type: 'device',
			common: { name: device.nickname ?? device.deviceName ?? device.deviceId },
			native: { deviceId: device.deviceId },
		});
		await this.extendObject(`${deviceRoot}.info`, {
			type: 'channel',
			common: { name: 'Device information' },
			native: {},
		});

		await this.updateState(`${deviceRoot}.info.deviceId`, 'Device ID', 'text', 'string', device.deviceId);
		await this.updateOptionalTextState(`${deviceRoot}.info.nickname`, 'Nickname', device.nickname);
		await this.updateOptionalTextState(`${deviceRoot}.info.deviceName`, 'Device name', device.deviceName);
		await this.updateOptionalTextState(`${deviceRoot}.info.deviceType`, 'Device type', device.deviceType);
		await this.updateOptionalTextState(`${deviceRoot}.info.imageUrl`, 'Image URL', device.imageUrl);
		await this.updateState(
			`${deviceRoot}.info.available`,
			'Device available',
			'indicator.connected',
			'boolean',
			true,
		);

		return deviceKey;
	}

	private async updateOptionalTextState(id: string, name: string, value: string | undefined): Promise<void> {
		if (value !== undefined) {
			await this.updateState(id, name, 'text', 'string', value);
		}
	}

	private async updateDeviceControl(
		deviceId: string,
		deviceKey: string,
		states: MappedState[],
		seenWritableIds: Set<string>,
	): Promise<void> {
		const channelId = `devices.${deviceKey}.controls`;
		await this.extendObject(channelId, {
			type: 'channel',
			common: { name: 'Device controls' },
			native: {},
		});
		await this.updateMappedStates(deviceId, channelId, states, seenWritableIds);
	}

	private async updateZoneControl(
		deviceId: string,
		deviceKey: string,
		zoneId: number,
		zonePosition: string | undefined,
		states: MappedState[],
		seenWritableIds: Set<string>,
	): Promise<void> {
		const channelId = `devices.${deviceKey}.zone_${toIdSegment(String(zoneId))}`;
		await this.extendObject(channelId, {
			type: 'channel',
			common: { name: zonePosition ? `Zone ${zoneId} (${zonePosition})` : `Zone ${zoneId}` },
			native: { zoneId },
		});
		await this.updateState(`${channelId}.zoneId`, 'Zone ID', 'value', 'number', zoneId);
		if (zonePosition !== undefined) {
			await this.updateState(`${channelId}.position`, 'Zone position', 'text', 'string', zonePosition);
		}
		await this.updateMappedStates(deviceId, channelId, states, seenWritableIds);
	}

	private async updateMappedStates(
		deviceId: string,
		channelId: string,
		states: MappedState[],
		seenWritableIds: Set<string>,
	): Promise<void> {
		for (const state of states) {
			const relativeId = `${channelId}.${state.id}`;
			await this.extendObject(relativeId, {
				type: 'state',
				common: state.common,
				native: state.native ?? {},
			});
			await this.setState(relativeId, { val: state.value, ack: true });
			const writableId = this.registerWritableState(deviceId, relativeId, state);
			if (writableId) {
				seenWritableIds.add(writableId);
			}
		}
	}

	private registerWritableState(deviceId: string, relativeId: string, state: MappedState): string | undefined {
		if (!state.common.write || !state.native) {
			return undefined;
		}

		const native = state.native;
		let control: WritableControl | undefined;
		if (
			native.controlType === 'TemperatureControl' &&
			state.id === 'targetTemperature' &&
			typeof native.zoneId === 'number' &&
			typeof native.unit === 'string' &&
			typeof native.min === 'number' &&
			typeof native.max === 'number'
		) {
			const steps = Array.isArray(native.setTemperatureSteps)
				? native.setTemperatureSteps.filter(
						(step): step is number => typeof step === 'number' && Number.isFinite(step),
					)
				: undefined;
			control = {
				kind: 'temperature',
				deviceId,
				zoneId: native.zoneId,
				unit: native.unit,
				min: native.min,
				max: native.max,
				steps,
				stepsEnabled: native.setTemperatureStepsEnabled === true,
			};
		} else if (
			native.controlType === 'ToggleControl' &&
			typeof native.controlName === 'string' &&
			(typeof native.zoneId === 'number' || native.zoneId === undefined)
		) {
			control = {
				kind: 'toggle',
				deviceId,
				controlName: native.controlName,
				...(typeof native.zoneId === 'number' ? { zoneId: native.zoneId } : {}),
			};
		}

		if (!control) {
			this.log.warn(
				`Writable state ${redactDeviceId(relativeId, deviceId)} has incomplete HomeAPI metadata and will remain inactive`,
			);
			return undefined;
		}

		const fullId = `${this.namespace}.${relativeId}`;
		this.writableControls.set(fullId, control);
		if (!this.subscribedWritableStates.has(relativeId)) {
			this.subscribeStates(relativeId);
			this.subscribedWritableStates.add(relativeId);
		}
		return fullId;
	}

	private async disableDeviceWrites(deviceKey: string, keep = new Set<string>()): Promise<void> {
		const prefix = `${this.namespace}.devices.${deviceKey}.`;
		for (const [fullId] of this.writableControls) {
			if (!fullId.startsWith(prefix) || keep.has(fullId)) {
				continue;
			}

			this.writableControls.delete(fullId);
			const relativeId = fullId.slice(this.namespace.length + 1);
			this.unsubscribeStates(relativeId);
			this.subscribedWritableStates.delete(relativeId);
			await this.extendObject(relativeId, { common: { write: false } });
		}
	}

	private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
		if (!state || state.ack || this.unloading) {
			return;
		}

		const control = this.writableControls.get(id);
		if (!control) {
			return;
		}
		if (this.writesInProgress.has(id)) {
			this.log.warn(`Ignoring overlapping write to ${redactDeviceId(id, control.deviceId)}`);
			return;
		}

		const client = this.client;
		if (!client) {
			this.log.warn(
				`Cannot write ${redactDeviceId(id, control.deviceId)} because the HomeAPI client is not available`,
			);
			return;
		}

		this.writesInProgress.add(id);
		try {
			await processStateWrite(
				state,
				control,
				operation => this.sendControlWrite(client, operation),
				() => this.delay(CONTROL_READBACK_DELAY_MS),
				async () => {
					const deviceKey = this.knownDevices.get(control.deviceId);
					if (!deviceKey) {
						throw new LiebherrResponseError(
							'The written device is not part of the current discovery result',
						);
					}
					await this.syncDeviceControls(control.deviceId, deviceKey);
				},
			);
			await this.setConnection(true);
		} catch (error) {
			if (error instanceof ControlValidationError) {
				this.log.warn(`Rejected invalid write to ${redactDeviceId(id, control.deviceId)}: ${error.message}`);
			} else {
				await this.setConnection(false);
				this.logApiError(error, `writing ${redactDeviceId(id, control.deviceId)}`);
			}
		} finally {
			this.writesInProgress.delete(id);
		}
	}

	private async sendControlWrite(client: HomeApiClient, operation: ControlWrite): Promise<void> {
		if (operation.kind === 'temperature') {
			await client.setTemperature(operation.deviceId, operation.request);
		} else {
			await client.setToggle(operation.deviceId, operation.controlName, operation.request);
		}
	}

	private async updateState(
		id: string,
		name: string,
		role: string,
		type: ioBroker.CommonType,
		value: ioBroker.StateValue,
	): Promise<void> {
		await this.extendObject(id, {
			type: 'state',
			common: {
				name,
				type,
				role,
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setState(id, { val: value, ack: true });
	}

	private async setConnection(connected: boolean): Promise<void> {
		await this.setState('info.connection', { val: connected, ack: true });
	}

	private logApiError(error: unknown, operation: string): void {
		if (error instanceof LiebherrApiError) {
			switch (error.status) {
				case 401:
					this.log.error(`HomeAPI authentication failed while ${operation}; check the configured API key`);
					return;
				case 403:
					this.log.error(`HomeAPI access was forbidden while ${operation}`);
					return;
				case 404:
					this.log.warn(`HomeAPI resource was not found while ${operation}`);
					return;
				case 412:
					this.log.warn(`HomeAPI precondition failed while ${operation}`);
					return;
				case 422:
					this.log.warn(`HomeAPI rejected the request while ${operation}`);
					return;
				case 429: {
					const retry = error.retryAfterMs
						? `; retrying in at least ${Math.ceil(error.retryAfterMs / 1000)} seconds`
						: '';
					this.log.warn(`HomeAPI rate limit reached while ${operation}${retry}`);
					return;
				}
				case 500:
				case 503:
					this.log.warn(`HomeAPI is temporarily unavailable (HTTP ${error.status}) while ${operation}`);
					return;
				default:
					this.log.warn(`HomeAPI returned HTTP ${error.status ?? 'unknown'} while ${operation}`);
					return;
			}
		}

		if (error instanceof LiebherrNetworkError) {
			this.log.warn(`Network error while ${operation}`);
			return;
		}

		if (error instanceof LiebherrResponseError) {
			this.log.error(`Malformed HomeAPI response while ${operation}`);
			return;
		}

		this.log.error(`Unexpected error while ${operation}`);
	}

	private onUnload(callback: () => void): void {
		this.unloading = true;
		this.clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
		for (const deviceId of [...this.sseSessions.keys()]) {
			this.stopSseSession(deviceId);
		}
		this.writableControls.clear();
		this.subscribedWritableStates.clear();

		void this.setConnection(false)
			.catch(error =>
				this.log.debug(`Could not reset connection state during unload: ${(error as Error).message}`),
			)
			.finally(callback);
	}
}

if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Liebherr(options);
} else {
	new Liebherr();
}
