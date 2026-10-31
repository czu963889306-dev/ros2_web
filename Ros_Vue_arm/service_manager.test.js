import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import express from 'express';
import {ServiceManager,installServiceManager} from './service_manager.js';
const exec=promisify(execFile);
const units=['micro-ros-agent.service','leap_ros_bringup.service','chuyun_wifi_config.service','ros2-web-topic-throttle.service','ustreamer-camera.service','ros2-web.service','voice-assistant.service'];
async function fixture(t, fail=false){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ros-services-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const calls=[];
 const run=async(command,args)=>{calls.push({command,args});if(command==='/bin/bash')return units.join('\n')+'\n';if(command==='/usr/bin/systemctl')return units.map(u=>`Id=${u}\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nDescription=Test`).join('\n\n');if(command==='/usr/bin/journalctl')return '中文 <script>log</script>\n';if(command==='/usr/bin/systemd-run'){if(fail)throw new Error('dispatch failed');return ''}throw new Error(command)};
 return {manager:new ServiceManager('/app',{run,jobDir:dir}),run,dir,calls};
}
test('script exposes exactly seven managed services including voice; all action order is preserved',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'service-script-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'systemctl'),log=path.join(dir,'log');
 await fs.writeFile(file,'#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_SERVICE_LOG"\n',{mode:0o755});
 const env={...process.env,PATH:dir+':'+process.env.PATH,TEST_SERVICE_LOG:log};
 const script=await fs.access(path.resolve('ros_service_ctl.sh')).then(()=>path.resolve('ros_service_ctl.sh')).catch(()=>'/root/ros_service_ctl.sh');
 assert.deepEqual((await exec('/bin/bash',[script,'services'],{env})).stdout.trim().split('\n'),units);
 await assert.rejects(exec('/bin/bash',[script,'start','qwen'],{env}));
 await exec('/bin/bash',[script,'stop','all'],{env});
 assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),['daemon-reload',...units.toReversed().map(u=>'stop '+u)]);
});
test('only script units can be logged or controlled; bounded log count',async t=>{
 const {manager,calls}=await fixture(t);assert.equal((await manager.status()).services.length,7);
 for(const unit of ['qwen.service','ssh.service','all','voice-assistant;touch /tmp/x','--all']){await assert.rejects(manager.logs(unit),{status:403});await assert.rejects(manager.action(unit,'restart'),{status:403});}
 await assert.rejects(manager.action(units[0],'enable'),{status:400});await assert.rejects(manager.logs(units[0],'100000'),{status:400});
 assert.equal((await manager.logs(units[6],'100')).text,'中文 <script>log</script>\n');assert.ok(!calls.some(c=>c.command==='/usr/bin/systemd-run'));
});
test('actions run outside web control group, persist across manager restart and block overlapping actions',async t=>{
 const {manager,run,dir,calls}=await fixture(t);const job=await manager.action('ros2-web.service','restart');
 const command=calls.find(c=>c.command==='/usr/bin/systemd-run');assert.ok(command.args.includes('/usr/bin/python3'));assert.equal(command.args.at(-1),job.id);assert.ok(command.args.includes('/app/service_action.py'));
 assert.equal((await fs.stat(path.join(dir,job.id+'.json'))).mode&0o777,0o600);
 const reloaded=new ServiceManager('/app',{run,jobDir:dir});assert.equal((await reloaded.job(job.id)).state,'running');
 await assert.rejects(reloaded.action(units[6],'stop'),{status:409});
 await fs.writeFile(path.join(dir,job.id+'.json'),JSON.stringify({...job,state:'succeeded'}));
 assert.equal(await reloaded.activeJob(),null);await reloaded.action(units[6],'start');
});
test('failed dispatch removes pending marker; forged job path is rejected',async t=>{
 const {manager,dir}=await fixture(t,true);await assert.rejects(manager.action(units[0],'stop'));assert.equal((await fs.readdir(dir)).length,0);await assert.rejects(manager.job('../../etc/passwd'),{status:404});
});
test('HTTP requires trusted origin and marked JSON writes; rejects unmanaged units',async t=>{
 const {manager}=await fixture(t);const app=express();app.use(express.json());installServiceManager(app,'.',manager);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}/api/services`;
 assert.equal((await fetch(base,{headers:{Origin:'http://evil.test:5173'}})).status,403);assert.equal((await fetch(base+'/action',{method:'POST'})).status,403);
 const response=await fetch(base+'/action',{method:'POST',headers:{'Content-Type':'application/json','X-Service-Manager':'1'},body:JSON.stringify({unit:'qwen.service',action:'stop'})});assert.equal(response.status,403);
 assert.equal((await(await fetch(base)).json()).services.length,7);
});
