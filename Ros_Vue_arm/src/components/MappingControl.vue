<template>
  <div v-if="connected" class="card">
    <div class="card-header">建图控制</div>
    <div class="card-body">
      <button v-if="!isMapping" class="btn btn-connect mapping-btn"
        :disabled="isLoading" aria-haspopup="dialog" @click="openAlgorithmDialog">
        {{ isLoading ? '正在启动...' : '开始建图' }}
      </button>
      <button v-else class="btn btn-disconnect mapping-btn" :disabled="isLoading" @click="stopMapping">
        {{ isLoading ? '正在停止...' : '停止建图' }}
      </button>
      <div class="mapping-status" role="status" aria-live="polite">
        <span v-if="isMapping" class="mapping-active">● {{ activeLabel }} 建图进程运行中</span>
        <span v-else>○ 建图节点未运行</span>
      </div>
      <div v-if="errorMsg" class="error-message" role="alert">{{ errorMsg }}</div>
    </div>
  </div>

  <Teleport to="body">
    <dialog ref="algorithmDialog" class="mapping-dialog" aria-labelledby="mapping-dialog-title"
      aria-describedby="mapping-dialog-description" @cancel="cancelDialog" @click="closeOnBackdrop"
      @keydown.stop @keyup.stop>
      <h2 id="mapping-dialog-title">选择建图算法</h2>
      <p id="mapping-dialog-description" class="mapping-hint">选择一种算法后开始建图，停止后可重新选择。</p>
      <p v-if="loadingChoices" role="status">正在加载建图选项...</p>
      <fieldset v-else class="algorithm-options" :disabled="isLoading">
        <legend class="visually-hidden">建图算法</legend>
        <label v-for="option in algorithms" :key="option.id" class="algorithm-option"
          :class="{ selected: selectedAlgorithm === option.id, unavailable: !option.available }">
          <input v-model="selectedAlgorithm" type="radio" name="mapping-algorithm"
            :value="option.id" :disabled="!option.available" />
          <span>
            <strong>{{ option.label }}</strong>
            <span class="algorithm-description">{{ option.available ? option.description : '暂未配置' }}</span>
          </span>
        </label>
      </fieldset>
      <p v-if="dialogError" class="error-message" role="alert">{{ dialogError }}</p>
      <div class="mapping-dialog-actions">
        <button type="button" class="mapping-cancel" :disabled="isLoading" @click="algorithmDialog.close()">取消</button>
        <button type="button" class="btn btn-connect mapping-confirm"
          :disabled="isLoading || loadingChoices || !selectedAvailable" @click="startMapping">
          {{ isLoading ? '正在启动...' : '开始建图' }}
        </button>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps({ connected: Boolean })
const emit = defineEmits(['mappingStarted', 'update:isMapping', 'dialogOpened', 'algorithm'])
const isMapping = ref(false)
const isLoading = ref(false)
const activeLabel = ref('')
const errorMsg = ref('')
const dialogError = ref('')
const algorithmDialog = ref(null)
const algorithms = ref([])
const selectedAlgorithm = ref('slam_toolbox')
const loadingChoices = ref(false)
const selectedAvailable = computed(() => algorithms.value.some(a => a.id === selectedAlgorithm.value && a.available))
const API_BASE = `http://${window.location.hostname}:3000/api`
let statusTimer = null
let statusPending = false
let revision = 0

function updateStatus(data) {
  isMapping.value = Boolean(data.isRunning)
  activeLabel.value = data.label || data.algorithm || ''
  emit('update:isMapping', isMapping.value)
  emit('algorithm', data.isRunning ? data.algorithm : null, data.mapSession ?? null)
  errorMsg.value = data.error || ''
}

async function checkStatus() {
  if (isLoading.value || statusPending) return
  const requestRevision = revision
  statusPending = true
  try {
    const res = await fetch(`${API_BASE}/mapping_status`)
    if (!res.ok) throw new Error('获取建图状态失败')
    const data = await res.json()
    if (requestRevision === revision && !isLoading.value) updateStatus(data)
  } catch (err) {
    console.error('获取建图状态失败:', err)
  } finally { statusPending = false }
}

async function openAlgorithmDialog() {
  errorMsg.value = ''
  dialogError.value = ''
  emit('dialogOpened')
  algorithmDialog.value.showModal()
  loadingChoices.value = true
  try {
    const res = await fetch(`${API_BASE}/mapping_algorithms`)
    if (!res.ok) throw new Error('无法加载建图算法，请稍后重试')
    const data = await res.json()
    algorithms.value = data.algorithms
    if (!selectedAvailable.value) selectedAlgorithm.value = data.defaultAlgorithm
  } catch (err) { dialogError.value = err.message }
  finally { loadingChoices.value = false }
}

function cancelDialog(event) { if (isLoading.value) event.preventDefault() }
function closeOnBackdrop(event) {
  if (event.target !== algorithmDialog.value || isLoading.value) return
  const rect = algorithmDialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    algorithmDialog.value.close()
  }
}

async function startMapping() {
  if (isLoading.value || !selectedAvailable.value) return
  isLoading.value = true
  revision++
  dialogError.value = ''
  try {
    const res = await fetch(`${API_BASE}/start_mapping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ algorithm: selectedAlgorithm.value })
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '启动失败')
    updateStatus(data)
    algorithmDialog.value.close()
    emit('mappingStarted')
  } catch (err) { dialogError.value = err.message || '无法连接到本地控制服务' }
  finally { isLoading.value = false }
}

async function stopMapping() {
  if (isLoading.value) return
  isLoading.value = true
  revision++
  errorMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/stop_mapping`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '停止失败')
    updateStatus(data)
  } catch (err) { errorMsg.value = err.message || '无法连接到本地控制服务' }
  finally { isLoading.value = false }
}

watch(() => props.connected, connected => { if (!connected) algorithmDialog.value?.close() })
onMounted(() => { checkStatus(); statusTimer = setInterval(checkStatus, 3000) })
onUnmounted(() => { revision++; clearInterval(statusTimer) })
</script>

<style scoped>
.mapping-btn { width: 100%; font-weight: 600; padding: 12px; }
.mapping-status { margin-top: 8px; font-size: .85rem; color: var(--text-muted); }
.mapping-active { color: #047857; }
.mapping-dialog { position: fixed; inset: 0; margin: auto; width: min(460px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--border-color);
  border-radius: 12px; color: var(--text-primary); background: var(--bg-card); box-shadow: 0 24px 80px #0f172a33; }
.mapping-dialog::backdrop { background: #0f172a66; }
.mapping-dialog h2 { font-size: 1.2rem; margin-bottom: 8px; }
.mapping-hint { color: var(--text-muted); font-size: .88rem; line-height: 1.6; margin-bottom: 18px; }
.algorithm-options { display: grid; gap: 10px; border: 0; padding: 0; margin: 0; min-width: 0; }
.algorithm-option { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid var(--border-color);
  border-radius: 8px; cursor: pointer; }
.algorithm-option.selected { border-color: var(--accent-primary); background: #eff6ff; }
.algorithm-option:focus-within { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.algorithm-option.unavailable { opacity: .5; cursor: not-allowed; }
.algorithm-option input { accent-color: var(--accent-primary); flex-shrink: 0; width: 16px; height: 16px; }
.algorithm-option strong { display: block; margin-bottom: 4px; }
.algorithm-description { display: block; font-size: .82rem; line-height: 1.5; color: var(--text-secondary); }
.mapping-dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.mapping-confirm { width: auto; padding: 10px 20px; }
.mapping-cancel { border: 1px solid var(--border-color); background: var(--bg-secondary); padding: 10px 18px;
  border-radius: var(--radius-sm); color: var(--text-secondary); cursor: pointer; }
.mapping-cancel:disabled { opacity: .5; cursor: not-allowed; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
