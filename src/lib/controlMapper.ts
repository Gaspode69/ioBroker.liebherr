import type { LiebherrControl, TemperatureControl, ToggleControl } from './homeApiClient';

/** Read-only ioBroker state produced from a HomeAPI capability. */
export interface MappedState {
	/** State ID relative to its device or zone channel. */
	id: string;
	/** ioBroker state metadata. */
	common: ioBroker.StateCommon;
	/** State value received from Liebherr. */
	value: ioBroker.StateValue;
	/** HomeAPI metadata required to identify the capability. */
	native?: Record<string, unknown>;
}

/** Capability mapping target and states. */
export interface ControlMapping {
	/** Whether states belong to the whole appliance or a zone. */
	scope: 'device' | 'zone';
	/** Zone identifier for zone-scoped capabilities. */
	zoneId?: number;
	/** Zone position reported by the appliance. */
	zonePosition?: string;
	/** Read-only states created for the capability. */
	states: MappedState[];
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isTemperatureControl(control: LiebherrControl): control is TemperatureControl {
	return (
		control.type === 'TemperatureControl' &&
		isFiniteNumber(control.zoneId) &&
		isFiniteNumber(control.value) &&
		isFiniteNumber(control.target) &&
		isFiniteNumber(control.min) &&
		isFiniteNumber(control.max) &&
		typeof control.unit === 'string'
	);
}

function isToggleControl(control: LiebherrControl): control is ToggleControl {
	return control.type === 'ToggleControl' && typeof control.value === 'boolean';
}

/**
 * Encodes arbitrary API identifiers into one collision-safe ioBroker ID segment.
 *
 * @param value Raw identifier or capability name.
 * @returns Encoded object ID segment.
 */
export function toIdSegment(value: string): string {
	return Array.from(value, character => {
		if (/^[A-Za-z0-9-]$/.test(character)) {
			return character;
		}
		return `_${character.codePointAt(0)?.toString(16)}_`;
	}).join('');
}

function temperatureState(id: string, name: string, value: number, unit: string): MappedState {
	return {
		id,
		common: {
			name,
			type: 'number',
			role: 'value.temperature',
			read: true,
			write: false,
			unit,
		},
		value,
	};
}

/**
 * Maps a supported capability to read-only ioBroker state definitions.
 *
 * @param control HomeAPI capability.
 * @returns Mapping for known valid types, otherwise undefined.
 */
export function mapControl(control: LiebherrControl): ControlMapping | undefined {
	if (isTemperatureControl(control)) {
		const targetTemperature = temperatureState(
			'targetTemperature',
			'Target temperature',
			control.target,
			control.unit,
		);
		targetTemperature.common.min = control.min;
		targetTemperature.common.max = control.max;
		const states: MappedState[] = [
			temperatureState('temperature', 'Current temperature', control.value, control.unit),
			targetTemperature,
			temperatureState('minTemperature', 'Minimum target temperature', control.min, control.unit),
			temperatureState('maxTemperature', 'Maximum target temperature', control.max, control.unit),
			{
				id: 'unit',
				common: {
					name: 'Temperature unit',
					type: 'string',
					role: 'text',
					read: true,
					write: false,
				},
				value: control.unit,
			},
		];

		if (typeof control.setTemperatureStepsEnabled === 'boolean') {
			states.push({
				id: 'setTemperatureStepsEnabled',
				common: {
					name: 'Temperature steps enabled',
					type: 'boolean',
					role: 'indicator',
					read: true,
					write: false,
				},
				value: control.setTemperatureStepsEnabled,
			});
		}

		if (Array.isArray(control.setTemperatureSteps) && control.setTemperatureSteps.every(isFiniteNumber)) {
			states.push({
				id: 'setTemperatureSteps',
				common: {
					name: 'Allowed temperature steps',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				value: JSON.stringify(control.setTemperatureSteps),
			});
		}

		return {
			scope: 'zone',
			zoneId: control.zoneId,
			zonePosition: control.zonePosition,
			states,
		};
	}

	if (isToggleControl(control)) {
		return {
			scope: 'device',
			zoneId: isFiniteNumber(control.zoneId) ? control.zoneId : undefined,
			zonePosition: control.zonePosition,
			states: [
				{
					id: toIdSegment(control.name),
					common: {
						name: control.name,
						type: 'boolean',
						role: 'indicator',
						read: true,
						write: false,
					},
					value: control.value,
					native: {
						controlName: control.name,
						controlType: control.type,
						...(isFiniteNumber(control.zoneId) ? { zoneId: control.zoneId } : {}),
						...(control.zonePosition !== undefined ? { zonePosition: control.zonePosition } : {}),
					},
				},
			],
		};
	}

	return undefined;
}

/** Difference between known and currently discovered appliances. */
export interface DeviceReconciliation {
	/** Currently returned appliance IDs. */
	present: string[];
	/** Previously known appliance IDs absent from the response. */
	missing: string[];
}

/**
 * Determines availability changes without deleting dynamically created objects.
 *
 * @param known Previously known appliance IDs.
 * @param current Currently discovered appliance IDs.
 * @returns Present and missing appliance IDs.
 */
export function reconcileDeviceIds(known: Iterable<string>, current: Iterable<string>): DeviceReconciliation {
	const currentSet = new Set(current);
	return {
		present: [...currentSet],
		missing: [...new Set(known)].filter(deviceId => !currentSet.has(deviceId)),
	};
}
