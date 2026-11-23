<template>
  <Teleport to="body">
    <section id="rqt-window" ref="windowEl" role="dialog" aria-modal="false" aria-labelledby="rqt-title"
      tabindex="-1" class="rqt-window" :class="{folded}" :style="windowStyle"
      @focusin="emit('engage')" @pointerdown.capture="emit('engage')" @keydown.stop @keyup.stop @keydown.esc.prevent="emit('close')">
      <header class="rqt-head">
        <div class="rqt-grip" tabindex="0" role="group" aria-label="移动工具箱，使用方向键调整位置"
          title="拖动标题栏移动窗口，也可使用方向键" @keydown="arrowAdjust($event, 'move')"
          @pointerdown="beginGesture($event, 'move')" @pointermove="moveGesture"
          @pointerup="endGesture" @pointercancel="endGesture" @lostpointercapture="endGesture">
          <span class="rqt-handle" aria-hidden="true">⠿</span>
          <h2 id="rqt-title">ROS工具箱</h2>
          <span class="rqt-subtitle" v-if="folded">{{ publishing ? '周期发布中' : activeName }}</span>
          <span class="rqt-subtitle" v-else-if="catalog.domain != null">ROS_DOMAIN_ID <b>{{ catalog.domain }}</b></span>
        </div>
        <button class="rqt-fold" :aria-expanded="!folded" aria-controls="rqt-body"
          :title="folded?'展开工具箱':'收起窗口，当前工具继续运行'" @click="toggleFold">{{ folded?'展开':'收起' }}</button>
        <button @click="emit('close')" aria-label="关闭工具箱">关闭</button>
      </header>
      <div id="rqt-body" v-show="!folded" class="rqt-body">
        <nav aria-label="ROS 工具"><button v-for="t in tools" :key="t.id" :aria-pressed="mode===t.id" @click="select(t.id)" :disabled="!session"><strong>{{ t.name }}</strong><small>rqt_{{ t.id }}</small></button></nav>
        <section class="rqt-pane">
          <h3>{{ activeName }}</h3>
          <div v-if="error" role="alert" class="rqt-error">{{ error }} <button @click="reconnect" :disabled="connecting">重新连接</button></div>
          <p v-if="!ready && !error" role="status">正在连接 ROS…</p>
          <component v-if="ready" :is="panel" :key="epoch" :call="call" :catalog="catalog" :mode="mode" v-bind="mode==='plot' ? {folded} : {}" v-on="mode==='publisher' ? publisherEvents : {}" />
        </section>
      </div>
      <button v-if="!folded" class="rqt-resize" aria-label="调整工具箱大小" title="拖动或使用方向键调整窗口大小"
        @pointerdown="beginGesture($event, 'resize')" @pointermove="moveGesture" @pointerup="endGesture"
        @pointercancel="endGesture" @lostpointercapture="endGesture" @keydown="arrowAdjust($event, 'resize')"></button>
    </section>
  </Teleport>
</template>
<script setup>
import {computed, ref, onMounted, onBeforeUnmount} from 'vue'
import Graph from './RqtGraph.vue'
import Streams from './RqtStreams.vue'
import Commands from './RqtCommands.vue'
const emit=defineEmits(['close','engage'])
const tools=[{id:'graph',name:'节点关系图'},{id:'topic',name:'话题监视'},{id:'publisher',name:'消息发布'},{id:'service_caller',name:'服务调用'},{id:'plot',name:'实时曲线'},{id:'tf_tree',name:'TF 坐标树'}]
const mode=ref('graph'),session=ref(''),epoch=ref(0),catalog=ref({}),ready=ref(false),error=ref(''),connecting=ref(false)
const activeName=computed(()=>tools.find(t=>t.id===mode.value)?.name)
const folded=ref(false),publishing=ref(false),windowEl=ref()
const publisherEvents={publishing(value){publishing.value=value}}
const gap=8, barHeight=48

const clamp=(value,min,max)=>Math.max(min,Math.min(value,max))
function constrain(next) {
  const vw=document.documentElement.clientWidth,vh=window.innerHeight
  const maxW=Math.max(1,vw-2*gap),maxH=Math.max(1,vh-2*gap)
  const w=clamp(next.w,Math.min(380,maxW),maxW)
  const h=clamp(next.h,Math.min(265,maxH),maxH)
  const shownW=folded.value?Math.min(365,w):w,shownH=folded.value?barHeight:h
  return {x:clamp(next.x,gap,vw-gap-shownW),y:clamp(next.y,gap,vh-gap-shownH),w,h}
}
function initialBox() {
  const vw=document.documentElement.clientWidth,vh=window.innerHeight,small=vw<=680
  const w=small?vw-gap*2:Math.min(860,Math.max(470,vw*.5))
  const h=Math.min(660,vh * (small ? 0.55 : 0.72))
  return constrain({x:vw-w-gap,y:small?vh-h-gap:66,w,h})
}
const box=ref(initialBox())
const windowStyle=computed(()=>{
  const {x,y,w,h}=box.value
  return {left:x+'px',top:y+'px',width:(folded.value?Math.min(365,w):w)+'px',height:(folded.value?barHeight:h)+'px'}
})
function fitViewport(){box.value=constrain(box.value)}
function toggleFold(){folded.value=!folded.value;fitViewport()}
function reveal(){folded.value=false;fitViewport();windowEl.value?.focus({preventScroll:true})}
defineExpose({reveal})
let gesture=null
function beginGesture(event,action){
  if(event.button!==0||!event.isPrimary)return
  event.preventDefault()
  event.currentTarget.focus({preventScroll:true})
  event.currentTarget.setPointerCapture(event.pointerId)
  gesture={action,id:event.pointerId,startX:event.clientX,startY:event.clientY,box:{...box.value}}
}
function adjust(action,start,dx,dy){
  if(action==='move'){box.value=constrain({...start,x:start.x+dx,y:start.y+dy});return}
  const availableW=document.documentElement.clientWidth-gap-start.x,availableH=window.innerHeight-gap-start.y
  box.value=constrain({...start,w:Math.min(start.w+dx,availableW),h:Math.min(start.h+dy,availableH)})
}
function moveGesture(event){
  if(gesture?.id===event.pointerId)adjust(gesture.action,gesture.box,event.clientX-gesture.startX,event.clientY-gesture.startY)
}
function endGesture(event){if(gesture?.id===event.pointerId)gesture=null}
function arrowAdjust(event,action){
  const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key]
  if(!delta)return
  event.preventDefault()
  const step=event.shiftKey?40:12
  adjust(action,box.value,delta[0]*step,delta[1]*step)
}
const panel=computed(()=>['graph','tf_tree'].includes(mode.value)?Graph:['plot','topic'].includes(mode.value)?Streams:Commands)
const url=location.protocol+'//'+location.hostname+':3000/api/rqt/sessions'
const headers={'Content-Type':'application/json','X-RQT-Toolbox':'1'}
let alive=true,timer,opening=0
async function post(id,payload) {
  const r=await fetch(url+(id?'/'+id:''),{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)})
  const data=await r.json()
  if(!r.ok) {
    if(r.status===410 && id===session.value && alive){ready.value=false;publishing.value=false;session.value='';error.value=data.error;clearTimeout(timer)}
    throw Error(data.error||'连接工具箱失败')
  }
  return data
}
const call=computed(()=>{
  const id=session.value,e=epoch.value
  return (op,args={})=>post(id,{...args,epoch:e,op})
})
async function refresh(id,e) {
  if(!alive||session.value!==id||epoch.value!==e)return
  try{
    const data=await post(id,{op:'catalog',epoch:e})
    if(alive&&epoch.value===e&&session.value===id){catalog.value={...catalog.value,...data};error.value=''}
  }catch(ex){if(alive&&epoch.value===e)error.value=ex.message}
  if(alive&&epoch.value===e&&session.value===id)timer=setTimeout(()=>refresh(id,e),3500)
}
async function select(tool,force=false) {
  if(!session.value||(!force&&mode.value===tool&&ready.value))return
  clearTimeout(timer)
  ready.value=false;publishing.value=false;error.value='';mode.value=tool
  const e=++epoch.value,id=session.value
  try{
    const data=await post(id,{op:'mode',tool,epoch:e})
    if(!alive||e!==epoch.value||id!==session.value)return
    catalog.value=data;ready.value=true
    timer=setTimeout(()=>refresh(id,e),500)
  }catch(ex){if(alive&&e===epoch.value)error.value=ex.message}
}
function release(id) {
  if(id)fetch(url+'/'+id,{method:'POST',headers,body:JSON.stringify({op:'close'}),keepalive:true}).catch(()=>{})
}
async function reconnect(){
  const attempt=++opening
  connecting.value=true;clearTimeout(timer);ready.value=false;publishing.value=false;error.value=''
  const old=session.value;session.value='';release(old)
  try{
    const {id}=await post('',{})
    if(!alive||attempt!==opening){release(id);return}
    session.value=id;await select(mode.value,true)
  }catch(ex){if(alive&&attempt===opening)error.value=ex.message}
  finally{if(alive&&attempt===opening)connecting.value=false}
}
function pageHide(){release(session.value)}
onMounted(()=>{windowEl.value.focus({preventScroll:true});window.addEventListener('resize',fitViewport);window.addEventListener('pagehide',pageHide);reconnect()})
onBeforeUnmount(()=>{alive=false;clearTimeout(timer);window.removeEventListener('resize',fitViewport);window.removeEventListener('pagehide',pageHide);pageHide();session.value=''})
</script>
<style>
.rqt-window{box-sizing:border-box;position:fixed;z-index:40;display:flex;flex-direction:column;margin:0;padding:0;border:1px solid #9eafc3;border-radius:9px;color:#21354c;background:white;box-shadow:0 5px 24px #1d365132;font:15px/1.45 system-ui,sans-serif;overflow:hidden;container-type:inline-size}
.rqt-window *{box-sizing:border-box}.rqt-window:focus{outline:none}
.rqt-head{display:flex;align-items:center;flex:none;gap:6px;height:46px;padding:0 10px 0 4px;border-bottom:1px solid #d6dfe9;background:#edf2f7}.folded .rqt-head{border-bottom:0}
.rqt-grip{display:flex;align-items:center;align-self:stretch;flex:1;min-width:0;gap:8px;padding:0 5px;cursor:grab;user-select:none;touch-action:none;overflow:hidden}.rqt-grip:active{cursor:grabbing}.rqt-head h2{font-size:17px;margin:0;white-space:nowrap}.rqt-handle{font-size:18px;color:#73859b}.rqt-subtitle{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#4c6076}.rqt-head button{flex:none}
.rqt-body{flex:1;min-height:0;display:grid;grid-template-columns:166px minmax(0,1fr)}.rqt-body nav{background:#f3f6f9;border-right:1px solid #d6dfe9;padding:10px;overflow:auto}.rqt-body nav button{width:100%;text-align:left;display:block;margin-bottom:5px;background:transparent;border-color:transparent}.rqt-body nav strong,.rqt-body nav small{display:block}.rqt-body nav small{font:12px/1.6 monospace;color:#50657e}.rqt-body nav button[aria-pressed=true]{background:#dfecff;border-color:#9abce8;color:#134e96}
.rqt-pane{min-width:0;overflow:auto;padding:15px 19px}.rqt-pane h3{margin:0 0 13px;font-size:19px}.rqt-window :is(button,input,select,textarea){font:inherit;color:inherit}.rqt-window :is(button,input,select,textarea){border:1px solid #b6c5d5;border-radius:5px;background:#fff;padding:5px 8px;max-width:100%}.rqt-window button{cursor:pointer}.rqt-window button:disabled{opacity:.55;cursor:default}.rqt-window button.primary{background:#235da5;border-color:#235da5;color:white}.rqt-window :focus-visible{outline:2px solid #256ac5;outline-offset:1px}.rqt-row{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;margin:8px 0}.rqt-row label{display:inline-flex;align-items:center;gap:5px}.rqt-row input[type=checkbox]{margin:0}
.rqt-stack{display:grid;gap:5px;margin:10px 0}.rqt-window :is(pre,textarea,code,.rqt-mono){font-family:ui-monospace,Consolas,monospace;font-size:14px}.rqt-window textarea{width:100%;min-height:125px;resize:vertical;line-height:1.45}.rqt-window pre{background:#f5f7fa;border:1px solid #dae2ec;border-radius:5px;padding:9px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;margin:7px 0}.rqt-window .rqt-error{color:#9e2d24;background:#fff1ef;padding:7px 10px;border-radius:4px;margin:8px 0}.rqt-muted{color:#54687e;font-size:14px}.rqt-window table{border-collapse:collapse;width:100%;font-size:13px}.rqt-window :is(td,th){text-align:left;padding:5px 8px;border-bottom:1px solid #d9e2ed}.rqt-window th{background:#eef3f8}.rqt-scroll{overflow:auto}
@container(max-width:650px){.rqt-body{display:flex;flex-direction:column}.rqt-body nav{display:flex;flex-shrink:0;border-right:0;border-bottom:1px solid #d6dfe9;padding:5px;gap:4px}.rqt-body nav button{width:auto;white-space:nowrap;margin:0}.rqt-body nav small{display:none}.rqt-pane{padding:12px;flex:1}.rqt-body nav button{flex:none}.rqt-head{gap:4px}}
.rqt-window button.rqt-resize{position:absolute;bottom:0;right:0;width:19px;height:19px;border:0;padding:0;border-radius:0 0 8px 0;background:linear-gradient(135deg,transparent 48%,#7890a8 49% 55%,transparent 56% 67%,#7890a8 68% 74%,transparent 75%);cursor:nwse-resize;touch-action:none}
.rqt-pane{padding-bottom:23px}
</style>