import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const valid = value => Number.isInteger(value) && value >= 0 && value <= 232;

export function installRosDomain(app, directory) {
  const route = '/api/ros-domain';
  app.get(route, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const [config, job] = await Promise.all([
        readFile('/etc/default/chuyun-ros-domain', 'utf8'),
        readFile('/run/chuyun-ros-domain/job.json', 'utf8').then(JSON.parse).catch(e => {
          if (e.code !== 'ENOENT') throw e;
          return null;
        })
      ]);
      if (job && ['queued','running'].includes(job.state) && Date.now() - job.updated_at > 20000 &&
          /^[a-f0-9]{32}$/.test(job.id)) {
        const active = await exec('systemctl', ['is-active','--quiet','chuyun-ros-domain-' + job.id + '.service'])
          .then(() => true, () => false);
        if (!active) Object.assign(job, { state:'failed', message:'上次切换已中断，请重新应用' });
      }
      const match = /^ROS_DOMAIN_ID=(\d+)\n?$/.exec(config);
      if (!match || !valid(Number(match[1]))) throw Error();
      res.json({ current: Number(process.env.ROS_DOMAIN_ID ?? 0), configured: Number(match[1]), job });
    } catch { res.status(503).json({ error: '无法读取 ROS 域号配置' }); }
  });
  app.put(route, async (req, res) => {
    const origin = req.get('Origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname !== req.hostname || !['3000','5173'].includes(url.port) ||
            !['http:','https:'].includes(url.protocol)) throw Error();
      } catch { return res.status(403).json({ error: '请从本机中控台设置域号' }); }
    }
    if (req.get('X-ROS-Domain') !== '1' || !req.is('application/json'))
      return res.status(403).json({ error: '请通过域号设置表单提交' });
    const { domain, expected } = req.body ?? {};
    if (!valid(domain) || !valid(expected))
      return res.status(400).json({ error: '域号须为 0 到 232 的整数' });
    try {
      const { stdout } = await exec('/usr/bin/python3', [path.join(directory, 'ros_domain.py'),
        'request', String(domain), String(expected)], { timeout: 18000 });
      const { code, ...body } = JSON.parse(stdout);
      res.status(code).json(body);
    } catch { res.status(503).json({ error: '无法提交切换，请刷新查看当前域号' }); }
  });
}
