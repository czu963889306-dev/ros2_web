import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CdrReader } from './src/composables/useFoxglove.js';
import { readBatteryState, batteryView } from './src/composables/battery.js';

test('decode standard ROS2 rclpy BatteryState CDR including NaN, arrays and strings', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./tests/battery_state_cdr.json', import.meta.url)));
  const cdr = Buffer.from(fixture.base64, 'base64');
  const frame = new Uint8Array(13 + cdr.length); frame.set(cdr, 13);
  const value = readBatteryState(new CdrReader(frame.buffer, 17));
  assert.equal(value.header.stamp.sec, 42); assert.equal(value.header.frame_id, 'battery');
  assert.ok(Math.abs(value.voltage - 12.1684427) < 0.00001);
  assert.ok(Number.isNaN(value.current)); assert.ok(Number.isNaN(value.temperature));
  assert.equal(value.present, true); assert.equal(value.power_supply_status, 1);
  assert.equal(value.location, 'main'); assert.equal(value.serial_number, 'synthetic');
  assert.equal(value.cell_voltage.length, 3); assert.deepEqual(value.cell_temperature, [25, 26, 27]);
  const view = batteryView(value, 1000, 1001, true);
  assert.equal(view.percentage, 88); assert.equal(view.status, '充电中'); assert.equal(view.voltage.toFixed(2), '12.17');
});

test('battery values: unknown, absent, low, zero, invalid percentage, disconnected and stale', () => {
  const data = { present: true, percentage: .1, voltage: 11.1, power_supply_status: 2 };
  assert.equal(batteryView(data, 1000, 1001, true).low, true);
  assert.equal(batteryView({ ...data, percentage: 0 }, 1000, 1001, true).percentage, 0);
  for (const percentage of [NaN, null, -1, 88, Infinity]) {
    assert.equal(batteryView({ ...data, percentage }, 1000, 1001, true).percentage, null);
  }
  for (const view of [batteryView(data, 1000, 20000, true), batteryView(data, 1000, 1001, false), batteryView({ ...data, present: false }, 1000, 1001, true)]) {
    assert.equal(view.percentage, null); assert.equal(view.voltage, null);
  }
  assert.equal(batteryView(null, 0, 1001, true).label, '等待电池数据');
  assert.equal(batteryView(data, 1000, 20000, true).label, '电池数据已过期');
});
