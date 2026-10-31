<template>
  <div class="wifi-top">
    <div class="wifi-address" :title="status?.ssid || '无线网络'">
      <span>Wi-Fi IP</span><strong>{{ statusError ? '读取失败' : !status ? '读取中…' : status.ipv4.length ? status.ipv4.join(' / ') : status.connected ? '等待分配 IP' : '未连接' }}</strong>
      <small v-if="status?.ssid && !statusError">{{ status.ssid }}</small>
    </div>
    <button type="button" class="wifi-trigger" aria-haspopup="dialog" @click="open">Wi-Fi 连接</button>
  </div>
  <Teleport to="body">
    <dialog v-if="opened" ref="dialog" class="wifi-dialog" aria-labelledby="wifi-title" @close="closed" @keydown.stop @keyup.stop>
      <header><div><h2 id="wifi-title">Wi-Fi 连接</h2><p>{{ statusError ? '暂时无法读取网络状态' : status?.connected ? `当前网络：${status.ssid}` : '选择附近的无线网络' }}</p></div><button type="button" class="wifi-close" aria-label="关闭 Wi-Fi 设置" @click="close">×</button></header>
      <div class="wifi-body">
        <div class="wifi-scan-heading"><strong>附近的 Wi-Fi</strong><button type="button" class="secondary" :disabled="scanning || connecting" @click="scan">{{ scanning ? '正在扫描…' : '重新扫描' }}</button></div>
        <p v-if="scanning" role="status">正在查找附近的 Wi-Fi，请稍候…</p>
        <p v-else-if="!networks.length" class="hint">暂未发现 Wi-Fi，可点击“重新扫描”。</p>
        <div class="wifi-networks" role="group" aria-label="附近的 Wi-Fi">
          <button v-for="network in networks" :key="network.bssid" type="button" :class="['wifi-network', { selected: selected?.bssid === network.bssid }]" :aria-pressed="selected?.bssid === network.bssid" :disabled="connecting || scanning || !network.supported" @click="select(network)">
            <span class="wifi-network-name">{{ network.ssid }}<span v-if="network.connected" class="badge">当前连接</span><span v-else-if="network.saved" class="badge saved">已保存</span></span>
            <span class="wifi-network-meta">信号 {{ network.signal }}% · {{ network.band }} · {{ network.security }}{{ !network.supported ? '（暂不支持）' : '' }}</span>
          </button>
        </div>
        <form v-if="selected" id="wifi-connect-form" class="wifi-form" @submit.prevent="connect">
          <p>已选择：<strong>{{ selected.ssid }}</strong></p>
          <template v-if="needsPassword">
            <label for="wifi-password">Wi-Fi 密码{{ selected.saved ? '（已保存，可留空）' : '' }}</label>
            <input id="wifi-password" v-model="password" type="password" autocomplete="new-password" maxlength="64" :required="!selected.saved" :disabled="connecting" :placeholder="selected.saved ? '留空使用已保存的密码' : '输入 Wi-Fi 密码'" />
          </template>
          <p v-else class="hint">{{ selected.mode === 'owe' ? '此网络无需密码。' : '此网络未设置密码。' }}</p>
        </form>
        <p v-if="message" :class="['wifi-result', { error: isError }]" role="status">{{ message }}</p>
        <p class="hint">切换 Wi-Fi 后，此页面可能断开。请让手机或电脑连接同一网络，再用设备的新 IP 打开页面。</p>
        <p v-if="ethernetUrl" class="hint">也可连接设备网线，在同一有线网段访问 <a :href="ethernetUrl">{{ ethernetUrl }}</a>。</p>
      </div>
      <footer><button class="primary" type="submit" form="wifi-connect-form" :disabled="!selected || scanning || connecting">{{ connecting ? '正在连接…' : selected?.connected && !password ? '确认当前连接' : '连接 Wi-Fi' }}</button><button type="button" class="secondary" @click="close">收起</button></footer>
    </dialog>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
const emit = defineEmits(['open'])
const status = ref(null), statusError = ref(false), dialog = ref(null), opened = ref(false)
const networks = ref([]), selected = ref(null), password = ref(''), scanning = ref(false), connecting = ref(false)
const message = ref(''), isError = ref(false)
const needsPassword = computed(() => ['wpa-psk', 'sae'].includes(selected.value?.mode))
const ethernetUrl = computed(() => status.value?.ethernet_ipv4?.[0] ? `${window.location.protocol}//${status.value.ethernet_ipv4[0]}:${window.location.port || '5173'}` : '')
const endpoint = `${window.location.protocol}//${window.location.hostname}:3000/api/wifi`
let stopped = false, statusTimer, jobTimer
async function request(route, body, timeout = 8000) {
  const response = await fetch(endpoint + route, { cache: 'no-store', signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wifi-Settings': '1' }, body: JSON.stringify(body) }) })
  const result = await response.json()
  if (!response.ok || !result.success) throw new Error(result.error || '网络操作失败，请重试')
  return result
}
async function refresh() {
  try { status.value = await request('/status'); statusError.value = false } catch { statusError.value = true }
}
async function pollStatus() {
  await refresh()
  if (!stopped) statusTimer = setTimeout(pollStatus, 3000)
}
async function open() {
  emit('open'); opened.value = true; await nextTick(); dialog.value?.showModal()
  if (!connecting.value) await scan()
}
function close() { dialog.value?.close() }
function closed() { password.value = ''; opened.value = false }
function select(network) { selected.value = network; password.value = ''; message.value = ''; isError.value = false }
async function scan() {
  if (scanning.value || connecting.value) return
  scanning.value = true; message.value = ''; isError.value = false; password.value = ''; selected.value = null
  try { const result = await request('/scan', {}, 35000); networks.value = result.networks; selected.value = networks.value.find(n => n.connected && n.supported) || null }
  catch (error) { networks.value = []; message.value = error.name === 'TimeoutError' || error instanceof TypeError ? '扫描失败，请检查设备连接后重试。' : error.message; isError.value = true }
  finally { scanning.value = false }
}
function finish(job) {
  connecting.value = false; message.value = job.message; isError.value = job.state === 'failed'
  if (job.network) { status.value = job.network; statusError.value = false }
  refresh()
}
async function pollJob(id, started) {
  if (stopped) return
  try {
    const result = await request(`/jobs/${encodeURIComponent(id)}`, undefined, 5000)
    if (result.job.state !== 'connecting') { finish(result.job); return }
    message.value = result.job.message
  } catch { message.value = '正在切换网络，暂时无法访问设备。若网络已改变，请使用设备的新 IP 重新打开页面。' }
  if (Date.now() - started > 110000) {
    connecting.value = false; isError.value = true; message.value = '暂时无法确认连接结果，请查看顶部 Wi-Fi 状态；若设备 IP 已改变，请用新 IP 访问。'; return
  }
  jobTimer = setTimeout(() => pollJob(id, started), 2000)
}
async function connect() {
  if (!selected.value || connecting.value) return
  connecting.value = true; isError.value = false; message.value = '正在提交连接请求…'
  const body = { ssid: selected.value.ssid, bssid: selected.value.bssid, password: password.value }
  password.value = ''
  try {
    const result = await request('/connect', body, 35000)
    if (result.job.state === 'connecting') { message.value = result.job.message; pollJob(result.job.id, Date.now()) }
    else finish(result.job)
  } catch (error) { connecting.value = false; isError.value = true; message.value = error instanceof TypeError || error.name === 'TimeoutError' ? '设备暂时无法访问，连接请求可能已提交。请检查当前网络或使用设备的新 IP 访问。' : error.message }
  finally { body.password = '' }
}
onMounted(pollStatus)
onBeforeUnmount(() => { stopped = true; clearTimeout(statusTimer); clearTimeout(jobTimer); password.value = '' })
</script>

<style scoped>
.wifi-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.wifi-address { display:flex; flex-direction:column; gap:2px; font-size:11px; color:#64748b; }
.wifi-address strong { color:#0f172a; font-size:14px; font-variant-numeric:tabular-nums; }
.wifi-address small { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
button { cursor:pointer; font:inherit; }
.wifi-trigger,.secondary { border:1px solid #cbd5e1; border-radius:8px; padding:9px 13px; background:#fff; color:#334155; }
.wifi-trigger:hover,.secondary:hover { background:#eff6ff; border-color:#93c5fd; }
.wifi-dialog { box-sizing:border-box; width:min(580px,calc(100% - 24px)); max-height:90dvh; margin:auto; padding:0; border:1px solid #e2e8f0; border-radius:16px; color:#1e293b; background:#fff; box-shadow:0 24px 70px #0f172a44; }
.wifi-dialog::backdrop { background:#0f172a88; }
header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:20px; border-bottom:1px solid #e2e8f0; }
h2 { margin:0; font-size:21px; } header p { margin:6px 0 0; color:#64748b; font-size:13px; overflow-wrap:anywhere; }
.wifi-close { background:transparent; border:0; color:#64748b; font-size:28px; padding:0 8px; }
.wifi-body { padding:20px; } .wifi-scan-heading { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; }
.wifi-networks { max-height:270px; overflow:auto; display:grid; gap:8px; }
.wifi-network { width:100%; text-align:left; padding:12px; border:1px solid #e2e8f0; border-radius:9px; background:#fff; color:#1e293b; }
.wifi-network.selected { background:#eff6ff; border-color:#2563eb; }
.wifi-network-name { display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-weight:600; overflow-wrap:anywhere; }
.wifi-network-meta { display:block; margin-top:6px; font-size:12px; color:#64748b; }
.badge { font-size:11px; border-radius:4px; padding:2px 5px; color:#047857; background:#d1fae5; }.badge.saved { color:#475569; background:#e2e8f0; }
.wifi-form { margin-top:18px; padding-top:4px; } label { display:block; font-size:14px; margin-bottom:8px; }
input { box-sizing:border-box; width:100%; padding:11px; border:1px solid #cbd5e1; border-radius:8px; font:inherit; }
.hint { font-size:12px; line-height:1.7; color:#64748b; overflow-wrap:anywhere; } a { color:#2563eb; }
.wifi-result { padding:12px; border-radius:8px; font-size:14px; line-height:1.6; color:#065f46; background:#ecfdf5; overflow-wrap:anywhere; }.wifi-result.error { color:#b91c1c; background:#fef2f2; }
footer { display:flex; justify-content:flex-end; gap:10px; padding:16px 20px; border-top:1px solid #e2e8f0; }
.primary { background:#2563eb; color:white; border:1px solid #2563eb; border-radius:8px; padding:10px 16px; }
button:disabled { opacity:.55; cursor:not-allowed; } button:focus-visible,input:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
@media(max-width:500px) { .wifi-top { width:100%; justify-content:space-between; } .wifi-dialog { max-height:94dvh; } .wifi-body,header { padding:16px; } }
</style>
