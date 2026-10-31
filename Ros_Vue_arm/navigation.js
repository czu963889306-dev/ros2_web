import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const normalizeName = value => String(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

export class PointStore {
  constructor(file, mapsDirectory) { this.file = file; this.mapsDirectory = mapsDirectory; }
  read() {
    if (!fs.existsSync(this.file)) return [];
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.points)) throw new Error('导航点文件格式错误，请检查 navigation_points.json');
    return data.points;
  }
  validate(body) {
    if (typeof body.name !== 'string' || !normalizeName(body.name) || body.name.length > 40) throw new Error('点位名称需要 1–40 个字符');
    if (typeof body.mapPath !== 'string') throw new Error('请选择地图');
    const mapPath = path.resolve(body.mapPath);
    if (path.dirname(mapPath) !== path.resolve(this.mapsDirectory()) || !fs.existsSync(mapPath + '.yaml')) throw new Error('地图不存在或不在地图目录中');
    for (const k of ['x', 'y', 'yaw']) if (typeof body[k] !== 'number' || !Number.isFinite(body[k]) || Math.abs(body[k]) > (k === 'yaw' ? Math.PI : 100000)) throw new Error('坐标必须是有限数字，朝向范围为 -180° 至 180°');
    return { name: body.name.trim(), mapPath, frame_id: 'map', x: body.x, y: body.y, yaw: body.yaw };
  }
  write(points) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, points }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
  save(body, id) {
    const item = this.validate(body), points = this.read();
    if (id && !points.some(p => p.id === id)) throw new Error('点位不存在');
    if (points.some(p => p.id !== id && p.mapPath === item.mapPath && normalizeName(p.name) === normalizeName(item.name))) throw new Error('本地图已有同名点位');
    const result = { ...item, id: id || randomUUID() };
    this.write([...points.filter(p => p.id !== result.id), result]);
    return result;
  }
  remove(id) {
    const points = this.read();
    if (!points.some(p => p.id === id)) throw new Error('点位不存在');
    this.write(points.filter(p => p.id !== id));
  }
}

export class RosBridge {
  constructor(directory) { this.directory = directory; this.pending = new Map(); this.serial = 0; this.child = null; this.idleTimer = null; }
  start() {
    if (this.child) return;
    const child = spawn('bash', ['-c', 'source /opt/ros/humble/setup.bash && source /root/chuyun_ws/install/setup.bash && exec /root/chuyun_ws/install/chuyun_navigation2/lib/chuyun_navigation2/web_navigation_bridge'], { cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(value.id);
      value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
    });
    child.stderr.on('data', data => console.error('[navigation bridge]', data.toString().slice(0, 1500)));
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.idleTimer);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('ROS2 导航连接中断')); }
      this.pending.clear();
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  }
  call(method, params = {}) {
    clearTimeout(this.idleTimer);
    this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('ROS2 响应超时，请查询状态后再操作'));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    }).finally(() => {
      if (this.pending.size === 0 && this.child) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), 30000);
        this.idleTimer.unref();
      }
    });
  }
  close() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ROS2 导航连接已关闭'));
    }
    this.pending.clear();
    child?.kill('SIGTERM');
  }
}

export function installNavigation(app, { store, bridge, session, running }) {
  let revision = 0;
  const route = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(400).json({ success: false, error: error.message }); }
  };
  const activeMap = () => running() && !session().stopping ? session().mapPath : null;
  const context = () => ({ engine: session().engine || 'lite', sessionId: session().proc?.pid || 0 });
  app.get('/api/navigation/points', route(req => ({ success: true, activeMap: activeMap(), points: store.read().filter(p => !req.query.mapPath || p.mapPath === req.query.mapPath) })));
  app.post('/api/navigation/points', route(req => ({ success: true, point: store.save(req.body) })));
  app.put('/api/navigation/points/:id', route(req => ({ success: true, point: store.save(req.body, req.params.id) })));
  app.delete('/api/navigation/points/:id', route(req => { store.remove(req.params.id); return { success: true }; }));
  app.get('/api/navigation/state', route(async () => ({ success: true, ...(activeMap() ? await bridge.call('state', context()) : { connected: false, ready: false, status: 'OFFLINE', pose: null, distance_remaining: null }), mapPath: activeMap(), managed: !!activeMap(), revision })));
  app.post('/api/navigation/go-to', route(async req => {
    const map = activeMap();
    if (!map) throw new Error('请先在 ros2-web 选择地图、开始导航并设置初始位置');
    const points = store.read().filter(p => p.mapPath === map);
    const target = req.body.id ? points.find(p => p.id === req.body.id) : points.find(p => normalizeName(p.name) === normalizeName(req.body.name || ''));
    if (!target) throw new Error('当前地图没有该点位。可用点位：' + (points.map(p => p.name).join('、') || '尚未添加'));
    store.validate(target);
    const result = await bridge.call('go', { ...target, ...context() });
    revision++;
    return { success: true, ...result, point: target, message: `已下发前往“${target.name}”的目标，请查询导航状态确认进展；尚未确认到达` };
  }));
  app.post('/api/navigation/cancel', route(async () => {
    if (!activeMap()) throw new Error('导航未运行');
    const result = await bridge.call('cancel', context()); revision++;
    return { success: true, ...result, message: '已发送停止当前目标指令，保留导航和定位' };
  }));
}
