<template>
  <div class="console-layout">
    <!-- 顶部导航栏 -->
    <header class="console-header">
      <h1>机器人中控台</h1>
      <div class="header-controls">
        <WifiSettings @open="stopKeyboardControl" />
        <SystemResources />
        <BatteryStatus compact :data="batteryData" :received-at="batteryReceivedAt" :connected="isConnected" />
        <ModelSettings @open="stopKeyboardControl" />
        <VoiceSettings @open="stopKeyboardControl" />
        <ServiceManager @open="stopKeyboardControl" />
      <div class="status-indicator">
        <span class="status-dot" :class="connectionState"></span>
        <span>{{ statusText }}</span>
      </div>
      </div>
    </header>

    <!-- 主体三栏布局 -->
    <main class="console-body">
      <!-- 左栏: 键盘控制 -->
      <section class="left-panel">
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
      <section class="center-panel">
        <SlamMap
          ref="slamMapRef"
          :connected="isConnected"
          :mapData="mapData"
          :costmapData="costmapData"
          :scanData="scanData"
          :tfData="tfData"
          :planData="planData"
          :layers="mapLayers"
          :isMapping="mappingActive"
          :isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          :multiPointMode="multiPointMode"
          :waypoints="waypointQueue"
          :activeWaypoint="activeWaypoint"
          :navFeedback="navFeedback"
          :isPickingPreset="isPickingPreset"
          @preset-selected="onPresetSelected"
          @goal-set="onGoalSet"
          @waypoint-add="onWaypointAdd"
          @waypoint-reached="onWaypointReached"
          @initial-pose-set="onInitialPoseSet"
        />
      </section>

      <!-- 右栏: 连接 + 话题 -->
      <section class="right-panel">
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
          @mappingStarted="onMappingStarted"
          @dialogOpened="stopKeyboardControl"
        />

        <NavigationControl
          @dialog-opened="stopKeyboardControl"
          @navigation-engine="onNavigationEngine"
          :isPickingPreset="isPickingPreset"
          :pickedPresetPose="pickedPresetPose"
          @pick-preset="isPickingPreset = $event"
          @external-goal="onExternalGoal"
          :connected="isConnected"
          v-model:isNavigating="navigationActive"
          v-model:isSettingPose="isSettingPose"
          v-model:multiPointMode="multiPointMode"
          :waypointCount="waypointQueue.length + (activeWaypoint ? 1 : 0)"
          @navigation-stop-requested="onNavigationStopRequested"
          @clear-waypoints="clearWaypoints"
        />

        <div class="card" v-if="isConnected">
          <div class="card-header">
            图层控制
          </div>
          <div class="card-body">
            <div class="layer-controls">
              <div class="layer-item">
                <span>显示地图</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.map">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示代价地图</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.costmap">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示激光</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.scan">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示机器人</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.robot">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示路径</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.path">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="layer-item">
                <span>显示目标点</span>
                <label class="switch">
                  <input type="checkbox" v-model="mapLayers.goal">
                  <span class="slider"></span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useFoxglove } from './composables/useFoxglove.js'
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
import WifiSettings from './components/WifiSettings.vue'

const foxglove = useFoxglove()
const slamMapRef = ref(null)
const API_BASE = `http://${window.location.hostname}:3000/api`
const DEFAULT_WS_URL = `ws://${window.location.hostname}:8765`
let connectRetryTimer = null

const TOPIC_DEFAULTS = {
  cmd_vel: '/cmd_vel',
  battery_state: '/battery_state',
  servo_cmd: '/servo_cmd',
  map: '/map',
  costmap: '/global_costmap/costmap',
  scan: '/scan',
  tf: '/tf',
  odom: '/odometry/filtered',
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
const isSettingPose = ref(false)
const multiPointMode = ref(false)
const waypointQueue = ref([])
const activeWaypoint = ref(null)
const waypointAdvancing = ref(false)
const FEEDBACK_REACHED_THRESHOLD = 0.10

// ---- 状态 ----
const topics = ref([])
const mapData = ref(null)
const costmapData = ref(null)
const scanData = ref(null)
const tfData = ref(null)
const odomData = ref(null)
const batteryData = ref(null)
const batteryReceivedAt = ref(0)
const planData = ref(null)

// 导航反馈数据
const navFeedback = ref(null)
const runtimeTopics = ref({ ...TOPIC_DEFAULTS })
const cameraStreamUrl = ref(`http://${window.location.hostname}:8080/stream`)

// ---- 图层控制 ----
const mapLayers = ref({
  map: true,
  costmap: true,
  scan: true,
  robot: true,
  path: true,
  goal: true
})

// ================= Foxglove 频道 ID ==================
let cmdVelChannelId = null
let servoChannelId = null
const servoReady = ref(false)
let goalPoseChannelId = null
let initialPoseChannelId = null
let cancelNavigationChannelId = null
let cmdVelReleaseTimer = null
let goalPoseReleaseTimer = null
let initialPoseReleaseTimer = null
let cancelNavigationReleaseTimer = null

// 订阅 ID
let mapSubId = null
let costmapSubId = null
let scanSubId = null
let tfSubId = null
let odomSubId = null
let batterySubId = null
let planSubId = null
let feedbackSubId = null // 导航反馈订阅 ID

// ---- 计算属性 ----
const connectionState = computed(() => foxglove.connectionState.value)
const errorMessage = computed(() => foxglove.errorMessage.value)
const isConnected = computed(() => connectionState.value === 'connected')

function clearPublisherReleaseTimers() {
  for (const timer of [
    cmdVelReleaseTimer,
    goalPoseReleaseTimer,
    initialPoseReleaseTimer,
    cancelNavigationReleaseTimer
  ]) {
    if (timer) clearTimeout(timer)
  }
  cmdVelReleaseTimer = null
  goalPoseReleaseTimer = null
  initialPoseReleaseTimer = null
  cancelNavigationReleaseTimer = null
}

function resetChannelHandles() {
  clearPublisherReleaseTimers()
  cmdVelChannelId = null
  servoChannelId = null
  servoReady.value = false
  goalPoseChannelId = null
  initialPoseChannelId = null
  cancelNavigationChannelId = null
  mapSubId = null
  costmapSubId = null
  scanSubId = null
  tfSubId = null
  odomSubId = null
  batterySubId = null
  batteryData.value = null
  batteryReceivedAt.value = 0
  planSubId = null
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
  // 建图开始时自动重置地图视图
  slamMapRef.value?.resetView()
}

// 清空所有订阅数据
function clearAllData() {
  mapData.value = null
  costmapData.value = null
  scanData.value = null
  tfData.value = null
  odomData.value = null
  batteryData.value = null
  batteryReceivedAt.value = 0
  planData.value = null
  navFeedback.value = null // 清除导航反馈数据
  waypointQueue.value = []
  activeWaypoint.value = null
  topics.value = []
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
function onChannelsReady(event) {
  const channels = event.detail
  topics.value = channels

  // 单舵机控制频道
  if (!servoChannelId) {
    servoChannelId = foxglove.clientAdvertise(runtimeTopics.value.servo_cmd, 'geometry_msgs/Vector3', 'json')
    servoReady.value = true
  }

  // 2. 订阅 /map
  if (!mapSubId) {
    mapSubId = foxglove.subscribe(runtimeTopics.value.map, (data) => {
      mapData.value = data
    })
  }

  // 3. 订阅代价地图
  if (!costmapSubId) {
    costmapSubId = foxglove.subscribe(runtimeTopics.value.costmap, (data) => {
      costmapData.value = data
    })
  }

  // 4. 订阅 /scan
  if (!scanSubId) {
    scanSubId = foxglove.subscribe(runtimeTopics.value.scan, (data) => {
      scanData.value = data
    })
  }

  // 5. 订阅 /tf
  if (!tfSubId) {
    tfSubId = foxglove.subscribe(runtimeTopics.value.tf, (data) => {
      tfData.value = data
    })
  }

  // 6. 订阅 EKF 融合里程计
  if (!odomSubId) {
    odomSubId = foxglove.subscribe(runtimeTopics.value.odom, (data) => {
      odomData.value = data
    })
  }

  if (!batterySubId) {
    batterySubId = foxglove.subscribe(runtimeTopics.value.battery_state, (data) => {
      batteryData.value = data
      batteryReceivedAt.value = Date.now()
    })
  }

  // 8. 订阅 /plan (导航路径)
  if (!planSubId) {
    planSubId = foxglove.subscribe(runtimeTopics.value.plan, (data) => {
      planData.value = data
    })
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

const isPickingPreset = ref(false)
const pickedPresetPose = ref(null)
function onPresetSelected(pose) { pickedPresetPose.value = pose; isPickingPreset.value = false }
function onExternalGoal() { multiPointMode.value = false; clearWaypoints(); isPickingPreset.value = false }

// ---- 导航目标点设定 ----
function onGoalSet({ x, y }) {
  if (multiPointMode.value) return
  sendGoalPose(x, y)
}

function sendGoalPose(x, y) {
  if (!isConnected.value) return
  if (!goalPoseChannelId) {
    goalPoseChannelId = foxglove.clientAdvertise(runtimeTopics.value.goal_pose, 'geometry_msgs/PoseStamped', 'json')
  }
  foxglove.sendGoalPose(goalPoseChannelId, x, y, 0)
  if (goalPoseReleaseTimer) clearTimeout(goalPoseReleaseTimer)
  goalPoseReleaseTimer = setTimeout(() => {
    if (goalPoseChannelId) foxglove.clientUnadvertise(goalPoseChannelId)
    goalPoseChannelId = null
    goalPoseReleaseTimer = null
  }, 300)
}

function dispatchNextWaypoint() {
  if (!multiPointMode.value) return
  if (waypointQueue.value.length === 0) {
    activeWaypoint.value = null
    return
  }
  const next = waypointQueue.value.shift()
  activeWaypoint.value = next
  sendGoalPose(next.x, next.y)
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

function onWaypointAdd({ x, y }) {
  if (!multiPointMode.value) return
  waypointQueue.value.push({ x, y })
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
function onInitialPoseSet({ x, y, yaw }) {
  if (!isConnected.value) return
  if (!initialPoseChannelId) {
    initialPoseChannelId = foxglove.clientAdvertise(runtimeTopics.value.initial_pose, 'geometry_msgs/PoseWithCovarianceStamped', 'json')
  }
  foxglove.sendInitialPose(initialPoseChannelId, x, y, yaw)
  if (initialPoseReleaseTimer) clearTimeout(initialPoseReleaseTimer)
  initialPoseReleaseTimer = setTimeout(() => {
    if (initialPoseChannelId) foxglove.clientUnadvertise(initialPoseChannelId)
    initialPoseChannelId = null
    initialPoseReleaseTimer = null
  }, 300)
  // 自动退出初始位置模式
  isSettingPose.value = false
}

watch(multiPointMode, (enabled) => {
  if (!enabled) clearWaypoints()
})

watch(navigationActive, (running) => {
  if (running) {
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

function handleKeyDown(e) {
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
  const key = e.key.toLowerCase()
  if (MOVEMENT_KEYS.includes(key)) {
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
