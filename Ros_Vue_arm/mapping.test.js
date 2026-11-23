import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import { installMapping } from './mapping.js';

async function fixture(t) {
  const ids = ['cartographer', 'gmapping', 'slam_toolbox'];
  const config = { default_mapping_algorithm: 'slam_toolbox', mapping_algorithms: Object.fromEntries(ids.map(id =>
    [id, { id: 'map_' + id, command: 'ros2', args: ['launch', id, id + '.launch.py'] }])) };
  let serviceState = 'inactive';
  const service3d = { state: () => serviceState, start: async () => { serviceState = 'active'; },
    stop: async () => { serviceState = 'inactive'; } };
  config.mapping_algorithms.rtabmap_3d = { service: 'chuyun-mapping-3d.service' };
  const spawned = [], stopped = [];
  const control = { navigation: false, failSpawn: false, failStop: false, releaseStop: null };
  const app = express(); app.use(express.json());
  const mapper = installMapping(app, { loadConfig: () => config, service3d, navigationRunning: () => control.navigation,
    spawnTask(task) {
      const proc = new EventEmitter(); spawned.push({ task, proc });
      queueMicrotask(() => proc.emit(control.failSpawn ? 'error' : 'spawn', new Error('spawn failed')));
      return proc;
    }, async stopTask(id, proc) {
      stopped.push(id);
      if (control.failStop) throw new Error('stop failed');
      if (control.releaseStop) await control.releaseStop;
      proc.emit('exit', 0, null);
    }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (url, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, body === undefined ? {} :
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { request, config, spawned, stopped, control, mapper, service3d };
}

test('all three choices launch only their own command; aliases share status and stop the selected process', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('mapping_algorithms')).body.algorithms.map(a => a.id), ['cartographer', 'gmapping', 'slam_toolbox', 'rtabmap_3d']);
  for (const algorithm of ['cartographer', 'gmapping', 'slam_toolbox']) {
    const before = f.spawned.length;
    const started = await f.request('start_mapping', { algorithm });
    assert.equal(started.status, 200); assert.equal(started.body.algorithm, algorithm);
    assert.deepEqual(f.spawned.at(-1).task.args, ['launch', algorithm, algorithm + '.launch.py']);
    assert.equal((await f.request('run_task/mapping', { algorithm })).status, 200);
    assert.equal(f.spawned.length, before + 1);
    const other = algorithm === 'gmapping' ? 'cartographer' : 'gmapping';
    assert.equal((await f.request('start_mapping', { algorithm: other })).status, 409);
    assert.equal((await f.request('task_status/mapping')).body.algorithm, algorithm);
    assert.equal((await f.request('stop_task/mapping', {})).body.isRunning, false);
    assert.equal(f.stopped.at(-1), 'map_' + algorithm);
    assert.equal((await f.request('mapping_status')).body.isRunning, false);
  }
});

test('rejects arbitrary algorithms and unavailable config; navigation prevents mapping; default remains compatible', async t => {
  const f = await fixture(t);
  for (const algorithm of ['__proto__', 'gmapping; touch /tmp/bad', '', {}, []])
    assert.equal((await f.request('start_mapping', { algorithm })).status, 400);
  assert.equal(f.spawned.length, 0);
  f.control.navigation = true;
  assert.equal((await f.request('run_task/mapping', { algorithm: 'cartographer' })).status, 409);
  assert.equal(f.spawned.length, 0); f.control.navigation = false;
  delete f.config.mapping_algorithms.cartographer;
  assert.equal((await f.request('start_mapping', { algorithm: 'cartographer' })).status, 503);
  assert.equal((await f.request('start_mapping', {})).body.algorithm, 'slam_toolbox');
});

test('spawn errors and unexpected exits are reflected in status, and can be retried', async t => {
  const f = await fixture(t); f.control.failSpawn = true;
  assert.equal((await f.request('start_mapping', { algorithm: 'gmapping' })).status, 500);
  assert.equal(f.mapper.running(), false);
  assert.match((await f.request('mapping_status')).body.error, /启动失败/);
  f.control.failSpawn = false;
  assert.equal((await f.request('start_mapping', { algorithm: 'gmapping' })).status, 200);
  f.spawned.at(-1).proc.emit('exit', 1, null);
  const state = (await f.request('mapping_status')).body;
  assert.equal(state.isRunning, false); assert.match(state.error, /已退出/);
  assert.equal((await f.request('start_mapping', { algorithm: 'cartographer' })).status, 200);
  assert.equal((await f.request('mapping_status')).body.error, '');
});

test('stop completes before switching; stop failure keeps mapping locked and allows retry', async t => {
  const f = await fixture(t);
  await f.request('start_mapping', { algorithm: 'cartographer' });
  f.control.failStop = true;
  assert.equal((await f.request('stop_mapping', {})).status, 500);
  assert.equal(f.mapper.running(), true);
  assert.equal((await f.request('start_mapping', { algorithm: 'gmapping' })).status, 409);
  f.control.failStop = false;
  let release; f.control.releaseStop = new Promise(resolve => { release = resolve; });
  const stopping = f.request('stop_mapping', {});
  while (!f.mapper.status().isTransitioning) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.request('start_mapping', { algorithm: 'gmapping' })).status, 409);
  release(); assert.equal((await stopping).status, 200);
  assert.equal(f.mapper.running(), false);
  assert.equal((await f.request('start_mapping', { algorithm: 'gmapping' })).status, 200);
});

test('3D uses the installed mapping service and respects an externally started session', async t => {
  const f = await fixture(t);
  const start = () => f.request('start_mapping', { algorithm: 'rtabmap_3d' });
  f.control.navigation = true;
  assert.equal((await start()).status, 409);
  f.control.navigation = false;
  assert.equal((await start()).body.algorithm, 'rtabmap_3d');
  assert.equal((await start()).body.isRunning, true);
  assert.equal(f.spawned.length, 0);
  await f.service3d.stop();
  assert.equal((await f.request('mapping_status')).body.isRunning, false);
  await f.service3d.start();
  assert.equal(f.mapper.running(), true);
  assert.equal((await f.request('start_mapping', { algorithm: 'gmapping' })).status, 409);
  assert.equal((await f.request('stop_mapping', {})).body.isRunning, false);
});
