import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { PointStore, installNavigation } from './navigation.js';

test('saved points persist, validate coordinates, map binding, names and CRUD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-test-'));
  try {
    const mapPath = path.join(dir, 'room'); fs.writeFileSync(mapPath + '.yaml', '');
    const store = new PointStore(path.join(dir, 'points.json'), () => dir);
    const body = { name: '厨房', mapPath, x: 1.25, y: -2, yaw: 0.5 };
    const p = store.save(body);
    assert.equal(new PointStore(store.file, () => dir).read()[0].id, p.id);
    assert.throws(() => store.save({ ...body, name: '厨，房。' }), /同名/);
    for (const bad of [null, '1', NaN, Infinity]) assert.throws(() => store.save({ ...body, x: bad }));
    assert.throws(() => store.save({ ...body, mapPath: path.join(dir, '..', 'wrong') }));
    assert.throws(() => store.save({ ...body, yaw: 4 }));
    assert.equal(store.save({ ...body, name: '书桌' }, p.id).id, p.id);
    store.remove(p.id); assert.deepEqual(store.read(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP prevents unknown/cross-map/unready navigation and dispatches exact saved goal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navigation-test-'));
  let server;
  try {
    const a = path.join(dir, 'room'), b = path.join(dir, 'other');
    for (const map of [a, b]) fs.writeFileSync(map + '.yaml', '');
    const store = new PointStore(path.join(dir, 'points.json'), () => dir);
    const point = store.save({ name: '厨房', mapPath: a, x: 1.25, y: -2, yaw: 0.5 });
    store.save({ name: '楼上', mapPath: b, x: 5, y: 6, yaw: 0 });
    let running = false, fail = false; const calls = [];
    const app = express(); app.use(express.json());
    installNavigation(app, { store, session: () => ({ mapPath: a }), running: () => running,
      bridge: { call: async (method, args) => { if (fail) throw new Error('定位尚未就绪'); calls.push({ method, args }); return { submitted: true }; } } });
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/navigation`;
    const post = name => fetch(base + '/go-to', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal((await post('厨房')).status, 400); assert.equal(calls.length, 0);
    running = true;
    assert.equal((await post('楼上')).status, 400); assert.equal((await post('随便')).status, 400); assert.equal(calls.length, 0);
    fail = true; assert.equal((await post('厨房')).status, 400); fail = false;
    const reply = await (await post('厨，房。')).json(); assert.equal(reply.success, true); assert.deepEqual(calls[0], { method: 'go', args: { ...point, engine: 'lite', sessionId: 0 } });
    assert.equal((await (await fetch(base + '/state')).json()).revision, 1);
    assert.equal((await (await fetch(base + '/cancel', { method: 'POST' })).json()).success, true);
    assert.equal(calls.at(-1).method, 'cancel');
  } finally { if (server) await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
