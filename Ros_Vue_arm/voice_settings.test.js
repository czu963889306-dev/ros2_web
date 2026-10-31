import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {installModelSettings, installVoiceSettings} from './model_settings.js';
test('voice settings route isolates fields, validates origin/header and shares write lock with model settings', async()=>{
  const app=express(); app.use(express.json()); let release; let started; const ready=new Promise(r=>started=r); let restarts=0;
  installModelSettings(app,'.',{execute:async()=>({success:true,settings:{}})});
  installVoiceSettings(app,'.',{execute:async(mode, values)=>{
    if(mode==='read')return {success:true,settings:{VISION_SOURCE:'snapshot'}};
    if(values.VISION_SOURCE==='hold'){started();await new Promise(r=>release=r);}
    return {success:true,settings:values,groups:[]};
  },restart:async()=>restarts++});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/api/`;
  const send=(route,body,headers={})=>fetch(base+route,{method:'PUT',headers:{'Content-Type':'application/json','X-Voice-Settings':'1',...headers},body:JSON.stringify(body)});
  try{
    assert.equal((await(await fetch(base+'voice-settings')).json()).settings.VISION_SOURCE,'snapshot');
    assert.equal((await send('voice-settings',{}, {'X-Voice-Settings':''})).status,403);
    assert.equal((await send('voice-settings',{}, {Origin:'http://evil.test:5173'})).status,403);
    const waiting=send('voice-settings',{VISION_SOURCE:'hold',apply:false});await ready;
    assert.equal((await send('model-settings',{CHAT_MODEL:'qwen-plus'},{'X-Model-Settings':'1'})).status,409);
    release();assert.equal((await(await waiting).json()).applied,false);assert.equal(restarts,0);
    assert.equal((await(await send('voice-settings',{VISION_SOURCE:'snapshot',apply:true})).json()).applied,true);assert.equal(restarts,1);
  }finally{release?.();await new Promise(r=>server.close(r));}
});
