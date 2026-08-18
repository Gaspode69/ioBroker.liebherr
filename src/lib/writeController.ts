import type { SetTemperatureRequest, SetToggleRequest } from './homeApiClient';

/** Toggle controls whose POST schema is defined for the first writable release. */
export const WRITABLE_TOGGLE_CONTROLS = new Set(['nightmode', 'partymode', 'supercool', 'superfrost']);

const ZONE_TOGGLE_CONTROLS = new Set(['supercool', 'superfrost']);

/**
 * Whether a reported toggle contains all metadata required by its documented POST schema.
 *
 * @param controlName HomeAPI capability name.
 * @param zoneId Optional zone identifier reported with the capability.
 */
export function isWritableToggleControl(controlName: string, zoneId: unknown): boolean {
	if (!WRITABLE_TOGGLE_CONTROLS.has(controlName)) {
		return false;
	}
	return !ZONE_TOGGLE_CONTROLS.has(controlName) || (typeof zoneId === 'number' && Number.isFinite(zoneId));
}

/** Metadata required to validate and route an ioBroker state write. */
export type WritableControl =
	| {
			kind: 'temperature';
			deviceId: string;
			zoneId: number;
			unit: string;
			min: number;
			max: number;
			steps?: number[];
			stepsEnabled: boolean;
	  }
	| {
			kind: 'toggle';
			deviceId: string;
			controlName: string;
			zoneId?: number;
	  };

/** Validated HomeAPI operation produced from a state change. */
export type ControlWrite =
	| { kind: 'temperature'; deviceId: string; request: SetTemperatureRequest }
	| {
			kind: 'toggle';
			deviceId: string;
			controlName: string;
			request: SetToggleRequest;
	  };

/** Error caused by an invalid ioBroker value rather than HomeAPI availability. */
export class ControlValidationError extends Error {
	/** @param message Safe validation failure description. */
	public constructor(message: string) {
		super(message);
		this.name = 'ControlValidationError';
	}
}

/**
 * Converts and validates a value before it is sent to the HomeAPI.
 *
 * @param control Discovered writable capability metadata.
 * @param value Value received through ioBroker.
 */
export function createControlWrite(control: WritableControl, value: ioBroker.StateValue): ControlWrite {
	if (control.kind === 'toggle') {
		if (typeof value !== 'boolean') {
			throw new ControlValidationError('Toggle values must be boolean');
		}

		const zoneScoped = ZONE_TOGGLE_CONTROLS.has(control.controlName);
		if (zoneScoped && control.zoneId === undefined) {
			throw new ControlValidationError(`${control.controlName} requires a zone ID`);
		}

		return {
			kind: 'toggle',
			deviceId: control.deviceId,
			controlName: control.controlName,
			request: {
				value,
				...(zoneScoped ? { zoneId: control.zoneId } : {}),
			},
		};
	}

	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new ControlValidationError('Target temperature must be a finite number');
	}
	if (value < control.min || value > control.max) {
		throw new ControlValidationError(
			`Target temperature must be between ${control.min} and ${control.max} ${control.unit}`,
		);
	}
	if (
		control.stepsEnabled &&
		control.steps?.length &&
		!control.steps.some(step => Math.abs(step - value) < Number.EPSILON)
	) {
		throw new ControlValidationError(`Target temperature ${value} is not an allowed value`);
	}

	return {
		kind: 'temperature',
		deviceId: control.deviceId,
		request: { zoneId: control.zoneId, target: value, unit: control.unit },
	};
}

/**
 * Validates and sends an unacknowledged ioBroker state change.
 * State acknowledgement is deliberately left to a subsequent HomeAPI readback.
 *
 * @param state ioBroker state-change event.
 * @param control Discovered writable capability metadata.
 * @param write Function which performs the HomeAPI request.
 * @param waitForReadback Function which delays the readback for eventual consistency.
 * @param readback Function which reads and publishes the resulting HomeAPI state.
 */
export async function processStateWrite(
	state: ioBroker.State | null | undefined,
	control: WritableControl,
	write: (operation: ControlWrite) => Promise<void>,
	waitForReadback: () => Promise<void>,
	readback: () => Promise<void>,
): Promise<boolean> {
	if (!state || state.ack) {
		return false;
	}

	const operation = createControlWrite(control, state.val);
	await write(operation);
	await waitForReadback();
	await readback();
	return true;
}
