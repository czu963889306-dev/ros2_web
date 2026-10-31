<template>
  <button class="trigger" type="button" aria-haspopup="dialog" @click="open">服务日志</button>
  <Teleport to="body">
    <dialog v-if="opened" ref="dialog" class="service-dialog" aria-labelledby="service-title" @close="closed" @keydown.stop @keyup.stop>
      <header><div><h2 id="service-title">服务与日志</h2><p>仅管理 ros_service_ctl.sh 中的 {{ services.length || '指定' }} 个服务</p></div><button type="button" class="close" aria-label="关闭服务日志" @click="close">×</button></header>
      <div class="content">
        <p v-if="statusError" class="error" role="status">{{ statusError }}</p>
        <div class="service-list" role="group" aria-label="脚本管理的服务">
          <button v-for="service in services" :key="service.unit" type="button" :class="['service-row',{selected: selected === service.unit}]" :aria-pressed="selected === service.unit" @click="select(service.unit)"><span><strong>{{ service.label }}</strong><small>{{ service.unit }}</small></span><span :class="['state',{active:service.active === 'active',failed:service.active === 'failed'}]">{{ stateLabel(service.active) }}</span></button>
        </div>
        <section v-if="current" class="selected-service">
          <div class="service-heading"><div><h3>{{ current.label }}</h3><p>{{ current.unit }} · {{ stateLabel(current.active) }} / {{ current.sub }}</p></div><div class="actions"><button type="button" class="start" :disabled="busy || !!statusError || current.load !== 'loaded'" @click="act('start')">启动</button><button type="button" :disabled="busy || !!statusError || current.load !== 'loaded'" @click="act('restart')">重启</button><button type="button" class="stop" :disabled="busy || !!statusError || current.load !== 'loaded'" @click="act('stop')">停止</button></div></div>
          <p class="hint">操作立即生效，开机自启设置不变。</p>
          <p v-if="current.unit === 'ros2-web-topic-throttle.service'" class="notice">中控台依赖此服务；停止或重启可能连带中断网页。若断开，请通过 SSH 执行 <code>bash /root/ros_service_ctl.sh start ros2-web</code> 恢复中控台。</p>
          <p v-if="current.self" class="notice">停止中控台会断开本页面，无法从网页重新启动。可通过 SSH 执行：<code>bash /root/ros_service_ctl.sh start ros2-web</code>。重启后页面会自动恢复连接。</p>
        </section>
        <p v-if="message" :class="['result',{error:messageError}]" role="status">{{ message }}</p>
        <section class="logs-section" aria-label="服务日志">
          <div class="log-toolbar"><strong>服务日志</strong><select v-model="lines" aria-label="日志行数" @change="loadLogs"><option value="100">最近 100 行</option><option value="200">最近 200 行</option><option value="500">最近 500 行</option></select><label><input v-model="autoRefresh" type="checkbox" />自动刷新</label><label><input v-model="autoScroll" type="checkbox" />跟随末尾</label><button type="button" :disabled="logLoading || !selected" @click="refresh">刷新</button></div>
          <p v-if="logError" class="error" role="status">{{ logError }}</p>
          <pre ref="logBox" class="log-output" tabindex="0" aria-label="日志内容">{{ logText || (logLoading ? '正在读取日志…' : '暂无日志') }}</pre>
          <p class="hint">{{ logTime ? `更新于 ${logTime}` : '' }}{{ autoRefresh ? ' · 每 3 秒刷新状态与日志' : ' · 已暂停自动刷新' }}</p>
        </section>
      </div>
      <footer><button type="button" @click="close">收起</button></footer>
    </dialog>
  </Teleport>
</template>
<script setup>
import {ref,computed,nextTick,onMounted,onBeforeUnmount} from 'vue'
const emit=defineEmits(['open'])
const opened=ref(false),dialog=ref(null),services=ref([]),selected=ref(''),statusError=ref('')
const logText=ref(''),logError=ref(''),logLoading=ref(false),lines=ref('200'),autoRefresh=ref(true),autoScroll=ref(true),logBox=ref(null),logTime=ref('')
const message=ref(''),messageError=ref(false),pending=ref(null)
const busy=computed(()=>!!pending.value),current=computed(()=>services.value.find(s=>s.unit===selected.value))
const endpoint=`${window.location.protocol}//${window.location.hostname}:3000/api/services`
let timer,jobTimer,disposed=false,epoch=0,watchId=''
function stateLabel(state){return {active:'运行中',inactive:'已停止',failed:'故障',activating:'启动中',deactivating:'停止中',reloading:'重载中',unknown:'未知'}[state]||state}
async function request(route='',body){
 const response=await fetch(endpoint+route,{cache:'no-store',signal:AbortSignal.timeout(18000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Service-Manager':'1'},body:JSON.stringify(body)})})
 const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'服务操作失败');return result
}
function remember(job){try{job?sessionStorage.setItem('ros-service-job',JSON.stringify(job)):sessionStorage.removeItem('ros-service-job')}catch{}}
async function loadStatus(){
 try{const result=await request();if(!opened.value)return;services.value=result.services;statusError.value='';if(!selected.value||!services.value.some(s=>s.unit===selected.value))selected.value=services.value[0]?.unit||'';if(result.active_job&&!pending.value)track(result.active_job)}
 catch{if(opened.value)statusError.value='无法读取服务状态，请检查中控台连接后刷新。'}
}
async function loadLogs(){
 if(!selected.value||!opened.value)return
 const unit=selected.value,version=epoch;logLoading.value=true
 try{const result=await request(`/logs?unit=${encodeURIComponent(unit)}&lines=${lines.value}`);if(version!==epoch||unit!==selected.value)return;logText.value=result.text;logTime.value=new Date(result.sampled_at).toLocaleTimeString('zh-CN');logError.value='';await nextTick();if(autoScroll.value&&logBox.value)logBox.value.scrollTop=logBox.value.scrollHeight}
 catch{if(version===epoch&&unit===selected.value)logError.value='日志读取失败，请检查连接后重试。'}
 finally{if(version===epoch&&unit===selected.value)logLoading.value=false}
}
async function refresh(){await loadStatus();await loadLogs()}
async function cycle(version){if(!opened.value||version!==epoch)return;if(autoRefresh.value)await refresh();if(opened.value&&version===epoch)timer=setTimeout(()=>cycle(version),3000)}
async function open(){emit('open');opened.value=true;const version=++epoch;await nextTick();dialog.value?.showModal();await refresh();if(opened.value&&epoch===version)timer=setTimeout(()=>cycle(version),3000)}
function close(){dialog.value?.close()}
function closed(){opened.value=false;++epoch;clearTimeout(timer)}
function select(unit){if(selected.value===unit)return;selected.value=unit;logText.value='';logTime.value='';logError.value='';loadLogs()}
function track(job){pending.value=job;remember(job);if(watchId===job.id)return;clearTimeout(jobTimer);watchId=job.id;watch(job)}
async function watch(job){
 if(disposed||watchId!==job.id)return
 try{const result=await request(`/jobs/${job.id}`);if(result.job.state!=='running'){pending.value=null;remember(null);watchId='';message.value=`${job.unit}：${result.job.message}`;messageError.value=result.job.state!=='succeeded';if(opened.value)await refresh();return}}
 catch{if(((job.unit==='ros2-web.service'&&job.action==='stop')||job.unit==='ros2-web-topic-throttle.service')&&Date.now()-job.started_at>3000){pending.value=null;remember(null);watchId='';statusError.value='中控台已断开，请通过 SSH 启动 ros2-web 服务。';message.value='服务操作已提交，中控台连接已中断。恢复命令：bash /root/ros_service_ctl.sh start ros2-web';messageError.value=false;return}message.value=job.unit==='ros2-web.service'?'中控台正在重启，等待恢复连接…':'暂时无法读取操作结果，正在重试…'}
 if(Date.now()-job.started_at>140000){pending.value=null;remember(null);watchId='';message.value='暂时无法确认操作结果，请刷新服务状态和日志。';messageError.value=true;return}
 jobTimer=setTimeout(()=>watch(job),1500)
}
async function act(action){
 if(busy.value||!current.value)return
 pending.value={unit:selected.value,action};messageError.value=false;message.value=`正在提交${{start:'启动',stop:'停止',restart:'重启'}[action]}请求…`
 try{const result=await request('/action',{unit:selected.value,action});message.value='已提交，正在执行服务操作…';track(result.job)}
 catch(error){pending.value=null;messageError.value=true;message.value=error instanceof TypeError||error.name==='TimeoutError'?'请求结果暂时未知，请刷新服务状态后确认。':error.message}
}
onMounted(()=>{try{const job=JSON.parse(sessionStorage.getItem('ros-service-job'));if(job?.id&&job.started_at)track(job)}catch{}})
onBeforeUnmount(()=>{disposed=true;clearTimeout(timer);clearTimeout(jobTimer)})
</script>
<style scoped>
button,input,select {font:inherit}button{cursor:pointer;border:1px solid #cbd5e1;border-radius:7px;background:white;color:#334155;padding:8px 12px}button:disabled{opacity:.5;cursor:not-allowed}button:hover:not(:disabled){border-color:#60a5fa;background:#eff6ff}.trigger{padding:9px 13px}.service-dialog{box-sizing:border-box;width:min(1080px,calc(100% - 24px));max-height:92dvh;padding:0;margin:auto;border:1px solid #e2e8f0;border-radius:16px;background:#fff;color:#1e293b;box-shadow:0 24px 70px #0f172a44}.service-dialog::backdrop{background:#0f172a88}header{display:flex;align-items:center;justify-content:space-between;padding:20px;border-bottom:1px solid #e2e8f0}h2{font-size:21px;margin:0}header p{font-size:13px;color:#64748b;margin:6px 0 0}.close{border:0;background:none;font-size:28px;padding:0 8px;color:#64748b}.content{padding:18px 20px}.service-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.service-row{display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;padding:12px}.service-row.selected{border-color:#2563eb;background:#eff6ff}.service-row strong{font-size:14px}.service-row small{display:block;color:#64748b;font-size:11px;margin-top:5px;overflow-wrap:anywhere}.state{font-size:11px;white-space:nowrap;color:#64748b}.state.active{color:#059669}.state.failed{color:#dc2626}.selected-service{margin-top:18px;border:1px solid #e2e8f0;border-radius:9px;padding:14px}.service-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h3{margin:0;font-size:16px}.service-heading p{font-size:12px;color:#64748b;margin:6px 0;overflow-wrap:anywhere}.actions{display:flex;gap:8px}.actions .start{color:#047857}.actions .stop{color:#b91c1c}.hint{font-size:12px;color:#64748b;line-height:1.6;margin:8px 0}.notice{font-size:12px;line-height:1.7;background:#fffbeb;color:#92400e;padding:10px;border-radius:7px;overflow-wrap:anywhere}.logs-section{margin-top:18px}.log-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;margin-bottom:10px}.log-toolbar strong{font-size:14px;margin-right:auto}.log-toolbar label{display:flex;align-items:center;gap:5px}.log-toolbar input{accent-color:#2563eb}.log-toolbar select{border:1px solid #cbd5e1;border-radius:6px;padding:7px;background:white;color:#334155}.log-output{box-sizing:border-box;min-height:200px;height:330px;max-height:45dvh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#0f172a;color:#cbd5e1;border-radius:10px;padding:14px;font:12px/1.7 ui-monospace,Consolas,monospace;margin:0}.result{font-size:13px;line-height:1.7;background:#ecfdf5;color:#065f46;border-radius:7px;padding:10px;overflow-wrap:anywhere}.error{font-size:13px;color:#b91c1c}.result.error{background:#fef2f2}footer{padding:12px 20px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end}button:focus-visible,select:focus-visible,.log-output:focus-visible{outline:2px solid #2563eb;outline-offset:2px}@media(max-width:760px){.service-list{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){header,.content{padding:16px}.service-list{grid-template-columns:1fr}.log-toolbar{gap:9px}.log-output{height:280px}.service-dialog{max-height:94dvh}}
</style>
