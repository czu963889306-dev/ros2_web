<template>
  <div class="card" v-if="connected">
    <div class="card-header">
      导航控制
    </div>
    <div class="card-body">
      <!-- 地图选择 -->
      <div class="nav-section">
        <label class="nav-label">选择地图</label>
        <div class="map-select-group">
          <select
            class="map-select"
            v-model="selectedMap"
            :disabled="isNavigating || isLoading"
          >
            <option value="" disabled>— 请选择地图 —</option>
            <option v-for="m in maps" :key="m.path" :value="m.path">
              {{ m.name }}
            </option>
          </select>
          <button class="btn-icon" @click="loadMaps" :disabled="isLoading" title="刷新列表">
            <span :class="['refresh-icon', { spinning: isLoading }]">↻</span>
          </button>
        </div>
        <div v-if="maps.length === 0 && !isLoading" class="nav-hint">
          暂无地图，请先完成建图并保存
        </div>
      </div>

      <!-- 启动/停止按钮 -->
      <div class="nav-section">
        <button
          v-if="!isNavigating"
          class="btn btn-connect nav-btn"
          @click="openDriveTypeDialog"
          :disabled="isLoading || !selectedMap"
        >
          {{ isLoading ? '正在启动...' : '开始导航' }}
        </button>
        <div v-else class="nav-action-row">
          <button
            class="btn btn-disconnect nav-btn"
            @click="shutdownNavigation"
            :disabled="isLoading"
          >
            {{ isLoading ? '处理中...' : '关闭导航' }}
          </button>
        </div>
      </div>

      <!-- 导航状态 -->
      <div class="nav-status">
        <span v-if="isNavigating" class="status-nav-active">● {{ activeLabel }} 导航进程运行中</span>
        <span v-else class="status-nav-idle">○ 导航节点未运行</span>
      </div>

      <!-- 初始位置设置 (仅导航运行中显示) -->
      <div v-if="isNavigating" class="nav-section mt-2">
        <button
          class="nav-btn"
          :class="isSettingPose ? 'btn-pose-active' : 'btn-pose'"
          @click="togglePoseMode"
        >
          {{ isSettingPose ? '正在设置... (按住拖动)' : '设置初始位置' }}
        </button>
      </div>

      <!-- 多点导航 -->
      <div v-if="isNavigating && !isSettingPose" class="nav-section mt-2">
        <button
          class="nav-btn"
          :class="multiPointMode ? 'btn-waypoint-active' : 'btn-waypoint'"
          @click="toggleMultiPointMode"
        >
          {{ multiPointMode ? '多点导航: 已开启' : '多点导航: 已关闭' }}
        </button>
        <div v-if="multiPointMode" class="waypoint-row">
          <span class="waypoint-count">队列点位: {{ waypointCount }}</span>
          <button class="btn-clear-waypoints" @click="clearWaypoints" :disabled="waypointCount === 0">
            清空
          </button>
        </div>
      </div>

      <!-- 操作提示 -->
      <div v-if="isNavigating && !isSettingPose" class="nav-hint goal-hint" style="margin-top:4px">
        {{ multiPointMode ? '双击地图连续添加航点，系统将自动依次执行' : '双击地图设定导航目标点' }}
      </div>
      <div v-if="isSettingPose" class="nav-hint pose-hint">
        🟡 按住地图拖动以设定位置和朝向
      </div>

      <NavigationPresets :map-path="selectedMap" :is-navigating="isNavigating"
        :is-picking="isPickingPreset" :picked-pose="pickedPresetPose"
        @pick="pickPreset" @external-goal="externalGoal" />
      <!-- 错误信息 -->
      <div v-if="errorMsg" class="error-message mt-2">
        {{ errorMsg }}
      </div>
    </div>
  </div>

  <Teleport to="body">
    <dialog ref="navigationDialog" class="drive-dialog" aria-labelledby="drive-dialog-title"
      @cancel="onDialogCancel" @keydown.stop @keyup.stop>
      <h2 id="drive-dialog-title" class="drive-dialog-title">选择导航方式</h2>
      <p class="drive-dialog-hint">选择导航方式和底盘，启动后设置初始位置。</p>
      <fieldset class="engine-options" :disabled="isLoading">
        <legend>导航方式</legend>
        <label v-for="engine in engines" :key="engine.id" class="engine-option" :class="{ selected: selectedEngine === engine.id }">
          <input type="radio" name="navigation-engine" v-model="selectedEngine" :value="engine.id" :disabled="!engine.available" />
          <span><strong>{{ engine.label }}</strong><small>{{ engine.available ? engine.description : '暂未配置' }}</small></span>
        </label>
      </fieldset>
      <fieldset class="engine-options" :disabled="isLoading">
        <legend>底盘类型</legend>
        <label class="engine-option" :class="{ selected: selectedDriveType === 'diff' }">
          <input type="radio" name="navigation-drive" value="diff" v-model="selectedDriveType" />差速轮
        </label>
        <label class="engine-option" :class="{ selected: selectedDriveType === 'omni' }">
          <input type="radio" name="navigation-drive" value="omni" v-model="selectedDriveType" />麦克纳姆轮（全向轮）
        </label>
      </fieldset>
      <p v-if="dialogError" class="error-message" role="alert">{{ dialogError }}</p>
      <div class="dialog-actions">
        <button class="drive-dialog-cancel" :disabled="isLoading" @click="navigationDialog.close()">取消</button>
        <button class="btn btn-connect" :disabled="isLoading || !selectedAvailable" @click="startNavigation">
          {{ isLoading ? '正在启动...' : '开始导航' }}
        </button>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import NavigationPresets from './NavigationPresets.vue'

const props = defineProps({
  connected: Boolean,
  isPickingPreset: Boolean,
  pickedPresetPose: Object,
  multiPointMode: {
    type: Boolean,
    default: false
  },
  waypointCount: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits([
  'update:isNavigating',
  'update:isSettingPose',
  'update:multiPointMode',
  'navigationStarted', 'navigationEngine', 'dialogOpened',
  'clear-waypoints', 'pick-preset', 'external-goal'
])

const isNavigating = ref(false)
const isLoading = ref(false)
const errorMsg = ref('')
const maps = ref([])
const selectedMap = ref('')
const isSettingPose = ref(false)
const multiPointMode = ref(props.multiPointMode)
const navigationDialog = ref(null)
const selectedEngine = ref('lite')
const selectedDriveType = ref('diff')
const activeLabel = ref('')
const engines = ref([])
const dialogError = ref('')
const selectedAvailable = computed(() => engines.value.some(e => e.id === selectedEngine.value && e.available))
let revision = 0
let statusPending = false
function updateStatus(data) {
  isNavigating.value = Boolean(data.isRunning)
  activeLabel.value = data.label || data.engine || ''
  if (data.isRunning && data.mapPath) selectedMap.value = data.mapPath
  if (data.isRunning && data.engine) emit('navigationEngine', data.engine)
  emit('update:isNavigating', isNavigating.value)
  if (data.error) errorMsg.value = data.error
}
function onDialogCancel(event) { if (isLoading.value) event.preventDefault() }


const API_BASE = `http://${window.location.hostname}:3000/api`
let statusTimer = null

async function loadMaps() {
  isLoading.value = true
  try {
    const res = await fetch(`${API_BASE}/list_maps`)
    const data = await res.json()
    maps.value = data.maps || []
    if (maps.value.length > 0 && !selectedMap.value) {
      // 自动选择最新的地图（最后一个，按字母排序，时间戳格式会是最新的）
      selectedMap.value = maps.value[maps.value.length - 1].path
    }
  } catch (err) {
    console.error('加载地图列表失败:', err)
    errorMsg.value = '无法加载地图列表'
  } finally {
    isLoading.value = false
  }
}

async function checkStatus() {
  if (isLoading.value || statusPending) return
  const generation = revision
  statusPending = true
  try {
    const res = await fetch(`${API_BASE}/navigation_status`)
    if (!res.ok) throw new Error('获取导航状态失败')
    const data = await res.json()
    if (generation === revision && !isLoading.value) updateStatus(data)
  } catch (err) { console.error(err) }
  finally { statusPending = false }
}

async function openDriveTypeDialog() {
  if (!selectedMap.value || isLoading.value) return
  errorMsg.value = ''; dialogError.value = ''
  emit('dialogOpened')
  navigationDialog.value.showModal()
  try {
    const response = await fetch(`${API_BASE}/navigation_engines`)
    if (!response.ok) throw new Error('无法加载导航选项')
    const data = await response.json()
    engines.value = data.engines
    if (!selectedAvailable.value) selectedEngine.value = data.defaultEngine
  } catch (err) { dialogError.value = err.message }
}

async function startNavigation() {
  if (isLoading.value || !selectedAvailable.value) return
  isLoading.value = true; revision++; dialogError.value = ''; errorMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/start_navigation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapPath: selectedMap.value, driveType: selectedDriveType.value, engine: selectedEngine.value })
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '启动失败')
    updateStatus(data)
    navigationDialog.value.close()
    emit('navigationStarted')
  } catch (err) { dialogError.value = err.message || '无法连接到本地控制服务' }
  finally { isLoading.value = false }
}

function exitNavigationModes() {
  if (isSettingPose.value) {
    isSettingPose.value = false
    emit('update:isSettingPose', false)
  }
  if (multiPointMode.value) {
    multiPointMode.value = false
    emit('update:multiPointMode', false)
  }
  emit('clear-waypoints')
}

async function shutdownNavigation() {
  if (isLoading.value) return
  revision++
  isLoading.value = true
  errorMsg.value = ''
  exitNavigationModes()
  try {
    const res = await fetch(`${API_BASE}/stop_navigation`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      updateStatus(data)
    } else {
      errorMsg.value = data.error || '关闭失败'
    }
  } catch (err) {
    errorMsg.value = '无法连接到本地控制服务'
  } finally {
    isLoading.value = false
  }
}

function pickPreset(enabled) {
  if (enabled) exitNavigationModes()
  emit('pick-preset', enabled)
}
function externalGoal() { exitNavigationModes(); emit('external-goal') }

function togglePoseMode() {
  emit('pick-preset', false)
  isSettingPose.value = !isSettingPose.value
  emit('update:isSettingPose', isSettingPose.value)
}

function toggleMultiPointMode() {
  emit('pick-preset', false)
  multiPointMode.value = !multiPointMode.value
  emit('update:multiPointMode', multiPointMode.value)
  if (!multiPointMode.value) {
    emit('clear-waypoints')
  }
}

function clearWaypoints() {
  emit('clear-waypoints')
}

watch(() => props.multiPointMode, (value) => {
  multiPointMode.value = value
})

watch(() => props.connected, value => { if (!value) navigationDialog.value?.close() })
onMounted(async () => {
  await loadMaps()
  await checkStatus()
  statusTimer = setInterval(checkStatus, 3000)
})

onUnmounted(() => {
  revision++
  if (statusTimer) clearInterval(statusTimer)
})
</script>

<style scoped>
.nav-section {
  margin-bottom: 12px;
}

.nav-label {
  display: block;
  font-size: 0.78rem;
  color: var(--text-muted);
  text-transform: uppercase;
    margin-bottom: 6px;
}

.map-select-group {
  display: flex;
  gap: 6px;
  align-items: center;
}

.map-select {
  flex: 1;
  padding: 8px 10px;
  background: #ffffff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  outline: none;
  cursor: pointer;
  transition: var(--transition);
}

.map-select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.map-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.map-select option {
  background: #ffffff;
  color: #0f172a;
}

.btn-icon {
  width: 34px;
  height: 34px;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: var(--transition);
  flex-shrink: 0;
}

.btn-icon:hover {
  background: rgba(99, 102, 241, 0.2);
  color: var(--text-primary);
}

.refresh-icon {
  display: inline-block;
  transition: transform 0.5s ease;
}

.refresh-icon.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.nav-btn {
  width: 100%;
  font-weight: 600;
  padding: 12px;
}

.nav-status {
  margin-top: 4px;
  font-size: 0.82rem;
}

.status-nav-active {
  color: #15803d;
}

.status-nav-idle {
  color: #64748b;
}

.nav-hint {
  margin-top: 6px;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.goal-hint {
  color: #2563eb;
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.2);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}

.pose-hint {
  color: #b45309;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.25);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}

.btn-pose {
  width: 100%;
  padding: 10px;
  font-weight: 600;
  font-size: 0.82rem;
  background: rgba(251, 191, 36, 0.1);
  border: 1px solid rgba(251, 191, 36, 0.3);
  color: #b45309;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: var(--transition);
}

.btn-pose:hover {
  background: rgba(251, 191, 36, 0.2);
}

.btn-pose-active {
  width: 100%;
  padding: 10px;
  font-weight: 600;
  font-size: 0.82rem;
  background: rgba(251, 191, 36, 0.25);
  border: 1px solid #d97706;
  color: #b45309;
  border-radius: var(--radius-sm);
  cursor: pointer;
  animation: pose-pulse 1.2s ease-in-out infinite;
}

.btn-waypoint {
  width: 100%;
  padding: 10px;
  font-weight: 600;
  font-size: 0.82rem;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.35);
  color: #15803d;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: var(--transition);
}

.btn-waypoint:hover {
  background: rgba(34, 197, 94, 0.2);
}

.btn-waypoint-active {
  width: 100%;
  padding: 10px;
  font-weight: 600;
  font-size: 0.82rem;
  background: rgba(34, 197, 94, 0.25);
  border: 1px solid #16a34a;
  color: #15803d;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.waypoint-row {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.waypoint-count {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.btn-clear-waypoints {
  padding: 4px 10px;
  font-size: 0.75rem;
  border-radius: 6px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.15);
  color: #dc2626;
  cursor: pointer;
}

.btn-clear-waypoints:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@keyframes pose-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(251, 191, 36, 0); }
}

.mt-2 { margin-top: 8px; }

.drive-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.58);
  backdrop-filter: blur(4px);
}

.nav-action-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}


.drive-dialog {
  position: fixed; inset: 0; margin: auto; max-height: calc(100dvh - 32px); overflow-y: auto;
  width: min(440px, 100%);
  padding: 22px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.28);
}

.drive-dialog-title {
  color: #0f172a;
  font-size: 1.12rem;
  font-weight: 700;
}

.drive-dialog-hint {
  margin-top: 6px;
  color: #64748b;
  font-size: 0.82rem;
  line-height: 1.5;
}

.drive-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.drive-option {
  display: flex;
  min-height: 108px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 7px;
  padding: 16px;
  border: 1px solid transparent;
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}

.drive-option:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
}

.drive-option-diff {
  color: #9a3412;
  border-color: rgba(249, 115, 22, 0.3);
  background: rgba(255, 237, 213, 0.72);
}

.drive-option-omni {
  color: #1d4ed8;
  border-color: rgba(59, 130, 246, 0.3);
  background: rgba(219, 234, 254, 0.72);
}

.drive-option-title {
  font-size: 1rem;
  font-weight: 700;
}

.drive-option-description {
  color: #475569;
  font-size: 0.78rem;
  line-height: 1.45;
}

.drive-dialog-cancel {
  width: 100%;
  margin-top: 14px;
  padding: 9px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  color: #475569;
  background: #f8fafc;
  cursor: pointer;
}

@media (max-width: 480px) {
  .drive-options {
    grid-template-columns: 1fr;
  }

  .drive-option {
    min-height: 86px;
  }
}

.drive-dialog::backdrop { background: #0f172a88; }
.engine-options { border: 0; padding: 0; margin: 18px 0 0; min-width: 0; display: grid; gap: 8px; }
.engine-options legend { font-size: .85rem; color: #475569; padding-bottom: 8px; }
.engine-option { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; cursor: pointer; }
.engine-option.selected { border-color: #6366f1; background: #eff6ff; }
.engine-option input { accent-color: #6366f1; }
.engine-option strong, .engine-option small { display: block; }
.engine-option small { margin-top: 5px; color: #64748b; line-height: 1.5; }
.dialog-actions { display: flex; gap: 12px; margin-top: 18px; }
.dialog-actions button { width: 50%; margin: 0; }
</style>
