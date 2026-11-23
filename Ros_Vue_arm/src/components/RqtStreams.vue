<template>
  <div class="rqt-row">
    <label>话题 <select v-model="topic"><option value="">选择话题</option><option v-for="[n] in catalog.topics" :key="n" :value="n">{{ n }}</option></select></label>
    <select v-if="types.length>1" aria-label="消息类型" v-model="type"><option v-for="t in types" :key="t">{{ t }}</option></select><code v-else>{{ type }}</code>
  </div>
  <template v-if="plot">
    <div class="rqt-row"><label>数值字段 <input list="rqt-fields" placeholder="如 pose.pose.position.x" v-model.trim="field" @keydown.enter.prevent="add"></label>
      <datalist id="rqt-fields"><option v-for="f in suggestions" :key="f" :value="f"/></datalist>
      <button @click="add" :disabled="changing||!topic||!type||!field||series.length>=8">添加曲线</button>
      <label>时间窗口 <select v-model.number="span"><option v-for="s in [10,30,60]" :value="s" :key="s">{{ s }} s</option></select></label>
      <label>绘图帧率 <select v-model.number="fps"><option v-for="rate in frameRates" :key="rate" :value="rate">{{ rate }} FPS</option></select></label>
      <span v-if="series.length && !paused" class="rqt-muted">实绘 {{ measuredFps || '—' }} FPS</span>
      <button @click="togglePause" :disabled="!series.length">{{ paused?'继续绘图':'暂停绘图' }}</button></div>
    <div v-if="suggestions.length" class="rqt-muted">可选字段 <select aria-label="选择数值字段" :value="field" @change="field=$event.target.value"><option value="">选择或手动输入</option><option v-for="f in suggestions" :key="f">{{ f }}</option></select></div>
    <RqtPlotChart :rows="points" :colors="colors" :span="span" :fps="fps" :clock="clock"
      :paused="paused" :folded="folded" @rate="measuredFps=$event" />
    <p v-if="!series.length" class="rqt-muted">选择话题和数值字段后添加曲线，可同时查看 8 个字段。</p>
    <div v-for="(s,i) in series" :key="s.topic+s.field" class="rqt-row"><i class="rqt-swatch" :style="{background:colors[i]}"></i><code>{{ s.topic }} · {{ s.field }}</code>
      <span>{{ issues[i] || (points[i]?.length?format(points[i].at(-1)[1]):'等待数据') }}</span>
      <span class="rqt-muted" v-if="sampleRates[i]!=null">采样 {{ sampleRates[i].toFixed(1) }} Hz</span>
      <button :aria-label="'移除 '+s.topic+' '+s.field" :disabled="changing" @click="configure(series.filter((_,idx)=>idx!==i))">移除</button></div>
  </template>
  <template v-else>
    <div class="rqt-row" v-if="topic"><span>发布者 {{ sample.publishers??'—' }}</span><span>订阅者 {{ sample.subscribers??'—' }}</span><span>频率 {{ sample.hz?.toFixed(1)??'—' }} Hz</span><span>带宽 {{ sample.bps!=null?(sample.bps/1024).toFixed(1):'—' }} KiB/s</span><span>消息 {{ sample.count??0 }} 条</span><button @click="togglePause">{{ paused?'继续显示':'暂停显示' }}</button></div>
    <details v-if="schema"><summary>消息字段</summary><pre>{{ schema }}</pre></details>
    <pre v-if="sample.message" aria-label="最新话题消息">{{ sample.message }}</pre>
    <p v-else class="rqt-muted">{{ topic?'等待话题消息…':'选择话题后可查看消息、频率和带宽。' }}</p>
  </template>
  <p v-if="error" class="rqt-error" role="alert">{{ error }}</p>
</template>
<script setup>
import {computed,ref,shallowRef,watch,onBeforeUnmount} from 'vue'
import RqtPlotChart from './RqtPlotChart.vue'
const props=defineProps({mode:String,call:Function,catalog:Object,folded:Boolean})
const frameRates=[10,20,30,60]
const preference='rqt.plot.fps'
function savedRate(){
  try{
    const saved=Number(localStorage.getItem(preference))
    if(frameRates.includes(saved))return saved
  }catch{}
  return 30
}
const fps=ref(savedRate()),measuredFps=ref(0)
watch(fps,value=>{try{localStorage.setItem(preference,String(value))}catch{}})
const clock=shallowRef({server:0,local:0})
const plot=props.mode==='plot',topic=ref(''),type=ref(''),field=ref(''),suggestions=ref([]),schema=ref(''),error=ref(''),sample=shallowRef({})
const series=shallowRef([]),points=shallowRef([]),issues=ref([]),span=ref(30),paused=ref(false),changing=ref(false)
const colors=['#225eb3','#c65022','#168355','#823caa','#af315d','#8b6917','#007d94','#424b60']
const types=computed(()=>props.catalog.topics?.find(([n])=>n===topic.value)?.[1]||[])
let alive=true,timer,selection=0,version=0,since=0
watch([topic,()=>types.value.join(',')],()=>{if(!types.value.includes(type.value))type.value=types.value[0]||''},{flush:'sync'})
function numericFields(obj,prefix='',out=[]){
  if(typeof obj==='number')out.push(prefix)
  else if(Array.isArray(obj)&&obj.length)numericFields(obj[0],prefix+'[0]',out)
  else if(obj&&typeof obj==='object')for(const [k,v] of Object.entries(obj))numericFields(v,prefix?prefix+'.'+k:k,out)
  return out
}
watch([topic,type],async()=>{
  const id=++selection,t=type.value,n=topic.value;schema.value='';suggestions.value=[];field.value='';error.value=''
  if(!plot){version++;clearTimeout(timer);sample.value={}}
  try{
    if(!t||!n){if(!plot)await props.call('unwatch');return}
    if(!plot){await props.call('watch',{topic:n,type:t});if(alive&&id===selection)poll(version)}
    const d=await props.call('schema',{type:t})
    if(!alive||id!==selection)return
    schema.value=Object.entries(d.fields).map(([k,v])=>k+'   '+v).join('\n')
    const options=numericFields(JSON.parse(d.template))
    for(const [k,v] of Object.entries(d.fields))if(/(?:sequence<|float|double|int).*(?:\]|>)/.test(v)&&!options.includes(k+'[0]')&&/(?:float|double|int\d+)/.test(v))options.push(k+'[0]')
    suggestions.value=options
    if(options.length)field.value=options.includes('data')?'data':options[0]
  }catch(ex){if(alive&&id===selection)error.value=ex.message}
})
async function configure(next){
  if(changing.value)return
  changing.value=true;error.value='';const v=++version;clearTimeout(timer)
  try{
    await props.call('curves',{items:next})
    if(!alive)return
    series.value=next;points.value=next.map(()=>[]);issues.value=[];since=0;paused.value=false
    clock.value={server:0,local:0};measuredFps.value=0
  }catch(ex){if(alive)error.value=ex.message}
  finally{changing.value=false;if(alive)poll(v)}
}
function add(){
  if(!topic.value||!type.value||!field.value)return
  const item={topic:topic.value,type:type.value,field:field.value}
  if(series.value.some(s=>s.topic===item.topic&&s.type===item.type&&s.field===item.field)){error.value='已添加这个字段';return}
  configure([...series.value,item])
}
async function poll(v){
  clearTimeout(timer)
  if(!alive||v!==version||paused.value||(plot?!series.value.length:!topic.value))return
  const started=performance.now()
  let failed=false
  try{
    if(plot){
      const sentAt=performance.now()
      const d=await props.call('points',{since})
      if(!alive||v!==version||paused.value)return
      since=d.now
      clock.value={server:d.now,local:(sentAt+performance.now())/2}
      const previous=points.value
      const next=d.series.map((s,i)=>{
        const row=previous[i]||[]
        let first=0
        while(first<row.length&&row[first][0]<d.now-60)first++
        if(!first&&!s.points.length)return row
        return row.slice(first).concat(s.points).slice(-3602)
      })
      if(next.some((row,i)=>row!==previous[i]))points.value=next
      issues.value=d.series.map(s=>s.error)
    }else{
      const d=await props.call('sample')
      if(alive&&v===version&&!paused.value)sample.value=d
    }
  }catch(ex){failed=true;if(alive&&v===version)error.value=ex.message}
  finally{
    if(alive&&v===version&&!paused.value){
      // Each response contains every new sample. Rendering has its own clock.
      const period=props.folded||document.hidden?900:Math.max(75,1000/fps.value)
      const delay=failed?1000:plot?Math.max(15,period-(performance.now()-started)):550
      timer=setTimeout(()=>poll(v),delay)
    }
  }
}
function togglePause(){paused.value=!paused.value;version++;clearTimeout(timer);if(!paused.value)poll(version)}
const format=v=>Number(v.toPrecision(5)).toString()
const sampleRates=computed(()=>points.value.map(row=>{
  if(!row.length)return null
  const now=clock.value.server
  let first=row.length-1
  while(first>0&&row[first-1][0]>=now-3)first--
  const last=row.length-1, dt=row[last][0]-row[first][0]
  if(now-row[last][0]>3)return 0
  return dt>0?(last-first)/dt:null
}))
onBeforeUnmount(()=>{alive=false;clearTimeout(timer)})
</script>
<style scoped>
.rqt-swatch{height:4px;width:24px;display:inline-block}.rqt-row select{max-width:min(540px,67vw)}
</style>