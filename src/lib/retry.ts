import { LiebherrApiError, LiebherrNetworkError } from './homeApiClient';

const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;
const AUTH_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Calculates a bounded retry delay for HomeAPI and transport failures.
 *
 * @param baseDelayMs Configured polling interval.
 * @param consecutiveFailures Number of consecutive failed polling cycles.
 * @param error Error which caused the failed cycle.
 * @returns Delay before the next polling cycle.
 */
export function calculateRetryDelay(baseDelayMs: number, consecutiveFailures: number, error: unknown): number {
	if (error instanceof LiebherrApiError) {
		if (error.status === 429) {
			return Math.min(MAX_RETRY_DELAY_MS, Math.max(baseDelayMs, error.retryAfterMs ?? 0));
		}

		if (error.status === 401 || error.status === 403) {
			return Math.max(baseDelayMs, AUTH_RETRY_DELAY_MS);
		}

		if (error.status !== 500 && error.status !== 503) {
			return baseDelayMs;
		}
	}

	if (error instanceof LiebherrNetworkError || error instanceof LiebherrApiError) {
		const exponent = Math.min(Math.max(consecutiveFailures, 1), 5);
		return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** exponent);
	}

	return baseDelayMs;
}
