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
} from './lib/homeApiClient';
import { calculateRetryDelay } from './lib/retry';

const DEFAULT_POLLING_INTERVAL_SECONDS = 60;
const MIN_POLLING_INTERVAL_SECONDS = 30;
const MAX_POLLING_INTERVAL_SECONDS = 86_400;

/** ioBroker adapter for read-only Liebherr SmartDevice HomeAPI integration. */
class Liebherr extends utils.Adapter {
	private client?: HomeApiClient;
	private pollTimer: ioBroker.Timeout | undefined;
	private pollingIntervalMs = DEFAULT_POLLING_INTERVAL_SECONDS * 1000;
	private consecutiveFailures = 0;
	private readonly knownDevices = new Map<string, string>();
	private unloading = false;

	/** @param options Adapter startup options supplied by js-controller. */
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'liebherr',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		await this.setConnection(false);
		this.pollingIntervalMs = this.getPollingIntervalMs(this.config.pollingInterval);

		const apiKey = this.config.apiKey?.trim();
		if (!apiKey) {
			this.log.warn('No Liebherr HomeAPI key is configured');
			return;
		}

		await this.extendObjectAsync('devices', {
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
			const deviceKey = this.knownDevices.get(missingDeviceId);
			if (deviceKey) {
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
				const controls = await client.getControls(device.deviceId);
				for (const control of controls) {
					const mapping = mapControl(control);
					if (!mapping) {
						this.log.debug(
							`Unsupported or malformed control type "${control.type}" (${control.name}) ignored`,
						);
						continue;
					}

					if (mapping.scope === 'zone' && mapping.zoneId !== undefined) {
						await this.updateZoneControl(deviceKey, mapping.zoneId, mapping.zonePosition, mapping.states);
					} else {
						await this.updateDeviceControl(deviceKey, mapping.states);
					}
				}
			} catch (error) {
				errors.push(error);
				await this.setState(`devices.${deviceKey}.info.available`, { val: false, ack: true });
				this.logApiError(error, `reading controls for device ${device.deviceId}`);
			}
		}

		return errors;
	}

	private async updateDevice(device: LiebherrDevice): Promise<string> {
		const deviceKey = this.knownDevices.get(device.deviceId) ?? toIdSegment(device.deviceId);
		this.knownDevices.set(device.deviceId, deviceKey);
		const deviceRoot = `devices.${deviceKey}`;

		await this.extendObjectAsync(deviceRoot, {
			type: 'device',
			common: { name: device.nickname ?? device.deviceName ?? device.deviceId },
			native: { deviceId: device.deviceId },
		});
		await this.extendObjectAsync(`${deviceRoot}.info`, {
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

	private async updateDeviceControl(deviceKey: string, states: MappedState[]): Promise<void> {
		const channelId = `devices.${deviceKey}.controls`;
		await this.extendObjectAsync(channelId, {
			type: 'channel',
			common: { name: 'Device controls' },
			native: {},
		});
		await this.updateMappedStates(channelId, states);
	}

	private async updateZoneControl(
		deviceKey: string,
		zoneId: number,
		zonePosition: string | undefined,
		states: MappedState[],
	): Promise<void> {
		const channelId = `devices.${deviceKey}.zone_${toIdSegment(String(zoneId))}`;
		await this.extendObjectAsync(channelId, {
			type: 'channel',
			common: { name: zonePosition ? `Zone ${zoneId} (${zonePosition})` : `Zone ${zoneId}` },
			native: { zoneId },
		});
		await this.updateState(`${channelId}.zoneId`, 'Zone ID', 'value', 'number', zoneId);
		if (zonePosition !== undefined) {
			await this.updateState(`${channelId}.position`, 'Zone position', 'text', 'string', zonePosition);
		}
		await this.updateMappedStates(channelId, states);
	}

	private async updateMappedStates(channelId: string, states: MappedState[]): Promise<void> {
		for (const state of states) {
			await this.extendObjectAsync(`${channelId}.${state.id}`, {
				type: 'state',
				common: state.common,
				native: {},
			});
			await this.setState(`${channelId}.${state.id}`, { val: state.value, ack: true });
		}
	}

	private async updateState(
		id: string,
		name: string,
		role: string,
		type: ioBroker.CommonType,
		value: ioBroker.StateValue,
	): Promise<void> {
		await this.extendObjectAsync(id, {
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
