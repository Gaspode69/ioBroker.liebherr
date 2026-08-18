import { expect } from 'chai';
import sinon from 'sinon';
import { ControlValidationError, createControlWrite, processStateWrite, type WritableControl } from './writeController';

describe('writable controls', () => {
	const temperature: WritableControl = {
		kind: 'temperature',
		deviceId: 'serial',
		zoneId: 1,
		unit: '°C',
		min: -26,
		max: -15,
		steps: [-26, -24, -22, -20, -18, -16, -15],
		stepsEnabled: true,
	};

	it('creates documented temperature and toggle operations', () => {
		expect(createControlWrite(temperature, -18)).to.deep.equal({
			kind: 'temperature',
			deviceId: 'serial',
			request: { zoneId: 1, target: -18, unit: '°C' },
		});
		expect(
			createControlWrite({ kind: 'toggle', deviceId: 'serial', controlName: 'supercool', zoneId: 0 }, true),
		).to.deep.equal({
			kind: 'toggle',
			deviceId: 'serial',
			controlName: 'supercool',
			request: { zoneId: 0, value: true },
		});
		expect(
			createControlWrite({ kind: 'toggle', deviceId: 'serial', controlName: 'nightmode', zoneId: 99 }, true),
		).to.deep.equal({
			kind: 'toggle',
			deviceId: 'serial',
			controlName: 'nightmode',
			request: { value: true },
		});
	});

	it('rejects wrong types, out-of-range values, and disallowed steps', () => {
		expect(() => createControlWrite(temperature, 'cold')).to.throw(ControlValidationError);
		expect(() => createControlWrite(temperature, -30)).to.throw(ControlValidationError);
		expect(() => createControlWrite(temperature, -17)).to.throw(ControlValidationError);
		expect(() => createControlWrite({ kind: 'toggle', deviceId: 'serial', controlName: 'nightmode' }, 1)).to.throw(
			ControlValidationError,
		);
		expect(() =>
			createControlWrite({ kind: 'toggle', deviceId: 'serial', controlName: 'superfrost' }, true),
		).to.throw(ControlValidationError);
	});

	it('accepts any in-range temperature when discrete steps are disabled', () => {
		expect(createControlWrite({ ...temperature, stepsEnabled: false }, -17)).to.deep.include({
			request: { zoneId: 1, target: -17, unit: '°C' },
		});
	});

	it('ignores acknowledged updates and sends ack:false writes without acknowledging them', async () => {
		const write = sinon.stub().resolves();
		const waitForReadback = sinon.stub().resolves();
		const readback = sinon.stub().resolves();

		expect(
			await processStateWrite(
				{ val: true, ack: true } as ioBroker.State,
				toggle(),
				write,
				waitForReadback,
				readback,
			),
		).to.equal(false);
		expect(write.called).to.equal(false);
		expect(waitForReadback.called).to.equal(false);
		expect(readback.called).to.equal(false);

		expect(
			await processStateWrite(
				{ val: true, ack: false } as ioBroker.State,
				toggle(),
				write,
				waitForReadback,
				readback,
			),
		).to.equal(true);
		expect(write.calledOnce).to.equal(true);
		expect(waitForReadback.calledOnce).to.equal(true);
		expect(readback.calledOnce).to.equal(true);
		expect(write.calledBefore(waitForReadback)).to.equal(true);
		expect(waitForReadback.calledBefore(readback)).to.equal(true);
	});

	it('propagates a HomeAPI write failure for the adapter to handle', async () => {
		const write = sinon.stub().rejects(new Error('API unavailable'));
		const waitForReadback = sinon.stub().resolves();
		const readback = sinon.stub().resolves();

		let caught: unknown;
		try {
			await processStateWrite(
				{ val: false, ack: false } as ioBroker.State,
				toggle(),
				write,
				waitForReadback,
				readback,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).to.be.instanceOf(Error);
		expect(waitForReadback.called).to.equal(false);
		expect(readback.called).to.equal(false);
	});

	it('propagates a readback failure without treating the POST as confirmation', async () => {
		const write = sinon.stub().resolves();
		const waitForReadback = sinon.stub().resolves();
		const readback = sinon.stub().rejects(new Error('Readback unavailable'));

		let caught: unknown;
		try {
			await processStateWrite(
				{ val: true, ack: false } as ioBroker.State,
				toggle(),
				write,
				waitForReadback,
				readback,
			);
		} catch (error) {
			caught = error;
		}

		expect(write.calledOnce).to.equal(true);
		expect(waitForReadback.calledOnce).to.equal(true);
		expect(readback.calledOnce).to.equal(true);
		expect(caught).to.be.instanceOf(Error);
	});

	it('does not read back when the readback delay fails', async () => {
		const write = sinon.stub().resolves();
		const waitForReadback = sinon.stub().rejects(new Error('Adapter unloading'));
		const readback = sinon.stub().resolves();

		let caught: unknown;
		try {
			await processStateWrite(
				{ val: true, ack: false } as ioBroker.State,
				toggle(),
				write,
				waitForReadback,
				readback,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).to.be.instanceOf(Error);
		expect(readback.called).to.equal(false);
	});
});

function toggle(): WritableControl {
	return { kind: 'toggle', deviceId: 'serial', controlName: 'partymode' };
}
