import { expect } from 'chai';
import { LiebherrApiError, LiebherrNetworkError, LiebherrResponseError } from './homeApiClient';
import { calculateRetryDelay } from './retry';

describe('retry delay', () => {
	const baseDelay = 60_000;

	it('respects Retry-After for rate limiting', () => {
		expect(calculateRetryDelay(baseDelay, 1, new LiebherrApiError('rate limited', 429, 180_000))).to.equal(180_000);
	});

	it('backs off authentication failures for at least five minutes', () => {
		expect(calculateRetryDelay(baseDelay, 1, new LiebherrApiError('unauthorized', 401))).to.equal(300_000);
		expect(calculateRetryDelay(baseDelay, 1, new LiebherrApiError('forbidden', 403))).to.equal(300_000);
	});

	it('uses capped exponential backoff for network and temporary server failures', () => {
		expect(calculateRetryDelay(baseDelay, 1, new LiebherrNetworkError())).to.equal(120_000);
		expect(calculateRetryDelay(baseDelay, 2, new LiebherrApiError('unavailable', 503))).to.equal(240_000);
		expect(calculateRetryDelay(baseDelay, 10, new LiebherrApiError('server error', 500))).to.equal(900_000);
	});

	it('keeps the configured interval for non-transient and malformed responses', () => {
		expect(calculateRetryDelay(baseDelay, 2, new LiebherrApiError('not found', 404))).to.equal(baseDelay);
		expect(calculateRetryDelay(baseDelay, 2, new LiebherrApiError('precondition', 412))).to.equal(baseDelay);
		expect(calculateRetryDelay(baseDelay, 2, new LiebherrResponseError('malformed'))).to.equal(baseDelay);
	});
});
