import fs from 'node:fs';
import path from 'node:path';

const ENGINES = [
  { id: 'nav2', label: 'Nav2', description: 'AMCL 定位、A* 全局规划与 DWB 局部规划' },
  { id: 'lite', label: 'Lite', description: '轻量激光定位、A* 规划与路径跟踪' }
];
const fail = (status, message) => Object.assign(new Error(message), { status });

export function installNavigationEngines(app, { loadConfig, spawnTask, stopTask, mappingRunning }) {
  let current = null, busy = false, error = '';
  const status = () => ({ isRunning: !!current, isTransitioning: busy, error,
    engine: current?.engine || null, label: current?.label || null,
    mapPath: current?.mapPath || null, driveType: current?.driveType || null });
  const controller = { status, running: () => busy || !!current, session: () => current || {} };
  app.get('/api/navigation_engines', (req, res) => {
    const config = loadConfig();
    res.json({ engines: ENGINES.map(e => ({ ...e, available: !!config.navigation_engines?.[e.id] })),
      defaultEngine: config.default_navigation_engine || 'lite' });
  });
  app.post('/api/start_navigation', async (req, res) => {
    try {
      const config = loadConfig();
      const { mapPath, driveType, engine = config.default_navigation_engine || 'lite' } = req.body || {};
      const choice = ENGINES.find(e => e.id === engine);
      if (!choice) throw fail(400, '请选择 Nav2 或 Lite 导航');
      if (!['diff', 'omni'].includes(driveType)) throw fail(400, '请选择差速轮或全向轮');
      if (typeof mapPath !== 'string' || !mapPath.trim()) throw fail(400, '请选择地图');
      if (busy || current) throw fail(409, '请先关闭当前导航，再切换导航方式或地图');
      if (mappingRunning()) throw fail(409, '请先停止建图，再开始导航');
      const mapsDir = path.resolve(config.maps_dir || config.save_map?.save_dir || '/tmp');
      const mapYaml = path.resolve(mapPath + '.yaml');
      if (path.dirname(mapYaml) !== mapsDir || !fs.existsSync(mapYaml)) throw fail(400, '地图路径无效或文件不存在');
      const task = config.navigation_engines?.[engine];
      const paramsFile = task?.params_files?.[driveType];
      if (!task?.id || !task.command || !Array.isArray(task.args) || !paramsFile || !fs.existsSync(paramsFile))
        throw fail(503, '该导航方式或底盘参数尚未配置');
      busy = true; error = '';
      try {
        const proc = spawnTask({ ...task, args: [...task.args, `map:=${mapYaml}`, `params_file:=${paramsFile}`] });
        if (!proc) throw fail(500, '导航进程未能启动');
        const session = { engine, label: choice.label, mapPath: mapYaml.slice(0, -5), driveType, paramsFile,
          id: task.id, proc, stopping: false };
        current = session;
        proc.once('exit', (code, signal) => {
          if (current !== session || session.stopping) return;
          error = `${choice.label} 已退出（${signal || code}），请查看导航日志`; current = null;
        });
        proc.once('error', err => {
          if (current !== session) return;
          error = `${choice.label} 启动失败：${err.message}`; current = null;
        });
        await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
      } finally { busy = false; }
      res.json({ success: true, ...status(), paramsFile, message: `${choice.label} 导航进程已启动，请设置初始位置` });
    } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
  });
  app.post(['/api/stop_navigation', '/api/stop_task/navigation'], async (req, res) => {
    if (busy) return res.status(409).json({ success: false, error: '导航正在启动或停止，请稍候' });
    if (!current) return res.json({ success: true, ...status() });
    const session = current; session.stopping = true; busy = true;
    try {
      await stopTask(session.id, session.proc);
      if (current === session) current = null;
      error = ''; res.json({ success: true, ...status(), isTransitioning: false });
    } catch (err) {
      session.stopping = false;
      res.status(500).json({ success: false, error: err.message });
    } finally { busy = false; }
  });
  app.get(['/api/navigation_status', '/api/task_status/navigation'], (req, res) => res.json(status()));
  return controller;
}
