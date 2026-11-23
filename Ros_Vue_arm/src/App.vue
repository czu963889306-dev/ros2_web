<template>
  <div class="console-layout">
    <!-- 顶部导航栏 -->
    <header class="console-header" :inert="drawerOverMap">
      <div class="console-identity">
        <h1>出云中控台</h1>
        <span class="host-name" :title="hostname">主机名 <strong>{{ hostname || '—' }}</strong></span>
        <RosDomainSettings :current="systemStatus?.ros_domain_id" @open="stopKeyboardControl" />
      </div>
      <div class="header-controls">
        <WifiSettings @open="stopKeyboardControl" />
        <SystemResources @status="onSystemStatus" />
        <BatteryStatus compact :data="batteryData" :received-at="batteryReceivedAt" :connected="isConnected" />
        <ModelSettings @open="stopKeyboardControl" />
        <VoiceSettings @open="stopKeyboardControl" />
        <button type="button" ref="rqtTrigger" class="rqt-trigger" aria-haspopup="dialog" :aria-expanded="rqtOpen" aria-controls="rqt-window" @click="openRqt">ROS工具箱</button>
        <RqtToolbox v-if="rqtOpen" ref="rqtToolbox" @engage="stopActiveDrive" @close="closeRqt" />
        <ServiceManager @open="stopKeyboardControl" />
      <div class="status-indicator">
        <span class="status-dot" :class="connectionState"></span>
        <span>{{ statusText }}</span>
      </div>
      </div>
    </header>

    <!-- 主体三栏布局 -->
    <main class="console-body" :class="{ 'controls-closed': !controlsOpen }">
      <!-- 左栏: 键盘控制 -->
      <section class="left-panel" :inert="drawerOverMap">
        <KeyboardControl
          :max-linear-speed="maxLinearVelocity"
          :max-angular-speed="maxAngularVelocity"
          @speed-settings-change="onSpeedSettingsChange"
        />

        <CameraView
          :default-url="cameraStreamUrl"
          :discovery-url="`${API_BASE}/camera/streams`"
        />
      </section>

      <!-- 中栏: 地图 -->
      <section class="center-panel" :inert="drawerOverMap">
        <div class="map-toolbar">
          <div class="map-view-switch" role="group" aria-label="地图视图">
            <button type="button" :aria-pressed="mapView === '2d'" @click="mapView = '2d'">二维地图</button>
            <button type="button" :aria-pressed="mapView === '3d'" @click="mapView = '3d'">三维地图</button>
          </div>
          <button type="button" class="displays-toggle" aria-controls="map-displays" :aria-expanded="displaysOpen" @click="displaysOpen = !displaysOpen">显示项</button>
          <PeripheralStatus
            :cameras="systemStatus?.cameras ?? null"
            :voice-online="systemStatus?.voice_online ?? null"
            :board-received-at="Math.max(batteryReceivedAt, controllerReceivedAt)"
            :ros-connected="isConnected"
          />
        </div>
        <div ref="mapWorkspace" class="rv-workspace" :class="{ 'panel-open': displaysOpen, 'panel-dragging': panelDragging }"
          :style="displayWidth ? { '--display-width': displayWidth + 'px' } : {}">
          <div id="map-displays" class="display-shell" :inert="!displaysOpen" :aria-hidden="!displaysOpen">
          <MapDisplays :fixed-frame="fixedFrame" :frame-names="frameNames" @fixed-frame="selectFrame" :particle-count="particleCloud?.count" :rows="displayRows" :view="mapView" :model-status="modelError || (modelBusy ? '正在切换整机型号…' : modelStatus)" :model-source="modelSelection" :model-busy="modelBusy" :robot-variants="robotVariants" @model-source="changeRobotModel" @select="selectTopic"
            @toggle="(id, enabled) => mapLayers[id] = enabled" />
          </div>
          <div class="display-divider" role="separator" aria-orientation="vertical" aria-label="调整显示项宽度"
            aria-controls="map-displays" aria-valuemin="0" :aria-valuemax="panelMaxWidth" :aria-valuenow="displaysOpen ? panelActualWidth : 0"
            tabindex="0" title="拖动调整显示项宽度" @pointerdown="startPanelDrag" @pointermove="movePanelDrag"
            @pointerup="endPanelDrag" @pointercancel="endPanelDrag" @lostpointercapture="endPanelDrag" @keydown="panelKey"></div>
          <div class="rv-viewport">
        <PointCloudMap v-if="mapView === '3d'" :key="mapSession" :session="mapSession" :cloud="cloudMap || savedSessionCloud" :pose="robotPose3d || savedSessionPose" :historical="!!savedSessionCloud && !cloudMap" :connected="isConnected"
          :model="robotModel" :arm-positions="armPositions" :arm-status="armStatus" :frames="frames" :frame-revision="frameRevision" :fixed-frame="fixedFrame" :grid-visible="mapLayers.grid" :cloud-visible="mapLayers.cloud" :pose-visible="mapLayers.pose3d"
          :cloud-topic="selectedCloudTopic" :mapping="mappingAlgorithm === 'rtabmap_3d'" />
        <SlamMap v-show="mapView === '2d'"
          ref="slamMapRef"
          :connected="isConnected"
          :mapData="mapData" :model="robotModel" :arm-positions="armPositions" :arm-status="armStatus" :active-view="mapView === '2d'"
          :particles="particleCloud" :clear-ready="foxglove.costmapsReady.value" :clear-costmaps="foxglove.clearCostmaps"
          :costmapData="costmapData" :costmap-topic="topicOverrides.costmap || runtimeTopics.costmap"
          :scanData="scanData"
          :frames="frames" :frame-revision="frameRevision" :fixed-frame="fixedFrame" :external-goal="externalGoal" :navigation-tf="!topicOverrides.robot || topicOverrides.robot === runtimeTopics.tf"
          :planData="planData"
          :layers="mapLayers"
          :isMapping="mappingActive && mappingAlgorithm !== 'rtabmap_3d'"
          :isNavigating="navigationActive"
          v-model:poseTool="mapTool"
          :multiPointMode="multiPointMode"
          :waypoints="waypointQueue"
          :activeWaypoint="activeWaypoint"
          :navFeedback="navFeedback"
          @preset-selected="onPresetSelected"
          @goal-set="sendGoalPose"
          @waypoint-add="onWaypointAdd"
          @waypoint-reached="onWaypointReached"
          @initial-pose-set="onInitialPoseSet"
        />
          </div>
        </div>
      </section>

      <div v-if="drawerOverMap" class="drawer-backdrop" aria-hidden="true" @click="setControlsOpen(false)"></div>
      <aside class="control-drawer" aria-label="设备控制栏" @keydown.esc="closeDrawerOnEscape">
        <button ref="drawerToggle" type="button" class="drawer-tab" aria-controls="device-controls"
          :aria-expanded="controlsOpen" :aria-label="drawerLabel" :title="drawerLabel"
          @click="setControlsOpen(!controlsOpen)">
          <span class="drawer-chevron" aria-hidden="true"></span>
          <span>控制栏</span>
        </button>
        <div class="drawer-clip" :inert="!controlsOpen" :aria-hidden="!controlsOpen">
          <section id="device-controls" class="right-panel" aria-label="连接与设备控制">
            <ConnectionPanel
              :connectionState="connectionState"
              :errorMessage="errorMessage"
              @connect="handleConnect"
              @disconnect="handleDisconnect"
            />

            <BatteryStatus :data="batteryData" :received-at="batteryReceivedAt" :connected="isConnected" />

            <TelemetryPanel
              v-if="isConnected"
              :odomData="odomData"
            />

            <ArmControl
              :connected="isConnected"
              :servo-ready="servoReady"
              @servo-command="onServoCommand"
              @home-command="onArmHome"
            />

            <MappingControl
              :connected="isConnected"
              v-model:isMapping="mappingActive"
              @algorithm="setMappingAlgorithm"
              @mappingStarted="onMappingStarted"
              @dialogOpened="stopKeyboardControl"
            />

            <NavigationControl
              @dialog-opened="stopKeyboardControl"
              @navigation-engine="onNavigationEngine"
              :isPickingPreset="mapTool === 'preset'"
              :pickedPresetPose="pickedPresetPose"
              @pick-preset="selectMapMode('preset', $event)"
              @external-goal="onExternalGoal"
              :connected="isConnected"
              v-model:isNavigating="navigationActive"
              :isSettingPose="mapTool === 'initial'"
              @update:isSettingPose="selectMapMode('initial', $event)"
              v-model:multiPointMode="multiPointMode"
              :waypointCount="waypointQueue.length + (activeWaypoint ? 1 : 0)"
              @navigation-stop-requested="onNavigationStopRequested"
              @clear-waypoints="clearWaypoints"
            />
          </section>
        </div>
      </aside>
    </main>
  </div>
</template>

<script setup>
import { ref, shallowRef, defineAsyncComponent, nextTick, computed, watch, onMounted, onUnmounted } from 'vue'
import { useFoxglove } from './composables/useFoxglove.js'
import { useMapDisplays } from './composables/mapDisplays.js'
import { robotVariants, useRobotDisplayModel, modelStaticTopic, readModelSnapshot } from './composables/robotDisplayModel.js'
import { ModelFrames, normalizeFrame } from './composables/displayFrames.js'
import MapDisplays from './components/MapDisplays.vue'
import KeyboardControl from './components/KeyboardControl.vue'
import SlamMap from './components/SlamMap.vue'
import ConnectionPanel from './components/ConnectionPanel.vue'
import TelemetryPanel from './components/TelemetryPanel.vue'
import MappingControl from './components/MappingControl.vue'
import NavigationControl from './components/NavigationControl.vue'
import CameraView from './components/CameraView.vue'
import ArmControl from './components/ArmControl.vue'
import ModelSettings from './components/ModelSettings.vue'
import VoiceSettings from './components/VoiceSettings.vue'
import ServiceManager from './components/ServiceManager.vue'
import BatteryStatus from './components/BatteryStatus.vue'
import SystemResources from './components/SystemResources.vue'
import PeripheralStatus from './components/PeripheralStatus.vue'
import RosDomainSettings from './components/RosDomainSettings.vue'
import WifiSettings from './components/WifiSettings.vue'

const RqtToolbox = defineAsyncComponent(() => import('./components/RqtToolbox.vue'))
const rqtOpen = ref(false), rqtToolbox = ref(null), rqtTrigger = ref(null)
function stopActiveDrive() {
  if (keyboardInterval) stopKeyboardControl()
}
function openRqt() {
  stopActiveDrive()
  if (rqtOpen.value) rqtToolbox.value?.reveal()
  else rqtOpen.value = true
}
function closeRqt() {
  rqtOpen.value = false
  nextTick(() => rqtTrigger.value?.focus({ preventScroll:true }))
}
const PointCloudMap = defineAsyncComponent(() => import('./components/PointCloudMap.vue'))
const foxglove = useFoxglove()
const mapView = ref('2d')
const displaysOpen = ref(window.innerWidth >= 1200)
const mapWorkspace = ref(null)
const displayWidth = ref(0)
const panelActualWidth = ref(0)
const panelDragging = ref(false)
const panelMaxWidth = ref(420)
let panelObserver
onMounted(() => {
  const box = mapWorkspace.value
  const panel = box.querySelector('.display-shell')
  panelObserver = new ResizeObserver(() => {
    panelMaxWidth.value = Math.max(56, Math.min(420, box.clientWidth - 36))
    panelActualWidth.value = Math.round(panel.getBoundingClientRect().width)
  })
  panelObserver.observe(box)
  panelObserver.observe(panel)
})
onUnmounted(() => panelObserver?.disconnect())
let drag = null
function resizePanel(value) {
  const width = Math.round(Math.min(panelMaxWidth.value, Math.max(0, value)))
  displaysOpen.value = width >= 56
  if (displaysOpen.value) displayWidth.value = width
}
function startPanelDrag(e) {
  if (e.button !== 0 || drag) return
  const box = mapWorkspace.value
  panelMaxWidth.value = Math.max(56, Math.min(420, box.clientWidth - 36))
  drag = { id:e.pointerId, x:e.clientX, width:box.querySelector('.display-shell').getBoundingClientRect().width, previous:displayWidth.value }
  panelDragging.value = true
  e.currentTarget.setPointerCapture(e.pointerId)
}
function movePanelDrag(e) {
  if (drag?.id === e.pointerId) resizePanel(drag.width + e.clientX - drag.x)
}
function endPanelDrag(e) {
  if (drag?.id !== e.pointerId) return
  if (!displaysOpen.value) displayWidth.value = drag.previous
  else if (displayWidth.value > 0 && displayWidth.value < 160) displayWidth.value = Math.min(panelMaxWidth.value,160)
  drag = null
  panelDragging.value = false
  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
}
function panelKey(e) {
  const width = mapWorkspace.value.querySelector('.display-shell').getBoundingClientRect().width
  panelMaxWidth.value = Math.max(56, Math.min(420, mapWorkspace.value.clientWidth - 36))
  if (e.key === 'Home') resizePanel(0)
  else if (e.key === 'End') resizePanel(panelMaxWidth.value)
  else if (e.key === 'ArrowLeft') resizePanel(width <= 160 ? 0 : width - 24)
  else if (e.key === 'ArrowRight') resizePanel(width ? width + 24 : 160)
  else return
  e.preventDefault()
  e.stopPropagation()
}
const drawerMedia = window.matchMedia('(max-width: 800px)')
const compactDrawer = ref(drawerMedia.matches)
const drawerToggle = ref(null)
function drawerStorageKey() {
  return 'robot-console.controls.' + (compactDrawer.value ? 'compact' : 'desktop')
}
function loadDrawerPreference() {
  try {
    const saved = localStorage.getItem(drawerStorageKey())
    if (saved !== null) return saved === 'open'
  } catch { /* Use the layout default when storage is unavailable. */ }
  return !compactDrawer.value
}
const controlsOpen = ref(loadDrawerPreference())
const drawerOverMap = computed(() => compactDrawer.value && controlsOpen.value)
const drawerLabel = computed(() => controlsOpen.value ? '收起控制栏' : '展开控制栏')
function setControlsOpen(open) {
  controlsOpen.value = open
  try { localStorage.setItem(drawerStorageKey(), open ? 'open' : 'closed') } catch { /* optional */ }
  drawerToggle.value?.focus({ preventScroll:true })
}
function closeDrawerOnEscape(event) {
  if (!controlsOpen.value || event.defaultPrevented) return
  event.stopPropagation()
  setControlsOpen(false)
}
function onDrawerLayoutChange(event) {
  compactDrawer.value = event.matches
  controlsOpen.value = loadDrawerPreference()
}
onMounted(() => {
  drawerMedia.addEventListener('change', onDrawerLayoutChange)
  if (drawerOverMap.value) drawerToggle.value?.focus({ preventScroll:true })
})
onUnmounted(() => drawerMedia.removeEventListener('change', onDrawerLayoutChange))
const cloudMap = shallowRef(null)
const robotPose3d = shallowRef(null)
const mappingAlgorithm = ref(null)
const mapSession = ref(null)
const sessionCloud = shallowRef(null)
const sessionPose = shallowRef(null)
function setMappingAlgorithm(id, session) {
  if (id === mappingAlgorithm.value && session === mapSession.value) return
  if (session !== mapSession.value) {
    sessionCloud.value = null
    sessionPose.value = null
    cloudMap.value = null
    robotPose3d.value = null
  }
  mapSession.value = session
  mappingAlgorithm.value = id
  if (id === 'rtabmap_3d') {
    cloudMap.value = null
    robotPose3d.value = null
    mapView.value = '3d'
  } else if (id) mapView.value = '2d'
}
const slamMapRef = ref(null)
const API_BASE = `http://${window.location.hostname}:3000/api`
const DEFAULT_WS_URL = `ws://${window.location.hostname}:8765`
let connectRetryTimer = null

const TOPIC_DEFAULTS = {
  cmd_vel: '/cmd_vel',
  battery_state: '/battery_state',
  controller_odom: '/odom',
  servo_cmd: '/servo_cmd',
  robot_description: '/robot_description',
  map: '/map',
  costmap: '/global_costmap/costmap',
  particle_cloud: '/particle_cloud',
  scan: '/scan',
  cloud: '/mapping_3d/cloud_map',
  pose3d: '/mapping_3d/robot_pose',
  tf_static: '/tf_static',
  tf: '/web/tf',
  odom: '/web/odometry/filtered',
  plan: '/plan',
  goal_pose: '/goal_pose',
  initial_pose: '/initialpose',
  cancel_navigation: '/lite_navigation/cancel',
  navigate_feedback: '/lite_navigation/feedback'
}

// ---- 建图状态 (跨组件共享) ----
const mappingActive = ref(false)

// ---- 导航状态 ----
const navigationActive = ref(false)
const mapTool = ref('')
const multiPointMode = ref(false)
const waypointQueue = ref([])
const activeWaypoint = ref(null)
const waypointAdvancing = ref(false)
const FEEDBACK_REACHED_THRESHOLD = 0.10

// ---- 状态 ----
const mapData = shallowRef(null)
const costmapData = shallowRef(null)
const particleCloud = shallowRef(null)
const scanData = shallowRef(null)
const frames = new ModelFrames()
const frameRevision = ref(0)
const frameNames = shallowRef([])
const fixedFrame = ref('')
const frameKey = 'robot-console.map.fixed-frame.v1'
try { fixedFrame.value = normalizeFrame(localStorage.getItem(frameKey)) } catch {}
function selectFrame(name) {
  fixedFrame.value = normalizeFrame(name)
  try { localStorage.setItem(frameKey, fixedFrame.value) } catch {}
}
function receiveFrames(kind, data, snapshot=false) {
  if (frames.update(kind, data, snapshot)) frameNames.value = frames.names()
  frameRevision.value++
}
const externalGoal = shallowRef(null)
const odomData = ref(null)
const batteryData = ref(null)
const batteryReceivedAt = ref(0)
const controllerReceivedAt = ref(0)
const systemStatus = shallowRef(null)
const hostname = ref('')
const modelRevision=ref('')
const boardModel=ref(null),requestedModel=ref(''),modelError=ref('')
const modelBusy=computed(()=>!!requestedModel.value||!!boardModel.value?.pending)
const modelSelection=computed(()=>requestedModel.value||boardModel.value?.pending||boardModel.value?.model||'')
function syncBoardModel(state){
  boardModel.value=state
  if(state && !state.pending)modelRevision.value=state.revision
}
async function changeRobotModel(target){
  if(modelBusy.value||!boardModel.value||!robotVariants.includes(target))return
  const expected=boardModel.value.model
  requestedModel.value=target;modelError.value=''
  try{
    const r=await fetch('http://'+location.hostname+':3000/api/robot-model',{
      method:'PUT',headers:{'Content-Type':'application/json','X-Robot-Model':'1'},
      body:JSON.stringify({model:target,expected}),signal:AbortSignal.timeout(90000)
    })
    const data=await r.json()
    if(!r.ok)throw Error(data.error||'切换请求失败')
    selectTopic('model','')
    syncBoardModel(data)
  }catch(e){modelError.value=e.message}
  finally{requestedModel.value=''}
}
function onSystemStatus(value) {
  if(!requestedModel.value)syncBoardModel(value?.robot_model||null)
  systemStatus.value = value
  if (value?.server_time) foxglove.syncDeviceClock(value.server_time)
  if (value?.hostname) hostname.value = value.hostname
}
const planData = shallowRef(null)

// 导航反馈数据
const navFeedback = ref(null)
const runtimeTopics = ref({ ...TOPIC_DEFAULTS })
const cameraStreamUrl = ref(`http://${window.location.hostname}:8080/stream`)

// ================= Foxglove 频道 ID ==================
let cmdVelChannelId = null
let servoChannelId = null
const servoReady = ref(false)
const poseOutputs = {
  initial: { topic: 'initial_pose', schema: 'geometry_msgs/PoseWithCovarianceStamped', channel: null, timer: null },
  goal: { topic: 'goal_pose', schema: 'geometry_msgs/PoseStamped', channel: null, timer: null }
}
let cancelNavigationChannelId = null
let cmdVelReleaseTimer = null
let cancelNavigationReleaseTimer = null

// 订阅 ID
let feedbackSubId = null // 导航反馈订阅 ID

// ---- 计算属性 ----
const connectionState = computed(() => foxglove.connectionState.value)
const errorMessage = computed(() => foxglove.errorMessage.value)
const isConnected = computed(() => connectionState.value === 'connected')

// Follow the advertised channel ID so unplugging and reconnecting the board can
// create a new subscription without reconnecting the entire console.
function watchTelemetry(topicKey, onMessage, onReset) {
  const topic = () => topicKey === 'tf_static' && runtimeTopics.value[topicKey] === '/tf_static'
    ? modelStaticTopic : runtimeTopics.value[topicKey]
  watch([topic, () => isConnected.value ? foxglove.findChannelByTopic(topic()) : null,
    () => topicKey === 'tf_static' ? modelRevision.value : null],
    ([name, channel], _previous, onCleanup) => {
      onReset()
      if (channel === null) return
      const id = foxglove.subscribe(name, data => {
        if(name===modelStaticTopic){
          data=readModelSnapshot(data,modelRevision.value)
          if(!Array.isArray(data?.transforms))return
        }
        onMessage(data)
      })
      if (id !== null) onCleanup(() => { if (isConnected.value) foxglove.unsubscribe(id) })
    })
}
watchTelemetry('battery_state', data => {
  if (!data || typeof data !== 'object') return
  batteryData.value = data
  batteryReceivedAt.value = Date.now()
}, () => {
  batteryData.value = null
  batteryReceivedAt.value = 0
})
watchTelemetry('controller_odom', data => {
  if (!data?.pose?.pose || !data?.twist?.twist) return
  const receivedAt = Date.now()
  if (receivedAt - controllerReceivedAt.value >= 500) controllerReceivedAt.value = receivedAt
}, () => { controllerReceivedAt.value = 0 })

watchTelemetry('tf_static', data => receiveFrames('fixed', data,
  !!modelRevision.value && runtimeTopics.value.tf_static === '/tf_static'), () => receiveFrames('fixed', null))
watchTelemetry('odom', data => { odomData.value = data }, () => { odomData.value = null })

function accepts3d(msg, key, selection) {
  if (!msg || mappingAlgorithm.value !== 'rtabmap_3d' || selection !== runtimeTopics.value[key]) return true
  const started = Number(mapSession.value?.split('-')[0])
  return !started || msg.stamp >= started
}
const { model: robotModel, status: modelStatus, receive: receiveDescription, bind: bindModel } = useRobotDisplayModel()
const { enabled: mapLayers, rows: displayRows, select: selectTopic, overrides: topicOverrides } =
  useMapDisplays(foxglove, runtimeTopics, isConnected, mapView, {
    model: receiveDescription,
    map: data => { mapData.value = data },
    costmap: data => { costmapData.value = data },
    particles: data => { particleCloud.value = data },
    scan: data => { scanData.value = data },
    robot: (data,topic) => receiveFrames('dynamic', data, topic === '/web/tf'),
    path: data => { planData.value = data },
    goal: data => { externalGoal.value = data },
    cloud: data => {
      if (data && !accepts3d(data, 'cloud', selectedCloudTopic.value)) return false
      cloudMap.value = data
      if (data && mappingAlgorithm.value === 'rtabmap_3d' && selectedCloudTopic.value === runtimeTopics.value.cloud) sessionCloud.value = data
    },
    pose3d: data => {
      if (data && (!accepts3d(data, 'pose3d', topicOverrides.value.pose3d || runtimeTopics.value.pose3d) ||
          (robotPose3d.value && data.stamp < robotPose3d.value.stamp))) return false
      robotPose3d.value = data ? { ...data, received: performance.now() } : null
      if (data && mappingAlgorithm.value === 'rtabmap_3d' && (!topicOverrides.value.pose3d || topicOverrides.value.pose3d === runtimeTopics.value.pose3d)) sessionPose.value = robotPose3d.value
    }
  }, modelRevision)
bindModel(() => mapLayers.model)
const armPositions = shallowRef(null)
const armStatus = ref('')
const armFeedbackTopic = '/joint_states'
watch(robotModel, model => {
  armPositions.value = null
  armStatus.value = model?.name === 'LEAP_ROS_PRO' ? '等待舵机反馈' : ''
})
watch([robotModel, () => isConnected.value && robotModel.value?.name === 'LEAP_ROS_PRO'
  ? foxglove.findChannelByTopic(armFeedbackTopic) : null], ([model, channel], _, cleanup) => {
  if (model?.name !== 'LEAP_ROS_PRO') return
  if (armPositions.value) armStatus.value = '舵机反馈中断'
  if (channel === null) return
  let timeout
  const sub = foxglove.subscribe(armFeedbackTopic, positions => {
    if (!['joint_1','joint_2','joint_3','joint_4','gripper_drive_left_joint'].every(name => Number.isFinite(positions?.[name]))) return
    if (!armPositions.value || Object.keys(positions).some(name => positions[name] !== armPositions.value[name]))
      armPositions.value = positions
    armStatus.value = '舵机已联动'
    clearTimeout(timeout)
    timeout = setTimeout(() => { armStatus.value = '舵机反馈中断' }, 2000)
  }, channel)
  cleanup(() => {
    clearTimeout(timeout)
    if (sub !== null && isConnected.value) foxglove.unsubscribe(sub)
  })
})

const selectedCloudTopic = computed(() => topicOverrides.value.cloud || runtimeTopics.value.cloud)
const savedSessionCloud = computed(() => isConnected.value && !mappingAlgorithm.value &&
  selectedCloudTopic.value === runtimeTopics.value.cloud ? sessionCloud.value : null)
const savedSessionPose = computed(() => savedSessionCloud.value && (!topicOverrides.value.pose3d ||
  topicOverrides.value.pose3d === runtimeTopics.value.pose3d) ? sessionPose.value : null)
watch(mapView, async view => {
  if (view === '2d') {
    await nextTick()
    window.dispatchEvent(new Event('resize'))
  } else {
    mapTool.value = ''
  }
})

function clearPublisherReleaseTimers() {
  for (const timer of [
    cmdVelReleaseTimer,
    cancelNavigationReleaseTimer
  ]) {
    if (timer) clearTimeout(timer)
  }
  cmdVelReleaseTimer = null
  cancelNavigationReleaseTimer = null
}

function resetChannelHandles() {
  clearPublisherReleaseTimers()
  cmdVelChannelId = null
  servoChannelId = null
  servoReady.value = false
  mapTool.value = ''
  for (const output of Object.values(poseOutputs)) {
    clearTimeout(output.timer)
    output.timer = null
    output.channel = null
  }
  cancelNavigationChannelId = null
  batteryData.value = null
  batteryReceivedAt.value = 0
  feedbackSubId = null
}

// WebSocket 自动重连会创建一个全新的 Foxglove 会话；旧频道 ID 和订阅 ID 均已失效。
watch(connectionState, (state, previousState) => {
  if (state !== 'connected' || previousState !== 'connected') {
    resetChannelHandles()
  }
})

const statusText = computed(() => {
  switch (connectionState.value) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中...'
    case 'error': return '连接错误'
    default: return '未连接'
  }
})

// ---- 事件处理 ----
function handleConnect(url = DEFAULT_WS_URL) {
  if (connectionState.value === 'connected' || connectionState.value === 'connecting') return
  foxglove.connect(url)
}

function onMappingStarted() {
  if (mappingAlgorithm.value === 'rtabmap_3d') return
  // 建图开始时自动重置地图视图
  slamMapRef.value?.resetView()
}

// 清空所有订阅数据
function clearAllData() {
  robotPose3d.value = null
  cloudMap.value = null
  mapData.value = null
  costmapData.value = null
  particleCloud.value = null
  scanData.value = null
  receiveFrames('dynamic', null)
  receiveFrames('fixed', null)
  odomData.value = null
  batteryData.value = null
  batteryReceivedAt.value = 0
  planData.value = null
  navFeedback.value = null // 清除导航反馈数据
  waypointQueue.value = []
  activeWaypoint.value = null
}

function handleDisconnect() {
  foxglove.disconnect()
  resetChannelHandles()
  clearAllData()
}

async function loadRuntimeConfig() {
  try {
    const res = await fetch(`${API_BASE}/runtime_config`)
    const data = await res.json()
    runtimeTopics.value = { ...TOPIC_DEFAULTS, ...(data.topics || {}) }
    onNavigationEngine(navigationEngine.value)
    cameraStreamUrl.value = data.camera?.stream_url || cameraStreamUrl.value
  } catch (err) {
    console.warn('加载运行时配置失败，使用默认话题:', err)
    runtimeTopics.value = { ...TOPIC_DEFAULTS }
  }
}


/**
 * 当服务器广播可用频道后，自动:
 * 订阅机器人状态话题。命令话题的 publisher 在真正发送命令时按需创建。
 */
function onChannelsReady() {

  // 单舵机控制频道
  if (!servoChannelId) {
    servoChannelId = foxglove.clientAdvertise(runtimeTopics.value.servo_cmd, 'geometry_msgs/Vector3', 'json')
    servoReady.value = true
  }

  // 10. 订阅导航反馈 (距离与预计时间)
  if (!feedbackSubId) {
    feedbackSubId = foxglove.subscribe(runtimeTopics.value.navigate_feedback, (data) => {
      navFeedback.value = normalizeNavFeedback(data)
    })
  }

}

const navigationEngine = ref('lite')
function onNavigationEngine(engine) {
  if (!['nav2', 'lite'].includes(engine)) return
  navigationEngine.value = engine
  const feedbackTopic = engine === 'nav2' ? '/navigate_to_pose/_action/feedback' : '/lite_navigation/feedback'
  const cancelTopic = engine === 'nav2' ? '/navigation/cancel' : '/lite_navigation/cancel'
  if (runtimeTopics.value.navigate_feedback !== feedbackTopic) {
    if (feedbackSubId) foxglove.unsubscribe(feedbackSubId)
    feedbackSubId = null
    navFeedback.value = null
    runtimeTopics.value.navigate_feedback = feedbackTopic
    if (isConnected.value) feedbackSubId = foxglove.subscribe(feedbackTopic, data => { navFeedback.value = normalizeNavFeedback(data) })
  }
  if (runtimeTopics.value.cancel_navigation !== cancelTopic) {
    if (cancelNavigationReleaseTimer) clearTimeout(cancelNavigationReleaseTimer)
    if (cancelNavigationChannelId) foxglove.clientUnadvertise(cancelNavigationChannelId)
    cancelNavigationChannelId = null
    runtimeTopics.value.cancel_navigation = cancelTopic
  }
}

function normalizeNavFeedback(data) {
  if (!data || typeof data !== 'object') return null

  // 轻量导航节点使用 std_msgs/Float32 发布剩余距离
  if (Number.isFinite(data.data)) {
    return {
      distance_remaining: data.data,
      estimated_time_remaining: { sec: 0, nanosec: 0 }
    }
  }

  // 已解析扁平结构
  if (typeof data.distance_remaining === 'number' || data.estimated_time_remaining) {
    const eta = data.estimated_time_remaining || {}
    return {
      distance_remaining: Number.isFinite(data.distance_remaining) ? data.distance_remaining : null,
      estimated_time_remaining: {
        sec: Number.isFinite(eta.sec) ? eta.sec : 0,
        nanosec: Number.isFinite(eta.nanosec) ? eta.nanosec : (Number.isFinite(eta.nsec) ? eta.nsec : 0)
      }
    }
  }

  // action 标准结构: { feedback: { distance_remaining, estimated_time_remaining } }
  if (data.feedback && typeof data.feedback === 'object') {
    const eta = data.feedback.estimated_time_remaining || {}
    return {
      distance_remaining: Number.isFinite(data.feedback.distance_remaining) ? data.feedback.distance_remaining : null,
      estimated_time_remaining: {
        sec: Number.isFinite(eta.sec) ? eta.sec : 0,
        nanosec: Number.isFinite(eta.nanosec) ? eta.nanosec : (Number.isFinite(eta.nsec) ? eta.nsec : 0)
      }
    }
  }

  return null
}

// 监听频道就绪事件
window.addEventListener('foxglove:channels', onChannelsReady)
window.addEventListener('foxglove:channels_update', onChannelsReady)
onUnmounted(() => {
  window.removeEventListener('foxglove:channels', onChannelsReady)
  window.removeEventListener('foxglove:channels_update', onChannelsReady)
  handleDisconnect()
})

// ---- 键盘速度变化 → 发送 Twist ----
function ensureCmdVelPublisher() {
  if (!isConnected.value) return null
  if (!cmdVelChannelId) {
    cmdVelChannelId = foxglove.clientAdvertise(runtimeTopics.value.cmd_vel, 'geometry_msgs/Twist', 'json')
  }
  return cmdVelChannelId
}

function releaseCmdVelPublisher(delay = 300) {
  if (cmdVelReleaseTimer) clearTimeout(cmdVelReleaseTimer)
  cmdVelReleaseTimer = setTimeout(() => {
    if (cmdVelChannelId) foxglove.clientUnadvertise(cmdVelChannelId)
    cmdVelChannelId = null
    cmdVelReleaseTimer = null
  }, delay)
}

function publishVelocity(linearX = 0, linearY = 0, angularZ = 0) {
  const channelId = ensureCmdVelPublisher()
  if (!channelId) return
  if (cmdVelReleaseTimer) {
    clearTimeout(cmdVelReleaseTimer)
    cmdVelReleaseTimer = null
  }
  foxglove.sendTwist(channelId, linearX, linearY, angularZ)
  if (linearX === 0 && linearY === 0 && angularZ === 0) {
    releaseCmdVelPublisher()
  }
}


// 点击“停止导航”时：先立即发布零速，再让导航节点清空路径。
// 两条命令都复用已连接的 WebSocket，不再等待 ROS 2 CLI 做 DDS 发现。
function onNavigationStopRequested() {
  publishVelocity(0, 0, 0)
  if (!isConnected.value) return

  if (!cancelNavigationChannelId) {
    cancelNavigationChannelId = foxglove.clientAdvertise(
      runtimeTopics.value.cancel_navigation,
      'std_msgs/Empty',
      'json'
    )
  }
  foxglove.publishMessage(cancelNavigationChannelId, {})

  if (cancelNavigationReleaseTimer) clearTimeout(cancelNavigationReleaseTimer)
  cancelNavigationReleaseTimer = setTimeout(() => {
    if (cancelNavigationChannelId) {
      foxglove.clientUnadvertise(cancelNavigationChannelId)
    }
    cancelNavigationChannelId = null
    cancelNavigationReleaseTimer = null
  }, 300)
}

// ---- 单舵机角度 → /servo_cmd ----
function onServoCommand({ channel, angle }) {
  if (servoChannelId && isConnected.value) {
    foxglove.publishMessage(servoChannelId, {
      x: Number(channel),
      y: Number(angle),
      z: 0.0
    })
  }
}

// ---- 机械臂回正：等待上一个舵机命令被下位机处理后再发下一个 ----
function onArmHome(angles) {
  if (!servoChannelId || !isConnected.value || !Array.isArray(angles)) return

  angles.slice(0, 5).forEach((angle, index) => {
    window.setTimeout(() => {
      if (!servoChannelId || !isConnected.value) return
      foxglove.publishMessage(servoChannelId, {
        x: index + 1,
        y: Number(angle),
        z: 0.0
      })
    }, index * 1200)
  })
}

function selectMapMode(mode, enabled) {
  if (enabled) {
    mapView.value = '2d'
    mapTool.value = mode
  } else if (mapTool.value === mode) mapTool.value = ''
}

function preparePosePublisher(tool) {
  const output = poseOutputs[tool]
  if (!output || !isConnected.value) return null
  clearTimeout(output.timer)
  output.timer = null
  if (output.channel === null) {
    output.channel = foxglove.clientAdvertise(runtimeTopics.value[output.topic], output.schema, 'json')
  }
  return output.channel
}

function releasePosePublisher(tool) {
  const output = poseOutputs[tool]
  if (!output || output.channel === null || mapTool.value === tool) return
  clearTimeout(output.timer)
  output.timer = setTimeout(() => {
    if (output.channel !== null) foxglove.clientUnadvertise(output.channel)
    output.channel = null
    output.timer = null
  }, 300)
}

watch(mapTool, (tool, previous) => {
  releasePosePublisher(previous)
  preparePosePublisher(tool)
  if (tool && drawerOverMap.value) setControlsOpen(false)
})
const pickedPresetPose = ref(null)
function onPresetSelected(pose) { pickedPresetPose.value = pose; mapTool.value = '' }
function onExternalGoal() { multiPointMode.value = false; clearWaypoints(); mapTool.value = '' }

function sendGoalPose({ x, y, yaw, frame }) {
  const id = preparePosePublisher('goal')
  if (id === null) return
  foxglove.sendGoalPose(id, x, y, yaw, frame)
  releasePosePublisher('goal')
}

function dispatchNextWaypoint() {
  if (!multiPointMode.value) return
  if (waypointQueue.value.length === 0) {
    activeWaypoint.value = null
    return
  }
  const next = waypointQueue.value.shift()
  activeWaypoint.value = next
  sendGoalPose(next)
}

function advanceWaypoint() {
  if (!multiPointMode.value || !activeWaypoint.value) return
  if (waypointAdvancing.value) return
  waypointAdvancing.value = true
  setTimeout(() => {
    dispatchNextWaypoint()
    waypointAdvancing.value = false
  }, 200)
}

function onWaypointAdd(pose) {
  if (!multiPointMode.value) return
  waypointQueue.value.push(pose)
  if (!activeWaypoint.value) {
    dispatchNextWaypoint()
  }
}

function clearWaypoints() {
  waypointQueue.value = []
  activeWaypoint.value = null
  waypointAdvancing.value = false
}

function onWaypointReached() {
  advanceWaypoint()
}

// ---- 初始位置设定 ----
function onInitialPoseSet({ x, y, yaw, frame }) {
  const id = preparePosePublisher('initial')
  if (id !== null) foxglove.sendInitialPose(id, x, y, yaw, frame)
}

watch(multiPointMode, (enabled) => {
  if (!enabled) clearWaypoints()
})

watch(navigationActive, (running) => {
  mapTool.value = ''
  if (running) {
    mapView.value = '2d'
    stopKeyboardControl()
    releaseCmdVelPublisher(0)
    slamMapRef.value?.resetView()
  } else {
    clearWaypoints()
  }
})

watch(() => navFeedback.value?.distance_remaining, (distance) => {
  if (!multiPointMode.value || !activeWaypoint.value) return
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return
  if (distance <= FEEDBACK_REACHED_THRESHOLD) {
    advanceWaypoint()
  }
})

// ======================== QWEASD 键盘控制 ========================
const keyboardState = {
  q: false,
  w: false,
  e: false,
  a: false,
  s: false,
  d: false
}
let keyboardInterval = null

const SPEED_SETTINGS_STORAGE_KEY = 'ros2-web-motion-speeds'
const DEFAULT_LINEAR_VEL = 0.15
const DEFAULT_ANGULAR_VEL = 0.8

function clampSpeed(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(0.01, number))
}

function loadSpeedSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SPEED_SETTINGS_STORAGE_KEY) || '{}')
    return {
      linear: clampSpeed(saved.linear, DEFAULT_LINEAR_VEL, 3),
      angular: clampSpeed(saved.angular, DEFAULT_ANGULAR_VEL, 6)
    }
  } catch {
    return { linear: DEFAULT_LINEAR_VEL, angular: DEFAULT_ANGULAR_VEL }
  }
}

const initialSpeedSettings = loadSpeedSettings()
const maxLinearVelocity = ref(initialSpeedSettings.linear)
const maxAngularVelocity = ref(initialSpeedSettings.angular)

function onSpeedSettingsChange({ linear, angular }) {
  stopKeyboardControl()
  maxLinearVelocity.value = clampSpeed(linear, maxLinearVelocity.value, 3)
  maxAngularVelocity.value = clampSpeed(angular, maxAngularVelocity.value, 6)
  localStorage.setItem(SPEED_SETTINGS_STORAGE_KEY, JSON.stringify({
    linear: maxLinearVelocity.value,
    angular: maxAngularVelocity.value
  }))
}

function updateKeyboardControl() {
  if (!isConnected.value) return

  let linearX = 0
  let linearY = 0
  let angularZ = 0

  if (keyboardState.w) linearX += maxLinearVelocity.value
  if (keyboardState.s) linearX -= maxLinearVelocity.value
  if (keyboardState.q) linearY += maxLinearVelocity.value
  if (keyboardState.e) linearY -= maxLinearVelocity.value
  if (keyboardState.a) angularZ += maxAngularVelocity.value
  if (keyboardState.d) angularZ -= maxAngularVelocity.value

  publishVelocity(linearX, linearY, angularZ)
}

function stopKeyboardControl(sendStop = true) {
  keyboardState.q = false
  keyboardState.w = false
  keyboardState.e = false
  keyboardState.a = false
  keyboardState.s = false
  keyboardState.d = false

  if (keyboardInterval) {
    clearInterval(keyboardInterval)
    keyboardInterval = null
  }

  if (sendStop && isConnected.value) {
    publishVelocity(0, 0, 0)
  }
}

const MOVEMENT_KEYS = ['q', 'w', 'e', 'a', 's', 'd']

function isEditableTarget(target) {
  const tagName = target?.tagName
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || target?.isContentEditable
}

watch(drawerOverMap, covered => {
  if (covered && keyboardInterval) stopKeyboardControl()
  if (covered) drawerToggle.value?.focus({ preventScroll:true })
}, { flush:'post' })

function handleKeyDown(e) {
  if (drawerOverMap.value) return
  // 防止在输入框内打字时触发移动
  if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return

  const key = e.key.toLowerCase()
  if (MOVEMENT_KEYS.includes(key)) {
    e.preventDefault()
    if (!keyboardState[key]) {
      keyboardState[key] = true
      
      // 按第一下键时，开启 20Hz 的控制循环
      if (!keyboardInterval) {
        updateKeyboardControl() // 立即发一次
        keyboardInterval = setInterval(updateKeyboardControl, 50)
      }
    }
  }
}

function handleKeyUp(e) {
  if (drawerOverMap.value) return
  const key = e.key.toLowerCase()
  if (MOVEMENT_KEYS.includes(key) && keyboardState[key]) {
    e.preventDefault()
    keyboardState[key] = false
    
    // 如果所有键都松开了，停止循环并发送一次 0 速度
    if (!MOVEMENT_KEYS.some((movementKey) => keyboardState[movementKey])) {
      stopKeyboardControl()
    }
  }
}

function handleWindowBlur() {
  stopKeyboardControl()
}

onMounted(async () => {
  await loadRuntimeConfig()
  handleConnect()
  connectRetryTimer = setInterval(() => {
    if (connectionState.value !== 'connected') {
      handleConnect()
    }
  }, 5000)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('blur', handleWindowBlur)
})

onUnmounted(() => {
  if (connectRetryTimer) {
    clearInterval(connectRetryTimer)
    connectRetryTimer = null
  }
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('blur', handleWindowBlur)
  stopKeyboardControl(false)
})

</script>

<style scoped>
.console-identity { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; margin-right:auto; min-width:0; }
.host-name { font-size:.78rem; color:var(--text-secondary); overflow-wrap:anywhere; }
.host-name strong { color:var(--text-primary); font-family:var(--font-mono); font-weight:600; }
.rqt-trigger { background:#fff; color:#334862; border:1px solid #bdcad8; border-radius:5px; padding:5px 10px; font:inherit; font-weight:600; cursor:pointer; white-space:nowrap; }
.rqt-trigger:hover { background:#eaf2fc; }
.map-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px 12px; margin-bottom:8px; }
.map-view-switch { display:flex; flex:none; gap:3px; padding:3px;
  border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); }
.map-view-switch button { background: transparent; border: 0; border-radius: 5px; padding: 6px 13px;
  cursor: pointer; color: var(--text-secondary); font: inherit; font-size:16px; }
.map-view-switch button[aria-pressed="true"] { background: var(--accent-primary); color: white; }
.displays-toggle { border:1px solid #bcc5ce; background:#f8fafb; color:#374955; border-radius:4px; padding:6px 10px; font:inherit; font-size:16px; cursor:pointer; }
.displays-toggle[aria-expanded=true] { background:#dee6ed; border-color:#9caebe; }
.map-toolbar { justify-content:flex-start; }
.rv-workspace { --display-width:clamp(216px,17vw,268px); --panel-space:0px; container-type:inline-size; position:relative; display:flex; flex:1; min-height:0; min-width:0; border:1px solid #afb7bf; border-radius:4px; overflow:hidden; }
.rv-workspace.panel-open { --panel-space:min(var(--display-width), calc(100% - 36px)); }
.display-shell { width:var(--panel-space); flex:none; min-height:0; display:flex; justify-content:flex-end; overflow:hidden; transition:width .2s ease; }
.display-shell :deep(.displays) { flex:0 0 min(var(--display-width),calc(100cqw - 36px)); height:100%; }
.display-divider { flex:0 0 9px; cursor:col-resize; touch-action:none; user-select:none; position:relative; z-index:6; background:#e2e6ea; }
.display-divider::after { content:''; position:absolute; left:3px; top:calc(50% - 16px); width:3px; height:32px; border-radius:2px; background:#8493a0; }
.display-divider:focus-visible { outline:2px solid #3973aa; outline-offset:-2px; }
.rv-viewport { flex:1; display:flex; min-height:0; min-width:0; }
.rv-viewport :deep(.map-card) { min-width:0; border:0; border-radius:0; }
.rv-viewport :deep(.card-header) { min-height:36px; padding:6px 10px; justify-content:space-between; flex-wrap:wrap; background:#e8eaed; color:#35414c; font-size:15px; }
@media(max-width:1199px) {
  .rv-workspace { --display-width:min(265px,70vw); }
  .display-shell { position:absolute; inset:0 auto 0 0; z-index:5; }
  .display-divider { position:absolute; inset:0 auto 0 var(--panel-space); width:11px; transition:left .2s ease; }
  .panel-open .display-divider { box-shadow:3px 0 8px #1113; }
}
.panel-dragging .display-shell, .panel-dragging .display-divider { transition:none; }
@media(prefers-reduced-motion:reduce) { .display-shell,.display-divider { transition:none; } }
@media(max-width:900px) { .rv-workspace { min-height:350px; } }
</style>
