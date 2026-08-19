import { toIdSegment } from './controlMapper';

/**
 * Produces a privacy-safe appliance identifier for diagnostic messages.
 *
 * @param deviceId HomeAPI appliance identifier (serial number).
 * @returns Masked identifier retaining at most four trailing alphanumeric characters.
 */
export function maskDeviceId(deviceId: string): string {
	const suffix = deviceId.replace(/[^A-Za-z0-9]/g, '').slice(-4);
	return suffix ? `****${suffix}` : '****';
}

/**
 * Removes a raw or ioBroker-ID-encoded appliance identifier from diagnostic text.
 *
 * @param text Diagnostic text which may contain an appliance identifier.
 * @param deviceId HomeAPI appliance identifier to redact.
 * @returns Text containing only the masked identifier.
 */
export function redactDeviceId(text: string, deviceId: string): string {
	const masked = maskDeviceId(deviceId);
	return text.split(deviceId).join(masked).split(toIdSegment(deviceId)).join(masked);
}
