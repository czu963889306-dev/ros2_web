<template>
  <div v-if="pub" class="rqt-stack">
    <label for="rqt-dest">发布话题</label>
    <input id="rqt-dest" class="rqt-mono" v-model.trim="dest" list="rqt-pub-topics" placeholder="/my_topic" :disabled="locked">
    <datalist id="rqt-pub-topics"><option v-for="[n] in catalog.topics" :key="n" :value="n"/></datalist>
  </div>
  <label v-else class="rqt-stack">服务名称<select v-model="dest" :disabled="busy"><option value="">请选择服务</option><option v-for="[n] in catalog.services" :key="n" :value="n">{{ n }}</option></select></label>
  <label class="rqt-stack">接口类型
    <select v-model="type" :disabled="locked"><option value="">请选择类型</option><option v-for="t in types" :key="t">{{ t }}</option></select>
  </label>
  <label class="rqt-stack">{{ pub?'消息内容（JSON）':'请求参数（JSON）' }}
    <textarea rows="7" spellcheck="false" v-model="draft" :disabled="locked||!loaded"></textarea>
  </label>
  <details v-if="fields && Object.keys(fields).length"><summary>字段类型</summary><pre>{{ fieldList }}</pre></details>
  <template v-if="pub">
    <div class="rqt-row"><label>周期频率 <input type="number" v-model.number="hz" min="0.1" max="50" step="0.1" style="width:82px" :disabled="locked"> Hz</label>
      <label><input type="checkbox" v-model="bestEffort" :disabled="locked">尽力传输</label><label><input type="checkbox" v-model="latched" :disabled="locked">保留最后消息</label></div>
    <div class="rqt-row"><button class="primary" :disabled="!canSend" @click="submit(false)">发布一次</button><button :disabled="!canSend||!(hz>=0.1 && hz<=50)" @click="submit(true)">开始周期发布</button><button :disabled="busy||!running" @click="stop">停止发布</button>
      <span aria-live="polite" class="rqt-muted">{{ running?'发布中':'已发送' }} · {{ sent }} 条 · 匹配订阅者 {{ matched }}</span></div>
    <p class="rqt-muted">切换工具或关闭工具箱会停止周期发布。</p>
  </template>
  <div v-else class="rqt-row"><button class="primary" :disabled="!canSend" @click="submit(false)">{{ busy?'等待服务响应…':'调用服务' }}</button></div>
  <p v-if="error" class="rqt-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  <div v-if="response"><b>服务响应</b><pre>{{ response }}</pre></div>
</template>
<script setup>
import {computed,ref,watch,onMounted,onBeforeUnmount} from 'vue'
const emit=defineEmits(['publishing'])
const props=defineProps({mode:String,call:Function,catalog:Object})
const pub=props.mode==='publisher',dest=ref(''),type=ref(pub?'std_msgs/msg/String':''),draft=ref(''),fields=ref(null),loaded=ref(false)
const busy=ref(false),running=ref(false),hz=ref(1),bestEffort=ref(false),latched=ref(false),sent=ref(0),matched=ref(0)
const error=ref(''),notice=ref(''),response=ref('')
const discovered=computed(()=>(pub?props.catalog.topics:props.catalog.services)?.find(row=>row[0]===dest.value)?.[1]||[])
const types=computed(()=>pub&&!discovered.value.length?props.catalog.types||[]:discovered.value)
const fieldList=computed(()=>Object.entries(fields.value||{}).map(([k,v])=>k+'   '+v).join('\n'))
const locked=computed(()=>busy.value||running.value)
const canSend=computed(()=>loaded.value&&dest.value&&type.value&&!locked.value)
watch(running,value=>emit('publishing',value))
let alive=true,schemaId=0,timer,revision=0
watch(()=>[dest.value,discovered.value.join(',')],()=>{
  if(locked.value)return
  if(discovered.value.length&&!discovered.value.includes(type.value))type.value=discovered.value[0]
  if(!pub&&!discovered.value.length)type.value=''
  response.value='';notice.value='';error.value=''
})
watch(type,async t=>{
  const id=++schemaId;loaded.value=false;draft.value='';fields.value=null;response.value='';error.value=''
  if(!t)return
  try{
    const data=await props.call('schema',{type:t})
    if(alive&&id===schemaId){draft.value=data.template;fields.value=data.fields;loaded.value=true}
  }catch(ex){if(alive&&id===schemaId)error.value=ex.message}
},{immediate:true})
async function status(){
  clearTimeout(timer);if(!alive||!pub)return
  const token=revision
  try{const d=await props.call('publisher_status');if(alive&&token===revision){running.value=d.running;sent.value=d.sent;matched.value=d.matched}}
  catch(ex){if(alive)error.value=ex.message}
  finally{if(alive)timer=setTimeout(status,1000)}
}
async function submit(periodic){
  if(!canSend.value)return
  error.value='';notice.value='';response.value=''
  try{JSON.parse(draft.value)}catch{error.value='请输入有效的 JSON 对象';return}
  busy.value=true;revision++
  try{
    if(pub){
      const d=await props.call('publish',{topic:dest.value,type:type.value,text:draft.value,hz:periodic?Number(hz.value):0,bestEffort:bestEffort.value,latched:latched.value})
      if(alive){revision++;running.value=!!d.running;sent.value=d.sent||0;matched.value=d.matched||0;notice.value=periodic?'已开始周期发布':'已发布一条消息'}
    }else{
      const d=await props.call('call',{service:dest.value,type:type.value,text:draft.value})
      if(alive)response.value=d.response
    }
  }catch(ex){if(alive)error.value=ex.message}
  finally{if(alive)busy.value=false}
}
async function stop(){
  busy.value=true;error.value='';revision++
  try{await props.call('stop');if(alive){revision++;running.value=false;notice.value='已停止周期发布'}}
  catch(ex){if(alive)error.value=ex.message}
  finally{if(alive)busy.value=false}
}
onMounted(()=>{if(pub)status()})
onBeforeUnmount(()=>{alive=false;clearTimeout(timer)})
</script>