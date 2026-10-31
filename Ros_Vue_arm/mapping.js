const ALGORITHMS = Object.freeze([
  { id: 'cartographer', label: 'Cartographer', description: '使用激光与融合里程计建图，支持回环优化' },
  { id: 'gmapping', label: 'Gmapping', description: '使用激光与里程计进行粒子滤波建图' },
  { id: 'slam_toolbox', label: 'SLAM Toolbox', description: '异步二维激光建图，支持回环优化' }
]);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

export function installMapping(app, { loadConfig, spawnTask, stopTask, navigationRunning }) {
  let current = null;
  let busy = false;
  let lastError = '';
  const status = () => ({
    isRunning: current !== null,
    algorithm: current?.algorithm || null,
    label: current?.label || null,
    isTransitioning: busy,
    error: lastError
  });
  const controller = { status, running: () => busy || current !== null };

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
      if (!choice) throw fail(400, '请选择 Cartographer、Gmapping 或 SLAM Toolbox');
      if (busy) throw fail(409, '建图正在启动或停止，请稍候');
      if (current) {
        if (current.algorithm !== algorithm) throw fail(409, '请先停止当前建图，再选择其他算法');
        return res.json({ success: true, ...status() });
      }
      if (navigationRunning()) throw fail(409, '请先关闭导航，再开始建图');
      const task = config.mapping_algorithms?.[algorithm];
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
    if (!session) return res.json({ success: true, ...status() });
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

  app.get(['/api/mapping_status', '/api/task_status/mapping'], (req, res) => res.json(status()));
  return controller;
}
