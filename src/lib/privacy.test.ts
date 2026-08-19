import { expect } from 'chai';
import { maskDeviceId, redactDeviceId } from './privacy';

describe('privacy-safe diagnostics', () => {
	it('masks a serial number while retaining a useful suffix', () => {
		expect(maskDeviceId('56.925.608.5')).to.equal('****6085');
		expect(maskDeviceId('///')).to.equal('****');
	});

	it('redacts raw and ioBroker-ID-encoded device identifiers', () => {
		const serial = '56.925.608.5';
		const message = `device ${serial}, state liebherr.0.devices.56_2e_925_2e_608_2e_5.controls.supercool`;
		const redacted = redactDeviceId(message, serial);

		expect(redacted).to.equal('device ****6085, state liebherr.0.devices.****6085.controls.supercool');
		expect(redacted).not.to.contain(serial);
		expect(redacted).not.to.contain('56_2e_925_2e_608_2e_5');
	});
});
