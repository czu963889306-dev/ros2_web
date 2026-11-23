<template>
  <button type="button" class="domain-button" title="设置 ROS 通信域号" @click="open">
    ROS_DOMAIN_ID <strong>{{ current ?? '—' }}</strong>
  </button>
  <Teleport to="body">
    <dialog ref="dialog" class="domain-dialog" aria-labelledby="domain-title" @close="closed">
      <form @submit.prevent="apply">
        <h2 id="domain-title">ROS 域号设置</h2>
        <p>当前生效的 ROS_DOMAIN_ID <strong>{{ current ?? '—' }}</strong></p>
        <label for="ros-domain-number">新域号（0–232）</label>
        <input id="ros-domain-number" v-model="draft" type="number" min="0" max="232" step="1"
          required inputmode="numeric" :disabled="busy || configured === null" />
        <p>切换会重启本机 ROS 服务并中断导航、建图。与机器人通信的电脑也需要使用相同域号。</p>
        <p v-if="notice" role="status" :class="{error: failed}">{{ notice }}</p>
        <footer>
          <button type="button" @click="dialog.close()">关闭</button>
          <button class="apply" type="submit" :disabled="!canApply">应用并重启 ROS 服务</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<script setup>
import { computed, ref, onUnmounted } from 'vue'
const props = defineProps({ current: Number })
const emit = defineEmits(['open'])
const endpoint = 'http://' + window.location.hostname + ':3000/api/ros-domain'
const dialog = ref(null), draft = ref(''), configured = ref(null)
const busy = ref(false), failed = ref(false), notice = ref('')
const canApply = computed(() => !busy.value && configured.value !== null && /^\d+$/.test(String(draft.value)) &&
  Number(draft.value) <= 232 && (Number(draft.value) !== configured.value || failed.value))
let timer, generation = 0
function closed() { generation++; clearTimeout(timer) }
onUnmounted(closed)

async function refresh(token, fill = false) {
  if (token !== generation) return
  try {
    const response = await fetch(endpoint, { cache:'no-store', signal:AbortSignal.timeout(5000) })
    if (!response.ok) throw Error()
    const data = await response.json()
    if (token !== generation) return
    configured.value = data.configured
    if (fill) draft.value = String(data.configured)
    busy.value = ['queued','running'].includes(data.job?.state)
    failed.value = data.job?.state === 'failed'
    notice.value = data.job?.message || ''
    if (!busy.value) return
  } catch {
    if (token !== generation) return
    notice.value = busy.value ? '正在等待中控台重新连接…' : '暂时无法读取域号，正在重试…'
  }
  timer = setTimeout(() => refresh(token, fill && configured.value === null), 1600)
}
function open() {
  closed()
  emit('open')
  configured.value = null; draft.value = ''; failed.value = false; notice.value = ''
  dialog.value.showModal()
  refresh(generation, true)
}
async function apply() {
  if (!canApply.value) return
  const token = ++generation
  clearTimeout(timer); busy.value = true; failed.value = false
  notice.value = '正在提交域号…'
  try {
    const response = await fetch(endpoint, { method:'PUT', headers:{'Content-Type':'application/json','X-ROS-Domain':'1'},
      body:JSON.stringify({ domain:Number(draft.value), expected:configured.value }), signal:AbortSignal.timeout(18000) })
    const result = await response.json()
    if (token !== generation) return
    if (!response.ok) {
      await refresh(token, true)
      if (token === generation) { failed.value = true; notice.value = result.error || '切换请求未成功' }
      return
    }
    notice.value = result.changed ? '正在切换 ROS 域号…' : '当前已使用此域号'
  } catch {
    if (token !== generation) return
    notice.value = '正在重新连接并核对切换结果…'
  }
  if (token === generation) timer = setTimeout(() => refresh(token, true), 1000)
}
</script>

<style scoped>
.domain-button { border:1px solid #c9d3de; border-radius:4px; padding:3px 7px; cursor:pointer; color:#334155; background:#f8fafc; font-size:.78rem; white-space:nowrap; }
.domain-button strong { font-family:var(--font-mono); }
.domain-dialog { margin:auto; width:min(385px,calc(100vw - 32px)); padding:20px; border:1px solid #c3ccd7; border-radius:9px; color:#25364a; background:white; }
.domain-dialog::backdrop { background:rgb(21 32 46 / 40%); }
.domain-dialog h2 { margin:0 0 14px; font-size:1.1rem; }
.domain-dialog p,.domain-dialog label { font-size:.9rem; line-height:1.5; }
.domain-dialog input { display:block; width:100%; margin-top:5px; padding:7px; border:1px solid #acb8c2; border-radius:4px; }
.domain-dialog footer { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
.domain-dialog button { padding:7px 11px; border:1px solid #c3ccd7; border-radius:4px; cursor:pointer; }
.domain-dialog .apply { background:#2765d9; color:white; border-color:#2765d9; }
.domain-dialog button:disabled { opacity:.5; cursor:default; }
.domain-dialog .error { color:#a12b23; }
</style>
