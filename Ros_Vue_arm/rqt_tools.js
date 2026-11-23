import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

const fail = (message, status = 400) => Object.assign(new Error(message), {status})
const leaseMs = 30000
const hidden = name => name === '/rosout' || name === '/parameter_events' || name.startsWith('/web/') || name.startsWith('/web_rqt_')
const quote = value => JSON.stringify(value)
function diagram(result, args) {
  const filter = String(args.filter || '').trim().toLowerCase()
  const match = s => s.toLowerCase().includes(filter)
  const nodes = new Map(), edges = new Set()
  const node = (key, label, kind) => {
    const cfg = kind === 'topic' ? 'shape=box, fillcolor="#e5f0ff", color="#789ac4"' :
      kind === 'frame' ? 'shape=box, fillcolor="#e7f5ed", color="#79a58d"' :
      'shape=ellipse, fillcolor="#f3eef9", color="#a28eba"'
    nodes.set(key, quote(key)+' [label='+quote(label)+', '+cfg+']')
  }
  const edge = (a,b) => edges.add(quote(a)+' -> '+quote(b))
  if (result.edges) {
    for (const t of result.edges) {
      if (!match(t.child) && !match(t.parent)) continue
      node(t.parent,t.parent,'frame');node(t.child,t.child,'frame');edge(t.parent,t.child)
    }
  } else {
    const pubs = new Map(), subs = new Map()
    for (const n of result.nodes) {
      if (args.hide && hidden(n.name)) continue
      if (match(n.name)) node('n'+n.name,n.name,'node')
      for (const [names,index] of [[n.pub,pubs],[n.sub,subs]]) for (const t of names) {
        if (args.hide && hidden(t)) continue
        if (!index.has(t)) index.set(t,[])
        index.get(t).push(n.name)
      }
    }
    for (const t of new Set([...pubs.keys(),...subs.keys()])) {
      const sources=pubs.get(t)||[], sinks=subs.get(t)||[]
      if (args.nodesOnly) {
        for (const p of sources) for (const s of sinks) {
          if (!match(t) && !match(p) && !match(s)) continue
          node('n'+p,p,'node');node('n'+s,s,'node');edge('n'+p,'n'+s)
        }
      } else {
        if (!match(t) && !sources.some(match) && !sinks.some(match)) continue
        node('t'+t,t,'topic')
        for (const p of sources) { node('n'+p,p,'node');edge('n'+p,'t'+t) }
        for (const s of sinks) { node('n'+s,s,'node');edge('t'+t,'n'+s) }
      }
    }
  }
  const direction = result.edges ? 'TB' : 'LR'
  return {count:nodes.size, dot:'digraph graph_view { graph [rankdir='+direction+', bgcolor="#fbfcfe", pad=".2", nodesep=".17", ranksep=".45"]; node [style="filled", fontname="DejaVu Sans", fontsize=11, margin=".11,.06"]; edge [color="#77869a", arrowsize=.62];\n'+
    [...nodes.values()].sort().join(';\n')+';\n'+[...edges].sort().join(';\n')+'\n}'}
}
async function renderGraph(session, result, args) {
  const { dot, count } = diagram(result,args)
  const key=createHash('sha256').update(dot).digest('hex')
  if (session.layout?.key !== key) {
    let svg=''
    if (count) svg = await new Promise((resolve,reject)=>{
      const proc=execFile('/usr/bin/dot',['-Tsvg'],{timeout:5000,maxBuffer:6*1024*1024},(err,out)=>
        err?reject(fail('关系图过大，请缩小筛选范围',422)):resolve(out))
      proc.stdin.on('error',()=>{});proc.stdin.end(dot)
    })
    session.layout={key,svg}
  }
  return {key,count,...(args.known===key?{}:{svg:session.layout.svg}),
    ...(result.edges?{edges:result.edges,now:result.now}:{nodeCount:result.nodes.length})}
}
export function installRqtTools(app, directory) {
  const sessions=new Map()
  function close(id) {
    const s=sessions.get(id)
    if (!s) return
    sessions.delete(id)
    s.proc.stdin.end()
    for (const job of s.pending.values()) { clearTimeout(job.timer);job.reject(fail('工具会话已关闭',410)) }
    s.pending.clear()
    const kill=setTimeout(()=>{ if(s.proc.exitCode===null && !s.proc.signalCode) s.proc.kill('SIGKILL') },1800)
    kill.unref()
  }
  function create() {
    if (sessions.size>=4) throw fail('工具会话已满，请先关闭闲置窗口',429)
    const id=randomUUID()
    const proc=spawn('/usr/bin/python3',['-u',path.join(directory,'rqt_worker.py')],{stdio:['pipe','pipe','pipe'],
      env:{...process.env,RCUTILS_LOGGING_USE_STDOUT:'0'}})
    const s={id,proc,seq:0,pending:new Map(),seen:Date.now(),layout:null}
    sessions.set(id,s)
    proc.stdin.on('error',()=>close(id))
    proc.stderr.on('data',data=>console.warn('[rqt]',String(data).slice(0,500).trim()))
    proc.on('error',()=>close(id));proc.on('exit',()=>close(id))
    createInterface({input:proc.stdout}).on('line',line=>{
      let msg
      try { msg=JSON.parse(line) } catch {return}
      const job=s.pending.get(msg.id)
      if (!job) return
      clearTimeout(job.timer);s.pending.delete(msg.id)
      msg.error?job.reject(fail(msg.error)):job.resolve(msg.data)
    })
    return id
  }
  const timer=setInterval(()=>{for(const [id,s] of sessions) if(Date.now()-s.seen>leaseMs)close(id)},2000)
  timer.unref()
  function rpc(s,args) {
    if(s.pending.size>=12) throw fail('操作过于频繁，请稍后重试',429)
    return new Promise((resolve,reject)=>{
      const id=++s.seq
      const timer=setTimeout(()=>{s.pending.delete(id);reject(fail('工具响应超时',504))},17000)
      s.pending.set(id,{resolve,reject,timer})
      s.proc.stdin.write(JSON.stringify({id,args})+'\n')
    })
  }
  app.use('/api/rqt', (req,res,next)=>{
    res.set('Cache-Control','no-store')
    if(req.method!=='POST'||!req.is('application/json')||req.get('X-RQT-Toolbox')!=='1')
      return res.status(403).json({error:'请通过中控台打开工具箱'})
    const origin=req.get('Origin')
    if(origin) {
      try { const u=new URL(origin);if(!['http:','https:'].includes(u.protocol)||u.hostname!==req.hostname||!['3000','5173'].includes(u.port))throw Error() }
      catch {return res.status(403).json({error:'请通过本机中控台访问'})}
    }
    next()
  })
  app.post('/api/rqt/sessions',(req,res)=>{try{res.status(201).json({id:create()})}catch(e){res.status(e.status||503).json({error:e.message})}})
  app.post('/api/rqt/sessions/:id',async(req,res)=>{
    const s=sessions.get(req.params.id)
    if(!s)return res.status(410).json({error:'工具会话已结束，请重新打开'})
    s.seen=Date.now()
    try {
      const args=req.body
      if(args.op==='close'){close(s.id);return res.json({})}
      const result=await rpc(s,args)
      res.json(['graph','tf'].includes(args.op)?await renderGraph(s,result,args):result)
    } catch(e){res.status(e.status||503).json({error:e.message||'工具暂时不可用'})}
  })
}
