import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const ID = /^[0-9a-f-]{36}$/;
const labels = { 'micro-ros-agent.service':'Micro-ROS 通信', 'leap_ros_bringup.service':'机器人底盘', 'chuyun_wifi_config.service':'Wi-Fi 配置服务', 'ros2-web-topic-throttle.service':'网页话题降频', 'ustreamer-camera.service':'摄像头推流', 'ros2-web.service':'ROS 网页中控台', 'voice-assistant.service':'语音助手' };
export class ServiceManager {
  constructor(directory, options = {}) {
    this.script = options.script || '/root/ros_service_ctl.sh';
    this.jobDir = options.jobDir || '/run/ros2-web-service-actions';
    this.helper = path.join(directory, 'service_action.py');
    this.run = options.run || (async (command, args, timeout = 12000) => {
      try { return (await exec(command, args, { timeout, maxBuffer: 2 * 1024 * 1024, env: {...process.env, LC_ALL:'C.UTF-8', LANG:'C.UTF-8'} })).stdout; }
      catch { throw fault('服务管理命令执行失败，请稍后重试', 503); }
    });
    this.dispatching = false;
  }
  async units() {
    const units = (await this.run('/bin/bash', [this.script, 'services'])).trim().split('\n');
    if (!units.length || units.length > 30 || units.some(s => !/^[a-zA-Z0-9_@.-]+\.service$/.test(s))) throw fault('服务脚本列表无效', 503);
    return [...new Set(units)];
  }
  async requireUnit(unit) {
    if (typeof unit !== 'string' || !(await this.units()).includes(unit)) throw fault('只允许操作 ros_service_ctl.sh 中列出的服务', 403);
    return unit;
  }
  async job(id) {
    if (!ID.test(id)) throw fault('操作记录无效', 404);
    let job;
    try { job = JSON.parse(await fs.readFile(path.join(this.jobDir, `${id}.json`), 'utf8')); }
    catch { throw fault('操作记录已过期，请刷新服务状态', 404); }
    if (job.state === 'running' && Date.now() - job.started_at > 130000) {
      job = {...job, state:'failed', message:'操作超时，请刷新服务状态并查看日志'};
    }
    return job;
  }
  async activeJob() {
    const files = await fs.readdir(this.jobDir).catch(() => []);
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      if (!ID.test(id)) continue;
      const job = await this.job(id).catch(() => null);
      if (job?.state === 'running') return job;
    }
    return null;
  }
  async status() {
    const units = await this.units();
    const output = await this.run('/usr/bin/systemctl', ['show', '--no-pager', '-p', 'Id,Description,LoadState,ActiveState,SubState,UnitFileState', ...units]);
    const values = output.trim().split(/\n\s*\n/).map(block => Object.fromEntries(block.split('\n').map(line => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; })));
    return { services:units.map(unit => {
      const value = values.find(row => row.Id === unit) || {};
      return { unit, label:labels[unit] || unit, description:value.Description || '', load:value.LoadState || 'unknown', active:value.ActiveState || 'unknown', sub:value.SubState || '', enabled:value.UnitFileState || '', self:unit === 'ros2-web.service' };
    }), active_job:await this.activeJob(), sampled_at:Date.now() };
  }
  async logs(unit, count = '200') {
    await this.requireUnit(unit);
    if (!['100','200','500'].includes(String(count))) throw fault('日志行数无效');
    const text = await this.run('/usr/bin/journalctl', ['--no-pager', '--output=short-iso', '--lines='+count, '--unit='+unit], 15000);
    return { unit, text, sampled_at:Date.now() };
  }
  async action(unit, action) {
    if (this.dispatching) throw fault('有服务操作正在执行，请稍候', 409);
    this.dispatching = true;
    try {
      await this.requireUnit(unit);
      if (!['start','stop','restart'].includes(action)) throw fault('只支持启动、停止和重启服务');
      if (await this.activeJob()) throw fault('有服务操作正在执行，请稍候', 409);
      await fs.mkdir(this.jobDir, {recursive:true, mode:0o700});
      const files = await fs.readdir(this.jobDir);
      const finished = [];
      for (const name of files.filter(n => ID.test(n.replace(/\.json$/, '')))) {
        const file=path.join(this.jobDir,name); const stat=await fs.stat(file); finished.push({file,time:stat.mtimeMs});
      }
      for (const old of finished.sort((a,b)=>b.time-a.time).slice(49)) await fs.unlink(old.file);
      const id = randomUUID();
      const job = {id, unit, action, state:'running', message:'正在执行服务操作…', started_at:Date.now()};
      const file = path.join(this.jobDir, `${id}.json`);
      await fs.writeFile(file, JSON.stringify(job), {mode:0o600, flag:'wx'});
      try {
        await this.run('/usr/bin/systemd-run', ['--quiet','--collect','--unit=ros2-web-action-'+id, '--property=Type=exec', '/usr/bin/python3', this.helper, id]);
      } catch (error) { await fs.unlink(file).catch(()=>{}); throw error; }
      return job;
    } finally { this.dispatching = false; }
  }
}
export function installServiceManager(app, directory, manager = new ServiceManager(directory)) {
  function guard(req,res,next) {
    res.set('Cache-Control','no-store');
    const origin=req.get('Origin');
    if (origin) {
      try { const url=new URL(origin); if(url.hostname !== req.hostname || !['3000','5173'].includes(url.port) || !['http:','https:'].includes(url.protocol)) throw new Error(); }
      catch {return res.status(403).json({success:false,error:'请从本机 ros2-web 页面操作服务'});}
    }
    if(req.method === 'POST' && (req.get('X-Service-Manager') !== '1' || !req.is('application/json'))) return res.status(403).json({success:false,error:'请通过服务管理窗口操作'});
    next();
  }
  const handle = fn => async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||503).json({success:false,error:e.status?e.message:'服务管理暂不可用，请稍后重试'});}};
  app.get('/api/services',guard,handle(async(req,res)=>res.json({success:true,...await manager.status()})));
  app.get('/api/services/logs',guard,handle(async(req,res)=>res.json({success:true,...await manager.logs(req.query.unit,req.query.lines)})));
  app.post('/api/services/action',guard,handle(async(req,res)=>res.status(202).json({success:true,job:await manager.action(req.body?.unit,req.body?.action)})));
  app.get('/api/services/jobs/:id',guard,handle(async(req,res)=>res.json({success:true,job:await manager.job(req.params.id)})));
}
