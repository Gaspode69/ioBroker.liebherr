import { expect } from 'chai';
import sinon from 'sinon';
import {
	HomeApiClient,
	LiebherrApiError,
	LiebherrNetworkError,
	LiebherrResponseError,
	parseControls,
	parseDevices,
	type FetchLike,
} from './homeApiClient';

describe('HomeApiClient', () => {
	it('reads and parses the device list without exposing the key in the URL', async () => {
		const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
		fetch.resolves(
			new Response(
				JSON.stringify([
					{
						deviceId: '12.345.678.9',
						nickname: 'Kitchen',
						deviceType: 'COMBI',
						deviceName: 'CBNsda 572i-22',
						imageUrl: 'https://example.invalid/device.png',
					},
				]),
				{ status: 200 },
			),
		);
		const client = new HomeApiClient('test-api-key', { fetch });

		const devices = await client.getDevices();

		expect(devices).to.have.length(1);
		expect(devices[0].deviceId).to.equal('12.345.678.9');
		const [url, init] = fetch.firstCall.args;
		const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
		expect(requestUrl).to.equal('https://home-api.smartdevice.liebherr.com/v1/devices');
		expect(requestUrl).not.to.contain('test-api-key');
		expect(new Headers(init?.headers).get('api-key')).to.equal('test-api-key');
		expect(init?.method).to.equal('GET');
	});

	it('reads controls using an encoded device ID', async () => {
		const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
		fetch.resolves(
			new Response(JSON.stringify([{ type: 'ToggleControl', name: 'nightmode', value: false }]), {
				status: 200,
			}),
		);
		const client = new HomeApiClient('test-key', { fetch });

		const controls = await client.getControls('12.345/6');

		expect(controls).to.deep.equal([{ type: 'ToggleControl', name: 'nightmode', value: false }]);
		const url = fetch.firstCall.args[0];
		const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
		expect(requestUrl).to.match(/\/v1\/devices\/12\.345%2F6\/controls$/);
	});

	it('writes target temperatures with the documented request body', async () => {
		const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
		fetch.resolves(new Response(null, { status: 204 }));
		const client = new HomeApiClient('test-key', { fetch });

		await client.setTemperature('12/34', { zoneId: 1, target: -18, unit: '°C' });

		const [url, init] = fetch.firstCall.args;
		expect(requestUrl(url)).to.match(/\/v1\/devices\/12%2F34\/controls\/temperature$/);
		expect(init?.method).to.equal('POST');
		expect(new Headers(init?.headers).get('content-type')).to.equal('application/json');
		expect(requestBody(init?.body)).to.deep.equal({ zoneId: 1, target: -18, unit: '°C' });
	});

	it('writes device-wide and zone-associated toggles', async () => {
		const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
		fetch.resolves(new Response(null, { status: 204 }));
		const client = new HomeApiClient('test-key', { fetch });

		await client.setToggle('device', 'nightmode', { value: true });
		await client.setToggle('device', 'supercool', { zoneId: 0, value: false });

		expect(requestUrl(fetch.firstCall.args[0])).to.match(/\/controls\/nightmode$/);
		expect(requestBody(fetch.firstCall.args[1]?.body)).to.deep.equal({ value: true });
		expect(requestUrl(fetch.secondCall.args[0])).to.match(/\/controls\/supercool$/);
		expect(requestBody(fetch.secondCall.args[1]?.body)).to.deep.equal({ zoneId: 0, value: false });
	});

	for (const status of [401, 403, 404, 412, 422, 429, 500, 503]) {
		it(`returns a typed error for HTTP ${status}`, async () => {
			const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
			fetch.resolves(
				new Response('', {
					status,
					headers: status === 429 ? { 'retry-after': '120' } : undefined,
				}),
			);
			const client = new HomeApiClient('test-key', { fetch });

			let caught: unknown;
			try {
				await client.getDevices();
			} catch (error) {
				caught = error;
			}

			expect(caught).to.be.instanceOf(LiebherrApiError);
			expect((caught as LiebherrApiError).status).to.equal(status);
			if (status === 429) {
				expect((caught as LiebherrApiError).retryAfterMs).to.equal(120_000);
			}
		});
	}

	it('wraps network failures without including request details', async () => {
		const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
		fetch.rejects(new Error('request with sensitive headers failed'));
		const client = new HomeApiClient('test-key', { fetch });

		let caught: unknown;
		try {
			await client.getDevices();
		} catch (error) {
			caught = error;
		}

		expect(caught).to.be.instanceOf(LiebherrNetworkError);
		expect((caught as Error).message).not.to.contain('test-key');
	});

	it('rejects malformed and invalid JSON responses', async () => {
		expect(() => parseDevices({ devices: [] })).to.throw(LiebherrResponseError);
		expect(() => parseDevices([{ nickname: 'Missing ID' }])).to.throw(LiebherrResponseError);
		expect(() => parseControls([{ name: 'nightmode', value: false }])).to.throw(LiebherrResponseError);
		expect(() => parseControls([{ type: 'ToggleControl', name: '', value: false }])).to.throw(
			LiebherrResponseError,
		);

		const fetch = sinon.stub<Parameters<FetchLike>, ReturnType<FetchLike>>();
		fetch.resolves(new Response('{invalid', { status: 200 }));
		const client = new HomeApiClient('test-key', { fetch });
		let caught: unknown;
		try {
			await client.getDevices();
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(LiebherrResponseError);
	});
});

function requestUrl(input: string | URL | Request): string {
	return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function requestBody(body: RequestInit['body']): unknown {
	if (typeof body !== 'string') {
		throw new TypeError('Expected a JSON string request body');
	}
	return JSON.parse(body) as unknown;
}
