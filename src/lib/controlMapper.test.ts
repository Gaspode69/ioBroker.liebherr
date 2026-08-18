import { expect } from 'chai';
import { mapControl, reconcileDeviceIds, toIdSegment } from './controlMapper';
import type { LiebherrControl } from './homeApiClient';

describe('control mapping', () => {
	it('maps a temperature capability and all reported metadata as read-only states', () => {
		const mapping = mapControl({
			type: 'TemperatureControl',
			name: 'temperature',
			zoneId: 1,
			zonePosition: 'bottom',
			value: -6,
			target: -18,
			min: -26,
			max: -15,
			unit: '°C',
			setTemperatureStepsEnabled: true,
			setTemperatureSteps: [-26, -24, -22, -20, -18, -16, -15],
		});

		expect(mapping?.scope).to.equal('zone');
		expect(mapping?.zoneId).to.equal(1);
		expect(mapping?.zonePosition).to.equal('bottom');
		expect(mapping?.states.find(state => state.id === 'temperature')?.value).to.equal(-6);
		const targetTemperature = mapping?.states.find(state => state.id === 'targetTemperature');
		expect(targetTemperature?.value).to.equal(-18);
		expect(targetTemperature?.common.min).to.equal(-26);
		expect(targetTemperature?.common.max).to.equal(-15);
		expect(mapping?.states.find(state => state.id === 'setTemperatureSteps')?.value).to.equal(
			'[-26,-24,-22,-20,-18,-16,-15]',
		);
		expect(mapping?.states.every(state => state.common.write === false)).to.equal(true);
	});

	it('keeps multiple temperature zones independent', () => {
		const zone0 = mapControl(temperatureControl(0, 'top', 22, 6, 3, 9));
		const zone1 = mapControl(temperatureControl(1, 'bottom', -6, -18, -26, -15));

		expect(zone0?.zoneId).to.equal(0);
		expect(zone1?.zoneId).to.equal(1);
		expect(zone0?.states.find(state => state.id === 'targetTemperature')?.value).to.equal(6);
		expect(zone1?.states.find(state => state.id === 'targetTemperature')?.value).to.equal(-18);
	});

	it('maps all toggles to device controls and preserves optional zone metadata', () => {
		const nightMode = mapControl({ type: 'ToggleControl', name: 'nightmode', value: false });
		const superCool = mapControl({
			type: 'ToggleControl',
			name: 'supercool',
			zoneId: 0,
			zonePosition: 'top',
			value: true,
		});

		expect(nightMode?.scope).to.equal('device');
		expect(nightMode?.states[0]).to.include({ id: 'nightmode', value: false });
		expect(superCool?.scope).to.equal('device');
		expect(superCool?.zoneId).to.equal(0);
		expect(superCool?.states[0]).to.include({ id: 'supercool', value: true });
		expect(superCool?.states[0].native).to.deep.equal({
			controlName: 'supercool',
			controlType: 'ToggleControl',
			zoneId: 0,
			zonePosition: 'top',
		});
		expect(nightMode?.states[0].native).to.deep.equal({
			controlName: 'nightmode',
			controlType: 'ToggleControl',
		});
		expect(superCool?.states[0].common.write).to.equal(false);
	});

	it('ignores unknown future and malformed known controls safely', () => {
		const futureControl = { type: 'FutureControl', name: 'future', value: 'new' } as LiebherrControl;
		const malformedTemperature = {
			type: 'TemperatureControl',
			name: 'temperature',
			zoneId: 0,
			value: 'not-a-number',
		} as unknown as LiebherrControl;

		expect(mapControl(futureControl)).to.equal(undefined);
		expect(mapControl(malformedTemperature)).to.equal(undefined);
	});

	it('creates stable object ID segments without interpreting serial-number dots as hierarchy', () => {
		expect(toIdSegment('12.345_6')).to.equal('12_2e_345_5f_6');
		expect(toIdSegment('nightmode')).to.equal('nightmode');
	});

	it('reconciles disappearing and reappearing devices without deleting them', () => {
		expect(reconcileDeviceIds(['A', 'B'], ['B', 'C'])).to.deep.equal({
			present: ['B', 'C'],
			missing: ['A'],
		});
		expect(reconcileDeviceIds(['A'], ['A'])).to.deep.equal({ present: ['A'], missing: [] });
	});
});

function temperatureControl(
	zoneId: number,
	zonePosition: string,
	value: number,
	target: number,
	min: number,
	max: number,
): LiebherrControl {
	return {
		type: 'TemperatureControl',
		name: 'temperature',
		zoneId,
		zonePosition,
		value,
		target,
		min,
		max,
		unit: '°C',
	};
}
