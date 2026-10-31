import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { installNavigationEngines } from './navigation_engines.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-engines-'));
  const mapPath = path.join(dir, 'room'); fs.writeFileSync(mapPath + '.yaml', '');
  const config = { maps_dir: dir, navigation_engines: {}, default_navigation_engine: 'lite' };
  for (const engine of ['nav2', 'lite']) {
    const params_files = {};
    for (const drive of ['diff', 'omni']) {
      params_files[drive] = path.join(dir, engine + '_' + drive + '.yaml');
      fs.writeFileSync(params_files[drive], '');
    }
    config.navigation_engines[engine] = { id: 'navigation_' + engine, command: 'ros2', args: ['launch', engine], params_files };
  }
  const spawned = [], stopped = [], control = { mapping: false, failSpawn: false, failStop: false, stopping: null };
  const app = express(); app.use(express.json());
  const nav = installNavigationEngines(app, { loadConfig: () => config, mappingRunning: () => control.mapping,
    spawnTask(task) {
      const proc = new EventEmitter(); spawned.push({ task, proc });
      queueMicrotask(() => proc.emit(control.failSpawn ? 'error' : 'spawn', new Error('spawn failed')));
      return proc;
    }, async stopTask(id, proc) {
      stopped.push(id);
      if (control.failStop) throw new Error('stop failed');
      if (control.stopping) await control.stopping;
      proc.emit('exit', 0);
    }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, body === undefined ? {} :
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { mapPath, config, spawned, stopped, control, nav, request };
}

test('four engine/chassis combinations use exact corresponding parameters, status and stop aliases', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('navigation_engines')).body.engines.map(e => e.id), ['nav2', 'lite']);
  for (const engine of ['nav2', 'lite']) for (const driveType of ['diff', 'omni']) {
    const result = await f.request('start_navigation', { engine, driveType, mapPath: f.mapPath });
    assert.equal(result.status, 200); assert.equal(result.body.engine, engine);
    assert.deepEqual(f.spawned.at(-1).task.args, ['launch', engine, `map:=${f.mapPath}.yaml`, `params_file:=${f.config.navigation_engines[engine].params_files[driveType]}`]);
    assert.equal((await f.request('task_status/navigation')).body.driveType, driveType);
    assert.equal((await f.request('start_navigation', { engine, driveType, mapPath: f.mapPath })).status, 409);
    assert.equal((await f.request('stop_task/navigation', {})).body.isRunning, false);
    assert.equal(f.stopped.at(-1), 'navigation_' + engine);
  }
});

test('invalid requests cannot launch; mapping excludes navigation; legacy callers default to Lite', async t => {
  const f = await fixture(t), valid = { mapPath: f.mapPath, driveType: 'diff' };
  for (const engine of ['__proto__', '', {}, 'nav2;echo bad']) assert.equal((await f.request('start_navigation', { ...valid, engine })).status, 400);
  assert.equal((await f.request('start_navigation', { ...valid, driveType: '__proto__' })).status, 400);
  assert.equal((await f.request('start_navigation', { ...valid, mapPath: '/tmp/missing' })).status, 400);
  f.control.mapping = true;
  assert.equal((await f.request('start_navigation', valid)).status, 409); assert.equal(f.spawned.length, 0);
  f.control.mapping = false;
  assert.equal((await f.request('start_navigation', valid)).body.engine, 'lite');
});

test('spawn/exit failure is visible; stopping remains locked until all processes exit; stop retry', async t => {
  const f = await fixture(t), args = { engine: 'nav2', mapPath: f.mapPath, driveType: 'omni' };
  f.control.failSpawn = true; assert.equal((await f.request('start_navigation', args)).status, 500); assert.equal(f.nav.running(), false);
  f.control.failSpawn = false; await f.request('start_navigation', args);
  f.spawned.at(-1).proc.emit('exit', 1); assert.match((await f.request('navigation_status')).body.error, /已退出/);
  await f.request('start_navigation', args); f.control.failStop = true;
  assert.equal((await f.request('stop_navigation', {})).status, 500); assert.equal(f.nav.running(), true);
  f.control.failStop = false; let release;
  f.control.stopping = new Promise(r => { release = r; });
  const stop = f.request('stop_navigation', {});
  while (!f.nav.status().isTransitioning) await new Promise(r => setTimeout(r, 5));
  assert.equal((await f.request('start_navigation', args)).status, 409);
  assert.equal((await f.request('stop_navigation', {})).status, 409);
  release(); assert.equal((await stop).body.isRunning, false); assert.equal(f.nav.running(), false);
});
