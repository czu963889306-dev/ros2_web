import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WifiManager, parseNetworks, securityMode, validateInput, profileText, installWifi } from './wifi.js';
const old = '8476acd8-0437-4fcf-bcb4-fcc116ad76c5';
const scan = '*:Maturo:50\\:FE\\:39\\:71\\:A1\\:87:94:WPA2:5240 MHz\n :New:11\\:22\\:33\\:44\\:55\\:66:80:WPA2 WPA3:2412 MHz\n';
test('scan parses escaped names and deduplicates bands, preserving active AP', () => {
  const rows = parseNetworks(scan + ' :Maturo:11\\:22\\:33\\:44\\:55\\:77:99:WPA2:2412 MHz\n :中文\\:room\\\\wifi:11\\:22\\:33\\:44\\:55\\:88:40::2412 MHz');
  assert.equal(rows.length, 3); assert.equal(rows[0].signal, 94); assert.equal(rows[0].band, '5 GHz'); assert.equal(rows[2].ssid, '中文:room\\wifi'); assert.equal(rows[2].mode, 'open');
  assert.equal(securityMode('WPA3'), 'sae'); assert.equal(securityMode('WPA2 802.1X'), 'unsupported'); assert.equal(securityMode('WEP'), 'unsupported');
});
test('input validation and keyfile prevent field injection', () => {
  for (const body of [{ ssid: '' }, { ssid: 'x\n[connection]' }, { ssid: 'x', password: 'short' }, { ssid: 'x', bssid: '--help' }]) assert.throws(() => validateInput(body));
  assert.equal(validateInput({ ssid: '中文 : Wi-Fi', password: 'a b\\cdef' }).ssid, '中文 : Wi-Fi');
  const key = profileText({ uuid: old, iface: 'wlan0', ssid: '中文;foo', password: ' a\\b;cdef ', mode: 'wpa-psk' });
  assert.match(key, /ssid=\d+(;\d+)*;/); assert.match(key, /autoconnect=false/); assert.match(key, /psk=\\sa\\\\b;cdef\\s/);
});
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wifi-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = []; let active = old; const names = new Map([[old, 'Maturo']]);
  const manager = new WifiManager({ profileDir: dir, interfaces: () => ({ wlan0: [{ family: 'IPv4', address: active === old ? '192.168.31.250' : '192.168.5.2' }], eth0: [{ family: 'IPv4', address: '192.168.2.2' }] }), run: async args => {
    calls.push(args);
    if (args.includes('DEVICE,TYPE')) return 'wlan0:wifi\neth0:ethernet\n';
    if (args.includes('GENERAL.STATE,GENERAL.CON-UUID')) return active ? `100 (connected)\n${active}\n` : '30 (disconnected)\n--\n';
    if (args.includes('802-11-wireless.ssid')) return names.get(args.at(-1)) + '\n';
    if (args.includes('UUID,TYPE')) return `${old}:802-11-wireless\n`;
    if (args.includes('IN-USE,SSID,BSSID,SIGNAL,SECURITY,FREQ')) return scan;
    if (args[1] === 'load') {
      const body = await fs.readFile(args[2], 'utf8'); const uuid = body.match(/^uuid=(.*)$/m)[1]; names.set(uuid, 'New');
      assert.equal((await fs.stat(args[2])).mode & 0o777, 0o600); return '';
    }
    if (args.includes('up')) {
      const uuid = args[args.indexOf('uuid') + 1]; active = '';
      if (options.fail && uuid !== old || options.rollbackFail && uuid === old) throw new Error('password secret subprocess output');
      active = uuid; return '';
    }
    if (args[1] === 'delete' || args[1] === 'modify') return '';
    throw new Error('Unexpected command: ' + args.join(' '));
  }});
  return { manager, calls, dir };
}
async function completed(manager, job) {
  for (let i = 0; i < 100 && manager.jobs.get(job.id).state === 'connecting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const result = manager.jobs.get(job.id); assert.notEqual(result.state, 'connecting'); return result;
}
test('current network is idempotent and reports wireless IP separately', async t => {
  const { manager, calls } = await fixture(t); const job = await manager.connect({ ssid: 'Maturo' });
  assert.equal(job.state, 'succeeded'); assert.deepEqual(job.network.ipv4, ['192.168.31.250']); assert.deepEqual(job.network.ethernet_ipv4, ['192.168.2.2']); assert.ok(!calls.some(a => a.includes('up')));
});
test('new connection persists only after success; secret stays out of arguments and jobs', async t => {
  const { manager, calls, dir } = await fixture(t); const password = 'private-pass-123';
  const job = await manager.connect({ ssid: 'New', password }); assert.equal(job.state, 'connecting');
  await assert.rejects(manager.connect({ ssid: 'New', password }), { status: 409 }); await assert.rejects(manager.scan(), { status: 409 });
  const result = await completed(manager, job); assert.equal(result.state, 'succeeded'); assert.equal(result.network.ipv4[0], '192.168.5.2');
  assert.ok(calls.some(a => a.includes('connection.autoconnect'))); assert.equal((await fs.readdir(dir)).length, 1);
  assert.ok(!JSON.stringify(calls).includes(password)); assert.ok(!JSON.stringify(result).includes(password));
});
test('failed connection cleans new credentials and restores original network', async t => {
  const { manager, calls, dir } = await fixture(t, { fail: true });
  const result = await completed(manager, await manager.connect({ ssid: 'New', password: 'wrongpassword' }));
  assert.equal(result.state, 'failed'); assert.equal(result.restored, true); assert.equal((await fs.readdir(dir)).length, 0);
  assert.ok(calls.some(a => a.includes('up') && a.includes(old))); assert.ok(!calls.some(a => a.includes('delete') && a.includes(old)));
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('rollback failure is reported honestly', async t => {
  const { manager } = await fixture(t, { fail: true, rollbackFail: true });
  const result = await completed(manager, await manager.connect({ ssid: 'New', password: 'wrongpassword' })); assert.equal(result.restored, false);
});
test('HTTP rejects cross-origin and unmarked writes; accepts current network request', async t => {
  const { manager } = await fixture(t); const app = express(); app.use(express.json()); installWifi(app, manager);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}/api/wifi`;
  assert.equal((await fetch(base + '/scan', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/status', { headers: { Origin: 'http://evil.test:5173' } })).status, 403);
  const response = await fetch(base + '/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wifi-Settings': '1', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ ssid: 'Maturo' }) });
  assert.equal(response.status, 202); assert.equal((await response.json()).job.state, 'succeeded');
});
