import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const unit = 'chuyun-mapping-3d.service';
const run = promisify(execFile);
function currentMap() {
  try { return readlinkSync('/root/maps_3d/work/current'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const native3d = {
  session: currentMap,
  async save(session, running) {
    const script = fileURLToPath(new URL('./save_map_3d.py', import.meta.url));
    try {
      const { stdout } = await run('/usr/bin/python3', [script, session, running ? 'running' : 'stopped'], {
        env: { ...process.env, FASTRTPS_DEFAULT_PROFILES_FILE: '/root/ros2_web/fastdds-local-filter.xml' }
      });
      return JSON.parse(stdout.trim().split('\n').at(-1));
    } catch (e) { throw fail(500, e.stderr?.trim().slice(-500) || '地图保存失败'); }
  },
  state: () => execFileSync('systemctl', ['show', unit, '-p', 'ActiveState', '--value'],
    { encoding: 'utf8', timeout: 1500 }).trim(),
  async start() {
    const before = currentMap();
    await run('systemctl', ['start', unit]);
    for (let i = 0; i < 100; i++) {
      if (currentMap() && currentMap() !== before) return;
      await delay(100);
    }
    throw fail(503, '新一轮地图还未就绪，请检查建图服务');
  },
  stop: () => run('systemctl', ['stop', unit])
};

const ALGORITHMS = Object.freeze([
  { id: 'cartographer', label: 'Cartographer', description: '使用激光与融合里程计建图，支持回环优化' },
  { id: 'gmapping', label: 'Gmapping', description: '使用激光与里程计进行粒子滤波建图' },
  { id: 'slam_toolbox', label: 'SLAM Toolbox', description: '异步二维激光建图，支持回环优化' },
  { id: 'rtabmap_3d', label: 'RTAB-Map 三维建图', description: '使用 Astra Pro 深度点云和底盘里程计生成三维地图' }
]);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function installMapping(app, { loadConfig, spawnTask, stopTask, navigationRunning, service3d = native3d }) {
  let current = null;
  let busy = false;
  let lastError = '';
  const choice3d = ALGORITHMS.find(a => a.id === 'rtabmap_3d');
  function status() {
    const state = !current && loadConfig().mapping_algorithms?.rtabmap_3d ? service3d.state() : 'inactive';
    const active = current || (['active', 'activating', 'deactivating'].includes(state) ? choice3d : null);
    return { isRunning: !!active, algorithm: current?.algorithm || active?.id || null, label: active?.label || null,
      mapSession: service3d.session?.() || null,
      isTransitioning: busy || state === 'activating' || state === 'deactivating',
      error: state === 'failed' ? '三维建图服务异常退出，请检查服务日志' : lastError };
  }
  const controller = { status, running: () => busy || status().isRunning };

  app.get('/api/mapping_algorithms', (req, res) => {
    const config = loadConfig();
    res.json({ algorithms: ALGORITHMS.map(a => ({ ...a, available: !!config.mapping_algorithms?.[a.id] })),
      defaultAlgorithm: config.default_mapping_algorithm || 'slam_toolbox' });
  });

  app.post(['/api/start_mapping', '/api/run_task/mapping'], async (req, res) => {
    try {
      const config = loadConfig();
      const algorithm = req.body?.algorithm ?? config.default_mapping_algorithm ?? 'slam_toolbox';
      const choice = ALGORITHMS.find(a => a.id === algorithm);
      if (!choice) throw fail(400, '请选择列表中的建图算法');
      if (busy) throw fail(409, '建图正在启动或停止，请稍候');
      const previous = status();
      if (previous.isTransitioning) throw fail(409, '建图正在启动或停止，请稍候');
      if (previous.isRunning) {
        if (previous.algorithm !== algorithm) throw fail(409, '请先停止当前建图，再选择其他算法');
        return res.json({ success: true, ...status() });
      }
      if (navigationRunning()) throw fail(409, '请先关闭导航，再开始建图');
      const task = config.mapping_algorithms?.[algorithm];
      if (algorithm === choice3d.id && task) {
        busy = true;
        lastError = '';
        try { await service3d.start(); } finally { busy = false; }
        if (!status().isRunning) throw fail(500, '三维建图服务未能启动');
        return res.json({ success: true, ...status() });
      }
      if (!task?.id || !task.command || !Array.isArray(task.args)) throw fail(503, '该建图算法尚未配置');
      busy = true;
      lastError = '';
      try {
        const proc = spawnTask(task);
        if (!proc) throw fail(500, '建图进程未能启动');
        const session = { algorithm, label: choice.label, id: task.id, proc, stopping: false };
        current = session;
        proc.once('exit', (code, signal) => {
          if (current !== session) return;
          if (!session.stopping) {
            lastError = `${choice.label} 已退出（${signal || code}），请查看建图日志`;
            current = null;
          }
        });
        proc.once('error', error => {
          if (current !== session) return;
          lastError = `${choice.label} 启动失败：${error.message}`;
          current = null;
        });
        await new Promise((resolve, reject) => {
          proc.once('spawn', resolve);
          proc.once('error', reject);
        });
      } finally { busy = false; }
      res.json({ success: true, ...status(), message: `${choice.label} 建图已启动` });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, error: error.message });
    }
  });

  app.post(['/api/stop_mapping', '/api/stop_task/mapping'], async (req, res) => {
    if (busy) return res.status(409).json({ success: false, error: '建图正在启动或停止，请稍候' });
    const session = current;
    if (!session) {
      try {
        if (req.query.scope !== 'console-processes' && status().isRunning) {
          busy = true;
          await service3d.stop();
          lastError = '';
        }
        busy = false;
        return res.json({ success: true, ...status() });
      } catch (error) {
        busy = false;
        return res.status(500).json({ success: false, error: error.message });
      }
    }
    busy = true;
    session.stopping = true;
    try {
      await stopTask(session.id, session.proc);
      if (current === session) current = null;
      lastError = '';
      res.json({ success: true, isRunning: false, algorithm: null, label: null });
    } catch (error) {
      session.stopping = false;
      res.status(500).json({ success: false, error: error.message });
    } finally { busy = false; }
  });

  app.post('/api/maps_3d/save', async (req, res) => {
    if (busy) return res.status(409).json({ error: '当前操作尚未结束，请稍候' });
    const state = status();
    if (state.isTransitioning || !state.mapSession || req.body?.session !== state.mapSession) {
      return res.status(409).json({ error: '建图轮次已更换或尚未就绪，请刷新状态' });
    }
    busy = true;
    try {
      const saved = await service3d.save(state.mapSession, state.algorithm === 'rtabmap_3d');
      res.json(saved);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    } finally { busy = false; }
  });
  app.get('/api/maps_3d/:id/:file', (req, res) => {
    const { id, file } = req.params;
    if (!/^\d{8}-\d{6}-[0-9a-f]{10}$/.test(id) || !['map.db', 'map.ply'].includes(file)) {
      return res.sendStatus(404);
    }
    res.download(`/root/maps_3d/saved/${id}/${file}`, id + file.slice(3));
  });

  app.get(['/api/mapping_status', '/api/task_status/mapping'], (req, res) => res.json(status()));
  return controller;
}
