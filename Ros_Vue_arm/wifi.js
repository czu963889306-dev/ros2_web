import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const trimLine = text => text.replace(/\r?\n$/, '');
export function splitNmcli(line) {
  const fields = ['']; let escaped = false;
  for (const c of line) {
    if (escaped) { fields[fields.length - 1] += c; escaped = false; }
    else if (c === '\\') escaped = true;
    else if (c === ':') fields.push('');
    else fields[fields.length - 1] += c;
  }
  if (escaped) fields[fields.length - 1] += '\\';
  return fields;
}
export function securityMode(security) {
  if (!security || security === '--') return 'open';
  if (/802\.1X|EAP|WEP/i.test(security)) return 'unsupported';
  if (/WPA[12]?\b/.test(security)) return 'wpa-psk';
  if (/WPA3/.test(security)) return 'sae';
  if (/OWE/.test(security)) return 'owe';
  return 'unsupported';
}
export function parseNetworks(text) {
  const networks = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const [used, ssid, bssid, signal, security, frequency] = splitNmcli(line);
    if (!ssid || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(bssid || '')) continue;
    const mode = securityMode(security);
    const entry = { ssid, bssid, signal: Math.min(100, Math.max(0, Number(signal) || 0)), security: security || '开放网络', mode,
      supported: mode !== 'unsupported', connected: used.trim() === '*', band: Number.parseInt(frequency) >= 4900 ? '5 GHz' : '2.4 GHz' };
    const key = `${ssid}\0${mode}`, old = networks.get(key);
    if (!old || entry.connected || (!old.connected && entry.signal > old.signal)) networks.set(key, entry);
  }
  return [...networks.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal);
}
function keyString(value) {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
export function profileText({ uuid, iface, ssid, password, mode }) {
  // SSIDs use the documented byte-array keyfile format; passwords never enter argv.
  const ssidBytes = [...Buffer.from(ssid, 'utf8')].join(';') + ';';
  const security = mode === 'open' ? '' : `\n[wifi-security]\nkey-mgmt=${mode}\n${mode === 'owe' ? '' : `psk=${keyString(password)}\npsk-flags=0\n`}${mode === 'sae' || mode === 'owe' ? 'pmf=3\n' : ''}`;
  return `[connection]\nid=ros2-web-${uuid}\nuuid=${uuid}\ntype=wifi\ninterface-name=${iface}\nautoconnect=false\n\n[wifi]\nmode=infrastructure\nssid=${ssidBytes}\n${mode === 'open' ? '' : 'security=802-11-wireless-security\n'}${security}\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n`;
}
export function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault('连接参数无效');
  const { ssid, bssid = '', password = '' } = body;
  if (typeof ssid !== 'string' || Buffer.byteLength(ssid) < 1 || Buffer.byteLength(ssid) > 32 || /[\x00-\x1f\x7f]/.test(ssid)) throw fault('Wi-Fi 名称必须为 1～32 字节');
  if (typeof bssid !== 'string' || (bssid && !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(bssid))) throw fault('请重新扫描并选择 Wi-Fi');
  if (typeof password !== 'string' || /[\x00-\x1f\x7f]/.test(password) || (password && !((Buffer.byteLength(password) >= 8 && Buffer.byteLength(password) <= 63) || /^[\da-f]{64}$/i.test(password)))) throw fault('Wi-Fi 密码需为 8～63 字节，或 64 位十六进制密钥');
  return { ssid, bssid, password };
}
export class WifiManager {
  constructor(options = {}) {
    this.run = options.run || (async (args, timeout = 12000) => {
      try { return (await exec('/usr/bin/nmcli', args, { timeout, maxBuffer: 512 * 1024, env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } })).stdout; }
      catch { throw fault('网络操作失败，请检查 Wi-Fi 信号和密码', 503); }
    });
    this.profileDir = options.profileDir || '/etc/NetworkManager/system-connections';
    this.interfaces = options.interfaces || os.networkInterfaces;
    this.jobs = new Map(); this.busy = false; this.scanPromise = null;
    this.statusPromise = null; this.cachedStatus = null; this.cachedAt = 0;
  }
  async device() {
    const rows = (await this.run(['-t', '--escape', 'yes', '-f', 'DEVICE,TYPE', 'device', 'status'])).trim().split('\n').map(splitNmcli);
    const devices = rows.filter(row => row[1] === 'wifi').map(row => row[0]);
    const iface = devices.includes('wlan0') ? 'wlan0' : devices[0];
    if (!iface || !/^[a-zA-Z0-9_.:-]+$/.test(iface)) throw fault('未发现可用的 Wi-Fi 接口', 503);
    return iface;
  }
  async readStatus() {
    const iface = await this.device();
    const values = (await this.run(['-g', 'GENERAL.STATE,GENERAL.CON-UUID', 'device', 'show', iface])).trim().split('\n');
    const connected = Number.parseInt(values[0]) === 100;
    const uuid = /^[\da-f-]{36}$/i.test(values[1] || '') ? values[1] : '';
    const ssid = connected && uuid ? trimLine(await this.run(['--escape', 'no', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid])) : '';
    const interfaces = this.interfaces();
    const ipv4 = connected ? (interfaces[iface] || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address) : [];
    const ethernet_ipv4 = Object.entries(interfaces).filter(([name]) => /^(eth|en|lan)/.test(name)).flatMap(([, addresses]) => addresses.filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address));
    return { interface: iface, connected, ssid, uuid, ipv4, ethernet_ipv4, sampled_at: Date.now() };
  }
  async status() {
    if (this.cachedStatus && Date.now() - this.cachedAt < 1500) return this.cachedStatus;
    if (!this.statusPromise) this.statusPromise = this.readStatus().then(value => { this.cachedStatus = value; this.cachedAt = Date.now(); return value; }).finally(() => { this.statusPromise = null; });
    return this.statusPromise;
  }
  async savedProfiles() {
    const rows = (await this.run(['-t', '--escape', 'yes', '-f', 'UUID,TYPE', 'connection', 'show'])).trim().split('\n').map(splitNmcli);
    const profiles = [];
    for (const [uuid, type] of rows) {
      if (!['wifi', '802-11-wireless'].includes(type)) continue;
      try { profiles.push({ uuid, ssid: trimLine(await this.run(['--escape', 'no', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid])) }); } catch { /* Profile may have been removed. */ }
    }
    return profiles;
  }
  async list(rescan = true) {
    const iface = await this.device();
    const text = await this.run(['-t', '--escape', 'yes', '-f', 'IN-USE,SSID,BSSID,SIGNAL,SECURITY,FREQ', 'device', 'wifi', 'list', 'ifname', iface, '--rescan', rescan ? 'yes' : 'no'], 25000);
    const saved = await this.savedProfiles();
    return { interface: iface, networks: parseNetworks(text).map(network => ({ ...network, saved_uuid: saved.find(p => p.ssid === network.ssid)?.uuid || '', saved: saved.some(p => p.ssid === network.ssid) })) };
  }
  async scan() {
    if (this.busy) throw fault('正在连接 Wi-Fi，请稍候再扫描', 409);
    if (!this.scanPromise) this.scanPromise = this.list(true).finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }
  async connect(body) {
    const input = validateInput(body);
    if (this.busy || this.scanPromise) throw fault('正在处理网络操作，请稍候', 409);
    this.busy = true;
    try {
      const before = await this.readStatus();
      const available = await this.list(false);
      const network = available.networks.find(n => n.ssid === input.ssid && (!input.bssid || n.bssid.toLowerCase() === input.bssid.toLowerCase()));
      if (!network) throw fault('没有找到该 Wi-Fi，请重新扫描');
      if (!network.supported) throw fault('暂不支持 WEP 或企业认证网络，请选择个人 Wi-Fi');
      if (['wpa-psk', 'sae'].includes(network.mode) && !input.password && !network.saved_uuid) throw fault('请输入 Wi-Fi 密码');
      const job = { id: randomUUID(), ssid: input.ssid, state: 'connecting', message: '正在连接 Wi-Fi…', started_at: Date.now(), network: null };
      this.jobs.set(job.id, job);
      if (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value);
      if (before.connected && before.ssid === input.ssid && !input.password) {
        Object.assign(job, { state: 'succeeded', message: '当前已连接该 Wi-Fi', network: before }); this.busy = false;
      } else {
        // Return 202 before switching the interface used by this HTTP request.
        setTimeout(() => { this.perform(job, input, network, before).finally(() => { this.busy = false; this.cachedAt = 0; }); }, 150);
      }
      return { ...job };
    } catch (error) { this.busy = false; throw error; }
  }
  async perform(job, input, network, before) {
    const reuse = network.saved_uuid && !input.password;
    const uuid = reuse ? network.saved_uuid : randomUUID();
    const file = reuse ? null : path.join(this.profileDir, `ros2-web-${uuid}.nmconnection`);
    try {
      if (file) {
        await fs.mkdir(this.profileDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(file, profileText({ uuid, iface: before.interface, ...input, mode: network.mode }), { mode: 0o600, flag: 'wx' });
        await this.run(['connection', 'load', file]);
      }
      await this.run(['--wait', '40', 'connection', 'up', 'uuid', uuid, 'ifname', before.interface], 50000);
      const after = await this.readStatus();
      if (!after.connected || after.uuid !== uuid || !after.ipv4.length) throw new Error('No IPv4 lease');
      await this.run(['connection', 'modify', 'uuid', uuid, 'connection.autoconnect', 'yes', ...(file ? ['connection.autoconnect-priority', '10'] : [])]);
      Object.assign(job, { state: 'succeeded', message: 'Wi-Fi 已连接，配置已保存', network: after });
    } catch {
      let restored = false;
      if (file) {
        await this.run(['connection', 'delete', 'uuid', uuid]).catch(() => {});
        await fs.unlink(file).catch(() => {});
      }
      if (before.uuid && before.connected) {
        try {
          let current = await this.readStatus();
          if (!current.connected || current.uuid !== before.uuid) {
            await this.run(['--wait', '25', 'connection', 'up', 'uuid', before.uuid, 'ifname', before.interface], 32000);
            current = await this.readStatus();
          }
          restored = current.connected && current.uuid === before.uuid && current.ipv4.length > 0;
        } catch { /* Report rollback failure without exposing subprocess output. */ }
      }
      Object.assign(job, { state: 'failed', restored, message: restored ? '连接失败，已恢复原 Wi-Fi。请检查密码和信号后重试。' : '连接失败，请检查密码和信号。若页面断开，可通过有线网络重新访问。' });
    } finally { input.password = ''; job.finished_at = Date.now(); }
  }
}
export function installWifi(app, manager = new WifiManager()) {
  function guard(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname !== req.hostname || !['3000', '5173'].includes(url.port) || !['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { return res.status(403).json({ success: false, error: '请从本机 ros2-web 页面设置 Wi-Fi' }); }
    }
    if (req.method === 'POST' && (req.get('X-Wifi-Settings') !== '1' || !req.is('application/json'))) return res.status(403).json({ success: false, error: '请通过 Wi-Fi 设置表单操作' });
    next();
  }
  const handler = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.status || 503).json({ success: false, error: error.status ? error.message : 'Wi-Fi 服务暂不可用，请稍后重试' }); }
  };
  app.get('/api/wifi/status', guard, handler(async (req, res) => res.json({ success: true, ...await manager.status() })));
  app.post('/api/wifi/scan', guard, handler(async (req, res) => res.json({ success: true, ...await manager.scan() })));
  app.post('/api/wifi/connect', guard, handler(async (req, res) => res.status(202).json({ success: true, job: await manager.connect(req.body) })));
  app.get('/api/wifi/jobs/:id', guard, (req, res) => {
    const job = manager.jobs.get(req.params.id);
    res.status(job ? 200 : 404).json(job ? { success: true, job } : { success: false, error: '连接记录已过期，请查看当前 Wi-Fi 状态' });
  });
  return manager;
}
