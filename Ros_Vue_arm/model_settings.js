import { spawn } from 'node:child_process';
import path from 'node:path';

function run(command, args, body, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', complete = false;
    const finish = (error, value) => {
      if (complete) return; complete = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { process.kill('SIGKILL'); finish(new Error('操作超时，请稍后检查服务状态')); }, timeout);
    process.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) process.kill(); });
    // Do not log subprocess output or request bodies: they may contain credentials.
    process.stderr.resume();
    process.on('error', () => finish(new Error('无法运行配置服务')));
    process.on('close', code => code === 0 ? finish(null, output) : finish(new Error('配置服务操作失败')));
    process.stdin.on('error', () => {});
    process.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const savesInProgress = new Set();

export function installModelSettings(app, directory, options = {}) {
  const folder = path.resolve(directory, '../voice_assistant');
  const route = options.route || '/api/model-settings';
  const header = options.header || 'X-Model-Settings';
  const label = options.label || '模型';
  const execute = options.execute || (async (mode, values) => JSON.parse(await run('/usr/bin/python3',
    [path.join(folder, options.script || 'model_settings.py'), mode, path.join(folder, 'config.yaml')], values)));
  const restart = options.restart || (async () => {
    await run('systemctl', ['restart', 'voice-assistant'], undefined, 20000);
    const state = await run('systemctl', ['is-active', 'voice-assistant']);
    if (state.trim() !== 'active') throw new Error('语音助手未成功启动');
  });
  const guard = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname !== req.hostname || !['3000', '5173'].includes(url.port) || !['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { return res.status(403).json({ success: false, error: '请从本机 ros2-web 页面配置' }); }
    }
    next();
  };
  app.get(route, guard, async (req, res) => {
    try { res.json(await execute('read')); }
    catch { res.status(500).json({ success: false, error: `无法读取${label}配置` }); }
  });
  app.put(route, guard, async (req, res) => {
    if (req.get(header) !== '1' || !req.is('application/json')) return res.status(403).json({ success: false, error: `请通过${label}配置表单保存` });
    if (savesInProgress.has(folder)) return res.status(409).json({ success: false, error: '正在保存配置，请稍候' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ success: false, error: '配置内容无效' });
    const { apply = true, ...values } = req.body;
    if (typeof apply !== 'boolean') return res.status(400).json({ success: false, error: '应用选项无效' });
    savesInProgress.add(folder);
    try {
      const result = await execute('save', values);
      if (!result.success) return res.status(400).json(result);
      if (!apply) return res.json({ ...result, saved: true, applied: false, message: '配置已保存，下次语音助手启动时生效' });
      try {
        await restart();
        res.json({ ...result, saved: true, applied: true, message: '配置已保存并应用，语音助手已重启' });
      } catch {
        res.json({ ...result, saved: true, applied: false, message: '配置已保存，但语音助手重启失败，请检查服务状态' });
      }
    } catch { res.status(500).json({ success: false, error: `保存失败，请检查${label}配置服务` }); }
    finally { savesInProgress.delete(folder); }
  });
}

export function installVoiceSettings(app, directory, options = {}) {
  return installModelSettings(app, directory, { ...options, route: '/api/voice-settings', header: 'X-Voice-Settings', script: 'voice_settings.py', label: '语音助手' });
}
