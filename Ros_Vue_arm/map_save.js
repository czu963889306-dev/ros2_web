import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import disk from 'node:fs';
import { fileURLToPath } from 'node:url';

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function runMapSaver(argv, { setupCommand, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', `${setupCommand} && exec ${argv.map(quote).join(' ')}`],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', expired = false, killTimer;
    const collect = data => { output = (output + data.toString()).slice(-12000); };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);
    const kill = signal => {
      if (!proc.pid) return;
      try { process.kill(-proc.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') console.error('[save_map] terminate:', error.message);
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); };
    proc.once('error', error => { cleanup(); reject(error); });
    proc.once('close', (code, signal) => {
      cleanup();
      if (expired) reject(fail(504, '保存地图超时，请确认建图仍在运行且地图已经生成，再重试'));
      else resolve({ code, signal, output });
    });
  });
}

export function installMapSaving(app, {
  loadConfig, setupCommand, mappingAlgorithm = () => null, runCommand = runMapSaver,
  navigationMap = () => null, pointStore
}) {
  let saving = false;
  app.delete('/api/maps/:name', (req, res) => {
    try {
      if (req.get('X-Map-Delete') !== '1') throw fail(403, '请从地图列表确认删除');
      const origin = req.get('Origin');
      if (origin && new URL(origin).hostname !== req.hostname) throw fail(403, '请从本机中控台删除地图');
      const name = req.params.name;
      if (!name || name.startsWith('.') || /[\/\\\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 250)
        throw fail(400, '地图名称无效');
      const config = loadConfig();
      const dir = path.resolve(config.maps_dir || config.save_map?.save_dir || '/tmp');
      const base = path.join(dir, name);
      if (navigationMap() === base) throw fail(409, '这张地图正在导航中，请先关闭导航');
      if (saving) throw fail(409, '地图正在保存，请稍后再试');
      const yaml = base + '.yaml';
      if (!disk.lstatSync(yaml, { throwIfNoEntry: false })?.isFile()) throw fail(404, '地图不存在');
      const script = fileURLToPath(new URL('./map_image.py', import.meta.url));
      const image = spawnSync('/usr/bin/python3', [script, yaml], { encoding: 'utf8', timeout: 5000 });
      if (image.status !== 0) throw fail(500, '无法检查地图图像的引用关系');
      const files = [yaml];
      if (image.stdout && path.basename(image.stdout) === image.stdout) files.push(path.join(dir, image.stdout));
      const points = pointStore.read();
      const remaining = points.filter(p => p.mapPath !== base);
      const staging = disk.mkdtempSync(path.join(dir, '.map-delete-'));
      const moved = [];
      try {
        for (const file of files) {
          disk.renameSync(file, path.join(staging, path.basename(file)));
          moved.push(file);
        }
        if (remaining.length !== points.length) pointStore.write(remaining);
      } catch (error) {
        for (const file of moved.reverse()) disk.renameSync(path.join(staging, path.basename(file)), file);
        disk.rmdirSync(staging);
        throw error;
      }
      // At this point the map and its presets have been removed from the catalog.
      try { disk.rmSync(staging, { recursive: true }); }
      catch (error) { console.error('[delete_map] cleanup:', error.message); }
      res.json({ success: true, removedPoints: points.length - remaining.length });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, error: error.status ? error.message : '删除失败，请检查地图目录' });
    }
  });
  app.post('/api/save_map', async (req, res) => {
    const name = req.body?.mapName;
    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ success: false, error: '地图名称不能为空' });
    const safeName = name.trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    if (Buffer.byteLength(safeName) > 180)
      return res.status(400).json({ success: false, error: '地图名称过长' });
    if (saving) return res.status(409).json({ success: false, error: '正在保存地图，请等待当前保存完成' });
    saving = true;
    let staging;
    try {
      const config = loadConfig();
      const saver = config.save_map;
      if (!saver?.command || !Array.isArray(saver.args))
        throw fail(500, 'ros_config.json 中未正确配置 save_map 命令');
      const saveDir = path.resolve(saver.save_dir || '/tmp');
      await fs.mkdir(saveDir, { recursive: true });
      // Failed subscriptions or file writes must not damage an existing map.
      staging = await fs.mkdtemp(path.join(saveDir, '.map-save-'));
      const stagedPath = path.join(staging, safeName);
      const savePath = path.join(saveDir, safeName);
      // Gmapping publishes volatile maps. Other mappers normally retain the last map.
      // Keep retained-map support, with one volatile retry for unknown publishers.
      const policies = mappingAlgorithm() === 'gmapping' ? [false] : [true, false];
      let result;
      for (const transient of policies) {
        const argv = [saver.command, ...saver.args, stagedPath, '-t', config.topics?.map || '/map',
          '--fmt', 'pgm', '--ros-args', '-p', 'save_map_timeout:=10.0',
          '-p', `map_subscribe_transient_local:=${transient}`];
        console.log(`[save_map] 保存 ${savePath}，等待地图 10 秒，transient_local=${transient}`);
        result = await runCommand(argv, { setupCommand });
        if (result.code === 0) break;
        console.error('[save_map]', result.output);
        if (!transient || !/Failed to spin map subscription|incompatible QoS/i.test(result.output)) break;
        console.log('[save_map] 未收到保留地图，改用实时地图订阅重试一次');
      }
      if (result.code !== 0) {
        if (/Failed to spin map subscription|incompatible QoS/i.test(result.output))
          throw fail(504, '未收到地图，请保持建图运行，等地图显示后再保存；停止建图后页面显示的旧地图不能直接保存');
        throw fail(500, `地图保存工具执行失败（${result.code ?? result.signal ?? '未知原因'}），请检查地图目录是否可写及服务日志`);
      }
      for (const ext of ['pgm', 'yaml']) {
        const stat = await fs.stat(`${stagedPath}.${ext}`).catch(() => null);
        if (!stat?.isFile() || stat.size === 0) throw fail(500, '地图文件未完整生成，请重新保存');
      }
      await fs.rename(`${stagedPath}.pgm`, `${savePath}.pgm`);
      await fs.rename(`${stagedPath}.yaml`, `${savePath}.yaml`);
      console.log(`[save_map] 保存成功: ${savePath}`);
      res.json({ success: true, message: `地图已保存至 ${savePath}`, path: savePath });
    } catch (error) {
      console.error('[save_map]', error.message);
      res.status(error.status || 500).json({ success: false, error: error.message });
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(error => console.error('[save_map] cleanup:', error.message));
      saving = false;
    }
  });
}
