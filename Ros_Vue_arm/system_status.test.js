import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCpu, cpuPercent, parseMemory, readCpuTemperature } from './system_status.js';

test('CPU measures delta across all cores and excludes double-counted guest time', () => {
  const before = parseCpu('cpu 100 10 20 300 5 4 3 0 40 20\ncpu0 10 0 0 20 0 0 0 0');
  const after = parseCpu('cpu 140 10 30 330 5 4 3 0 60 30');
  assert.deepEqual(before, { total: 442, idle: 305 });
  assert.equal(cpuPercent(before, after), 62.5);
  assert.equal(cpuPercent(null, after), null);
  assert.equal(cpuPercent(before, before), null);
  assert.equal(cpuPercent(after, before), null);
  assert.equal(parseCpu('cpu invalid'), null);
});

test('memory uses MemAvailable, falls back to reclaimable cache, and preserves unknown', () => {
  const value = parseMemory('MemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 600 kB\nCached: 300 kB\n');
  assert.deepEqual(value, { total_bytes: 1024000, used_bytes: 409600, percent: 40 });
  assert.equal(parseMemory('MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 50 kB\nCached: 300 kB\nSReclaimable: 50 kB\nShmem: 20 kB\n').percent, 42);
  assert.equal(parseMemory('MemTotal: 1000 kB\n'), null);
  assert.equal(parseMemory('invalid'), null);
});

test('CPU sensor selection prefers CPU over SoC, ignores GPU and invalid values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'system-resource-test-'));
  const zone = async (id, type, value) => {
    const folder = path.join(root, 'thermal_zone' + id);
    await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'type'), type); await fs.writeFile(path.join(folder, 'temp'), value);
  };
  try {
    await zone(0, 'gpu-thermal', '75000');
    await zone(1, 'soc-thermal', '62222');
    assert.equal(await readCpuTemperature(root), 62.2);
    await zone(2, 'cpu-thermal', '61000');
    assert.equal(await readCpuTemperature(root), 61);
    await fs.writeFile(path.join(root, 'thermal_zone2', 'temp'), 'not a number');
    assert.equal(await readCpuTemperature(root), 62.2);
    await fs.writeFile(path.join(root, 'thermal_zone1', 'temp'), '9999999');
    assert.equal(await readCpuTemperature(root), null);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
