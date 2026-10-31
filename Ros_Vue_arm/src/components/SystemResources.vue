<template>
  <div class="system-resources" aria-label="设备系统资源" :title="online ? '设备资源每 2 秒刷新' : '设备资源暂不可用'">
    <span class="resource-metric" :class="{ high: cpu !== null && cpu >= 85 }"><span class="resource-label">CPU</span><strong>{{ percent(cpu) }}</strong></span>
    <span class="resource-metric" :class="{ high: memory !== null && memory >= 85 }" :title="memoryDetails"><span class="resource-label">内存</span><strong>{{ percent(memory) }}</strong></span>
    <span class="resource-metric" :class="{ high: temperature !== null && temperature >= 80 }"><span class="resource-label">CPU温度</span><strong>{{ temperature === null ? '—' : temperature.toFixed(1) + '°C' }}</strong></span>
    <span class="resource-metric device-clock" :title="timezone ? '设备时间 · ' + timezone : '等待设备时间'"><span class="resource-label">设备时间</span><time :datetime="isoTime">{{ clock }}</time></span>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
const status = ref(null), now = ref(Date.now()), receivedAt = ref(0), offset = ref(0), timezone = ref('')
let pollingTimer, clockTimer, controller, disposed = false
const online = computed(() => status.value !== null && receivedAt.value > 0 && now.value - receivedAt.value < 8000)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const cpu = computed(() => online.value && finite(status.value.cpu_percent) ? status.value.cpu_percent : null)
const memory = computed(() => online.value && finite(status.value.memory?.percent) ? status.value.memory.percent : null)
const temperature = computed(() => online.value && finite(status.value.cpu_temperature_c) ? status.value.cpu_temperature_c : null)
const percent = value => value === null ? '—' : value.toFixed(1) + '%'
const memoryDetails = computed(() => {
  const value = online.value ? status.value.memory : null
  return value ? `已用 ${(value.used_bytes / 1024 ** 3).toFixed(2)} / 总计 ${(value.total_bytes / 1024 ** 3).toFixed(2)} GiB（扣除可用缓存）` : '等待内存数据'
})
const isoTime = computed(() => online.value ? new Date(now.value + offset.value).toISOString() : undefined)
const clock = computed(() => {
  if (!online.value) return '—'
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone.value || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now.value + offset.value)
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`
})
async function poll() {
  controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(`http://${window.location.hostname}:3000/api/system-status`, { cache: 'no-store', signal: controller.signal })
    if (!response.ok) throw new Error('unavailable')
    const value = await response.json()
    if (!value.success || !Number.isFinite(Date.parse(value.server_time))) throw new Error('invalid status')
    if (disposed) return
    offset.value = Date.parse(value.server_time) - Date.now()
    timezone.value = value.timezone
    status.value = value; receivedAt.value = Date.now(); now.value = Date.now()
  } catch { if (!disposed) status.value = null }
  finally { clearTimeout(timeout); if (!disposed) pollingTimer = setTimeout(poll, 2000) }
}
onMounted(() => { poll(); clockTimer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { disposed = true; clearTimeout(pollingTimer); clearInterval(clockTimer); controller?.abort() })
</script>

<style scoped>
.system-resources { display:flex; align-items:center; flex-wrap:wrap; gap:10px 16px; color:#334155; font-size:.78rem; }
.resource-metric { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
.resource-label { color:#64748b; } strong,time { font-size:.8rem; font-weight:500; font-variant-numeric:tabular-nums; }
.high strong { color:#dc2626; }
@media(max-width:800px) { .system-resources { width:100%; gap:8px 14px; justify-content:space-between; } }
@media(max-width:500px) { .system-resources { display:grid; grid-template-columns:repeat(3,max-content); } .device-clock { grid-column:1/-1; } }
</style>
