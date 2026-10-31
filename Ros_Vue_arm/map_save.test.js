import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { installMapSaving, runMapSaver } from './map_save.js';

async function fixture(t, run, algorithm = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-save-test-'));
  const app = express(); app.use(express.json());
  const calls = [];
  installMapSaving(app, { loadConfig: () => ({ save_map: { command: 'ros2', args: ['run', 'nav2_map_server', 'map_saver_cli', '-f'], save_dir: dir }, topics: { map: '/map' } }),
    setupCommand: ':', mappingAlgorithm: () => algorithm, runCommand: async argv => { calls.push(argv); return run(argv, calls.length); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function request(mapName = '测试地图') {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/save_map`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapName }) });
    const body = await res.json();
    await new Promise(resolve => setTimeout(resolve, 10));
    return { status: res.status, body };
  }
  return { request, dir, calls };
}
async function writeMap(argv) {
  const dest = argv[argv.indexOf('-f') + 1];
  await fs.writeFile(dest + '.pgm', 'P5\n1 1\n255\n\xff');
  await fs.writeFile(dest + '.yaml', `image: ${path.basename(dest)}.pgm\nresolution: 0.05\n`);
  return { code: 0, output: 'Map saved successfully' };
}
const missing = { code: 1, output: '[ERROR] Failed to spin map subscription' };

test('retained maps wait 10 seconds; complete files are published with a relative image path', async t => {
  const f = await fixture(t, writeMap);
  assert.equal((await f.request()).status, 200);
  assert(f.calls[0].includes('save_map_timeout:=10.0'));
  assert(f.calls[0].includes('map_subscribe_transient_local:=true'));
  assert.equal(await fs.readFile(path.join(f.dir, '测试地图.yaml'), 'utf8'), 'image: 测试地图.pgm\nresolution: 0.05\n');
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['测试地图.pgm', '测试地图.yaml']);
});
test('subscription timeout retries with volatile QoS and Gmapping starts with volatile QoS', async t => {
  const f = await fixture(t, (argv, n) => n === 1 ? missing : writeMap(argv));
  assert.equal((await f.request()).status, 200); assert.equal(f.calls.length, 2);
  assert(f.calls[1].includes('map_subscribe_transient_local:=false'));
  const g = await fixture(t, writeMap, 'gmapping');
  assert.equal((await g.request()).status, 200); assert.equal(g.calls.length, 1);
  assert(g.calls[0].includes('map_subscribe_transient_local:=false'));
});
test('no map returns a useful timeout and preserves an existing map', async t => {
  const f = await fixture(t, () => missing);
  await fs.writeFile(path.join(f.dir, 'old.pgm'), 'original');
  await fs.writeFile(path.join(f.dir, 'old.yaml'), 'original metadata');
  const r = await f.request('old'); assert.equal(r.status, 504); assert.match(r.body.error, /未收到地图/);
  assert.equal(await fs.readFile(path.join(f.dir, 'old.pgm'), 'utf8'), 'original');
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['old.pgm', 'old.yaml']);
});
test('file failures do not retry and zero exit without complete output is rejected', async t => {
  const f = await fixture(t, () => ({ code: 1, output: 'Failed to save the map: Permission denied' }));
  assert.equal((await f.request()).status, 500); assert.equal(f.calls.length, 1);
  const g = await fixture(t, () => ({ code: 0, output: '' }));
  assert.equal((await g.request()).status, 500); assert.deepEqual(await fs.readdir(g.dir), []);
});
test('invalid names and concurrent saves cannot start competing writers', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async argv => { started(); await new Promise(resolve => { release = resolve; }); return writeMap(argv); });
  assert.equal((await f.request({ invalid: true })).status, 400);
  assert.equal((await f.request(' ')).status, 400);
  const first = f.request(); await began;
  assert.equal((await f.request()).status, 409);
  release(); assert.equal((await first).status, 200); assert.equal(f.calls.length, 1);
});
test('saver command quotes literal arguments and terminates hung process groups', async () => {
  const literal = "quote ' and $(false) and space";
  const r = await runMapSaver(['printf', '%s', literal], { setupCommand: ':' });
  assert.equal(r.code, 0); assert.equal(r.output, literal);
  await assert.rejects(runMapSaver(['bash', '-c', 'sleep 10'], { setupCommand: ':', timeoutMs: 100 }), /超时/);
});
