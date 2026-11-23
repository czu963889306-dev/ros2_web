import {readFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'

const exec=promisify(execFile)
const models=new Set(['LEAP_ROS','LEAP_ROS_MAX','LEAP_ROS_PRO'])
let pending=null

export async function robotModelState(){
  const file=await readFile('/etc/default/chuyun-robot-model','utf8')
  const model=/^CHUYUN_ROBOT_MODEL=(\w+)$/m.exec(file)?.[1]
  const revision=/^CHUYUN_MODEL_REVISION=([0-9a-f]+)$/m.exec(file)?.[1]
  if(!models.has(model)||!revision)throw Error('机器人型号配置无效')
  return {model,revision,pending}
}

export function installRobotModel(app,directory){
  app.put('/api/robot-model',async(req,res)=>{
    const origin=req.get('Origin')
    if(origin){
      try{
        const url=new URL(origin)
        if(url.hostname!==req.hostname||!['3000','5173'].includes(url.port)||!['http:','https:'].includes(url.protocol))throw Error()
      }catch{return res.status(403).json({error:'请从本机中控台切换机器人型号'})}
    }
    if(!req.is('application/json')||req.get('X-Robot-Model')!=='1')return res.sendStatus(403)
    const {model,expected}=req.body||{}
    if(!models.has(model)||!models.has(expected))return res.status(400).json({error:'未知机器人型号'})
    if(pending)return res.status(409).json({error:'机器人型号正在切换'})
    pending=model
    try{
      if((await robotModelState()).model!==expected)return res.status(409).json({error:'型号已被其他页面更改，请刷新重试'})
      await exec('/usr/bin/python3',[path.join(directory,'robot_model_switch.py'),model,expected],{timeout:85000})
      res.json({...await robotModelState(),pending:null})
    }catch(e){res.status(503).json({error:e.stderr?.trim().split('\n').at(-1)||'切换失败，请核对模型发布状态'})}
    finally{pending=null}
  })
}
