<template>
  <section class="presets">
    <h3>语音导航点</h3>
    <p class="hint">点位随地图保存。唤醒后说“导航到厨房”，或“停止导航”。</p>
    <div class="actions">
      <button :disabled="!isNavigating || busy" @click="currentPose">取当前位置</button>
      <button :disabled="!isNavigating || busy" @click="$emit('pick', !isPicking)">{{ isPicking ? '取消选点' : '地图选点' }}</button>
    </div>
    <p v-if="isPicking" class="notice">双击地图选择保存位置，然后填写名称。选点不会启动导航。</p>
    <form @submit.prevent="save">
      <label>名称<input v-model="name" maxlength="40" required placeholder="例如：厨房、充电点" /></label>
      <div class="coordinates">
        <label>X（米）<input v-model.number="x" type="number" step="0.001" required /></label>
        <label>Y（米）<input v-model.number="y" type="number" step="0.001" required /></label>
        <label>朝向（度）<input v-model.number="angle" type="number" step="0.1" min="-180" max="180" required /></label>
      </div>
      <div class="actions"><button :disabled="!mapPath || busy">{{ editing ? '保存修改' : '添加点位' }}</button><button v-if="editing" type="button" @click="reset">取消编辑</button></div>
    </form>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <p v-if="!points.length" class="hint">当前地图暂无预设点。</p>
    <ul>
      <li v-for="p in points" :key="p.id">
        <strong>{{ p.name }}</strong><span>{{ p.x.toFixed(2) }}, {{ p.y.toFixed(2) }} · {{ (p.yaw * 180 / Math.PI).toFixed(0) }}°</span>
        <div class="actions"><button :disabled="!isNavigating || busy" @click="go(p)">前往</button><button :disabled="busy" @click="edit(p)">编辑</button><button :disabled="busy" @click="remove(p)">删除</button></div>
      </li>
    </ul>
    <button v-if="isNavigating" :disabled="busy" @click="cancel">停止当前导航</button>
    <p class="hint" v-if="isNavigating">{{ stateText }}</p>
  </section>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
const props = defineProps({ mapPath: String, isNavigating: Boolean, isPicking: Boolean, pickedPose: Object })
const emit = defineEmits(['pick', 'external-goal'])
const api = `http://${window.location.hostname}:3000/api/navigation`
const points = ref([]), name = ref(''), x = ref(''), y = ref(''), angle = ref(0), editing = ref(''), message = ref(''), busy = ref(false), stateText = ref('')
let timer, revision = null
async function request(endpoint, method = 'GET', body) {
  const response = await fetch(api + endpoint, { method, signal: AbortSignal.timeout(18000), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok || !data.success) throw new Error(data.error || '操作失败')
  return data
}
async function run(action) {
  busy.value = true; message.value = ''
  try { await action() } catch (error) { message.value = error.message } finally { busy.value = false }
}
async function load() {
  if (!props.mapPath) { points.value = []; return }
  const map = props.mapPath
  const result = await request('/points?mapPath=' + encodeURIComponent(map))
  if (map === props.mapPath) points.value = result.points
}
function reset() { editing.value = ''; name.value = ''; x.value = ''; y.value = ''; angle.value = 0 }
function edit(p) { editing.value = p.id; name.value = p.name; setPose(p) }
function setPose(p) { x.value = Number(p.x.toFixed(3)); y.value = Number(p.y.toFixed(3)); angle.value = Number((p.yaw * 180 / Math.PI).toFixed(1)) }
function currentPose() { run(async () => {
  const data = await request('/state')
  if (!data.ready || !data.pose || data.mapPath !== props.mapPath) throw new Error('当前地图定位尚未就绪，请先设置初始位置')
  setPose(data.pose); message.value = '已填入当前位置，请命名并保存'
}) }
function save() { run(async () => {
  await request('/points' + (editing.value ? '/' + editing.value : ''), editing.value ? 'PUT' : 'POST', { name: name.value, mapPath: props.mapPath, x: x.value, y: y.value, yaw: angle.value * Math.PI / 180 })
  reset(); emit('pick', false); await load(); message.value = '点位已保存，可以通过语音前往'
}) }
function remove(p) {
  if (!window.confirm(`删除导航点“${p.name}”？`)) return
  run(async () => { await request('/points/' + p.id, 'DELETE'); if (editing.value === p.id) reset(); await load() })
}
function go(p) { run(async () => { const result = await request('/go-to', 'POST', { id: p.id }); emit('external-goal'); message.value = result.message }) }
function cancel() { run(async () => { const result = await request('/cancel', 'POST', {}); emit('external-goal'); message.value = result.message }) }
async function poll() {
  try {
    const data = await request('/state')
    if (revision !== null && revision !== data.revision) emit('external-goal')
    revision = data.revision
    const labels = { CANCELING: '正在取消', CANCELED: '已取消', OFFLINE: '导航未连接', IDLE: '等待设置初始位置', LOCALIZED: '定位就绪', GOAL_SUBMITTED: '目标已下发', PLANNING: '正在规划', TRACKING: '正在前往', ARRIVED: '已到达', PLAN_FAILED: '规划失败', SCAN_STALE_STOP: '激光数据过期，已停止', LOCAL_BLOCKED: '前方受阻', LOCAL_RECOVERY: '正在避障' }
    stateText.value = (labels[data.status] || data.status) + (data.distance_remaining == null ? '' : ` · 剩余 ${data.distance_remaining.toFixed(2)} 米`)
  } catch { stateText.value = '导航状态暂不可用' }
}
watch(() => props.mapPath, () => { reset(); emit('pick', false); run(load) }, { immediate: true })
watch(() => props.pickedPose, p => { if (p) { setPose(p); message.value = '已选取地图位置，请命名并保存' } })
watch(() => props.isNavigating, value => { if (!value) emit('pick', false) })
onMounted(() => { poll(); timer = setInterval(poll, 2000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.presets { margin-top:16px; padding-top:12px; border-top:1px solid #cbd5e1; font-size:.8rem; }
h3 { margin:0 0 8px; font-size:.95rem; } .hint { color:#64748b; line-height:1.5; }
label { display:block; margin:8px 0; min-width:0; } input { width:100%; box-sizing:border-box; padding:7px; border:1px solid #cbd5e1; border-radius:5px; }
.coordinates { display:grid; grid-template-columns:1fr 1fr 1fr; gap:5px; }
.actions { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; } button { border:1px solid #cbd5e1; background:#f1f5f9; border-radius:5px; padding:6px 10px; cursor:pointer; color:#1e3a8a; } button:disabled { opacity:.45; cursor:default; }
ul { padding:0; list-style:none; max-height:260px; overflow:auto; } li { padding:9px 0; border-bottom:1px solid #e2e8f0; } li span { display:block; color:#64748b; margin-top:4px; } .notice { background:#eff6ff; padding:8px; line-height:1.5; color:#1e40af; }
</style>
