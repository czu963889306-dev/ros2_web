<template>
  <div class="card map-card" @keydown="onToolKey">
    <div class="card-header">
      <div class="header-left">
        <strong>二维地图</strong>
        <div class="pose-tools" role="group" aria-label="位姿工具">
          <button v-for="tool in poseTools" :key="tool.id" type="button" class="pose-tool"
            :aria-pressed="poseTool === tool.id" :disabled="!connected"
            :title="tool.title" :aria-keyshortcuts="tool.key" @click="selectTool(tool.id)">
            <i class="tool-arrow" aria-hidden="true"></i>{{ tool.label }}
          </button>
        </div>
      </div>
      <div class="header-right">
        <button type="button" class="btn-mini" :disabled="!clearReady || clearingCostmaps"
          :title="clearReady ? '清除 Nav2 的全局和局部代价地图' : '等待 Nav2 的全局和局部清除服务'" @click="clearNavigationCosts">{{ clearingCostmaps ? '清除中…' : '清除代价地图' }}</button>
        <span v-if="isNavigating" class="nav-status-mini">导航中</span>
        <button v-if="isMapping" class="btn-mini btn-mini-save" @click="openSaveDialog" :disabled="isSaving">
          {{ isSaving ? '保存中...' : '保存地图' }}
        </button>
        <button v-if="model" type="button" class="btn-mini" :disabled="!modelLocated" @click="focusModel">聚焦机器人</button>
        <button class="btn-mini" @click="resetView">重置视图</button>
      </div>
    </div>
    <div class="card-body">
      <div 

        class="map-canvas-container"
        ref="containerRef" tabindex="0" role="region" aria-label="二维地图交互区域"
        @wheel.prevent="onWheel"
        @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp"
        @pointercancel="onPointerCancel" @lostpointercapture="onPointerCancel" @contextmenu.prevent
        @dblclick="onDblClick"
        :style="{ cursor: poseTool ? 'crosshair' : (isDragging ? 'grabbing' : 'grab') }"
      >
        <canvas ref="mapCanvasRef" aria-label="可旋转、缩放的二维地图" />
        <MapModelOverlay v-if="layers.model !== false && activeView" ref="modelOverlay" :model="model" :frames="frames" :frame-revision="frameRevision" :arm-positions="armPositions" @ready="requestDraw" />
        <!-- 悬浮操作提示 -->
        <div v-if="placingPose" class="map-overlay-hint hint-pose" role="status">
          {{ poseTool === 'initial' ? '初始位姿' : '导航目标' }} · 按住定位置，拖动定朝向，松开发送
        </div>
        <div v-else-if="poseTool === 'preset'" class="map-overlay-hint hint-goal">双击地图选择预设位置</div>

        <!-- 导航实时反馈面板 -->
        <div v-if="isNavigating" class="map-overlay-feedback">
          <div class="feedback-item">
            <span class="fb-label">剩余距离</span>
            <span class="fb-value">{{ formattedDistance }}</span>
          </div>
          <div class="feedback-item">
            <span class="fb-label">预计时间</span>
            <span class="fb-value">{{ formattedETA }}</span>
          </div>
          <div v-if="!hasNavFeedback" class="fb-waiting">等待导航反馈...</div>
        </div>
      </div>
      <div v-if="clearNotice" class="save-toast" :class="clearFailed ? 'save-toast-err' : 'save-toast-ok'" role="status">{{ clearNotice }}</div>
      <!-- 保存状态提示 -->
      <div v-if="saveMsg" class="save-toast" :class="saveSuccess ? 'save-toast-ok' : 'save-toast-err'">
        {{ saveMsg }}
      </div>
      
      <!-- 初始位置设置成功提示 -->
      <div v-if="settingMsg" class="save-toast save-toast-ok">
        {{ settingMsg }}
      </div>

      <!-- 单点导航到达提示 -->
      <div v-if="arriveMsg" class="save-toast save-toast-ok">
        {{ arriveMsg }}
      </div>
    </div>

    <footer class="rv-status">
      <span>坐标系 <code>{{ viewFrame }}</code></span>
      <span>{{ mapInfo ? mapInfo.width + ' × ' + mapInfo.height : '等待栅格地图' }}</span>
      <span>{{ Math.round(scale * 100) }}%</span>
      <span>{{ Math.round(rotation * 180 / Math.PI) }}° · 倾角 {{ Math.round(tilt * 180 / Math.PI) }}°</span>
      <span>左键旋转 · 中键平移 · 滚轮缩放</span>
      <span v-if="armStatus">{{ armStatus }}</span>
      <span v-if="model && !modelLocated">模型等待 TF</span>
      <span v-if="frameWarning" class="frame-warning">{{ frameWarning }}</span>
    </footer>
    <!-- 保存地图对话框 -->
    <Teleport to="body">
      <div v-if="showSaveDialog" class="modal-overlay" @click.self="showSaveDialog = false">
        <div class="modal-box">
          <h3 class="modal-title">保存地图</h3>
          <p class="modal-desc">请输入要保存的地图名称：</p>
          <input
            ref="mapNameInputRef"
            v-model="mapNameInput"
            class="modal-input"
            type="text"
            placeholder="例如: my_room_map"
            @keydown.enter="confirmSave"
            @keydown.esc="showSaveDialog = false"
            maxlength="64"
          />
          <div class="modal-actions">
            <button class="btn-modal-cancel" @click="showSaveDialog = false">取消</button>
            <button class="btn-modal-confirm" @click="confirmSave" :disabled="!mapNameInput.trim()">确认保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { defineAsyncComponent, ref, shallowRef, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'

import { normalizeFrame, poseMatrix, projectPose } from '../composables/displayFrames.js'
import { mapPalette, costmapPalette, renderGrid } from '../composables/gridPalette.js'

const MapModelOverlay = defineAsyncComponent(() => import('./MapModelOverlay.vue'))
const modelOverlay = ref(null)
const modelLocated = ref(false)
const props = defineProps({
  model:Object, activeView:Boolean, armPositions:Object, armStatus:String,
  connected: Boolean,
  mapData: Object,
  costmapData: Object,
  particles: Object,
  clearReady: Boolean,
  clearCostmaps: Function,
  costmapTopic: String,
  scanData: Object,
  frames: Object,
  frameRevision: Number,
  fixedFrame: String,
  externalGoal: Object,
  navigationTf: Boolean,
  planData: Object,
  isMapping: Boolean,
  isNavigating: Boolean,
  poseTool: { type: String, default: '' },
  multiPointMode: Boolean,
  waypoints: {
    type: Array,
    default: () => []
  },
  activeWaypoint: {
    type: Object,
    default: null
  },
  navFeedback: Object,
  layers: {
    type: Object,
    default: () => ({ map: true, costmap: true, scan: true, robot: true, path: true, goal: true })
  }
})

const clearingCostmaps = ref(false), clearNotice = ref(''), clearFailed = ref(false)
let clearNoticeTimer
async function clearNavigationCosts() {
  if (!props.clearReady || clearingCostmaps.value) return
  clearTimeout(clearNoticeTimer)
  clearingCostmaps.value = true
  clearFailed.value = false
  clearNotice.value = ''
  try {
    clearNotice.value = await props.clearCostmaps()
  } catch (err) {
    clearFailed.value = true
    clearNotice.value = err.message
  } finally {
    clearingCostmaps.value = false
    clearNoticeTimer = setTimeout(() => { clearNotice.value = '' }, 6000)
  }
}

// === 保存地图 ===
const showSaveDialog = ref(false)
const mapNameInput = ref('')
const mapNameInputRef = ref(null)
const isSaving = ref(false)
const saveMsg = ref('')
const saveSuccess = ref(false)
const API_BASE = `http://${window.location.hostname}:3000/api`

// === 导航 ===
const goalPoint = ref(null)  // { x, y } in world (map) coords
let missingPathFrame = ''
const navPathPoints = shallowRef([])  // Array of { x, y }

// === 初始位置 ===
const poseAnchor = ref(null)  // { x, y } 按下位置 (世界坐标)
const poseDrag = ref(null)    // { x, y } 拖动尾端 (世界坐标)
const settingMsg = ref('')
const arriveMsg = ref('')
const singleGoalReachedNotified = ref(false)

const emit = defineEmits(['preset-selected', 'goal-set', 'waypoint-add', 'waypoint-reached', 'initial-pose-set', 'update:poseTool'])
const poseTools = [
  { id:'initial', label:'2D Pose Estimate', title:'设置初始位姿 (P)', key:'P' },
  { id:'goal', label:'2D Goal Pose', title:'设置导航目标 (G)', key:'G' }
]
const placingPose = computed(() => props.poseTool === 'initial' || props.poseTool === 'goal')
const lastYaw = { initial:0, goal:0 }
let settingTimer
const waypointReachThreshold = 0.10
const reachedWaypointKey = ref('')

// === 导航反馈计算 ===
const formattedETA = computed(() => {
  if (!props.navFeedback || !props.navFeedback.estimated_time_remaining) return '-- s'
  const time = props.navFeedback.estimated_time_remaining
  const totalSeconds = time.sec + time.nanosec / 1e9
  if (totalSeconds < 0 || totalSeconds > 3600) return '-- s' // 过滤异常值
  return totalSeconds.toFixed(1) + ' s'
})

const formattedDistance = computed(() => {
  const feedbackDistance = props.navFeedback?.distance_remaining

  const target = props.multiPointMode ? props.activeWaypoint : goalPoint.value
  const poseDistance = distanceToTarget(target)

  const candidates = []
  if (typeof feedbackDistance === 'number' && Number.isFinite(feedbackDistance)) {
    candidates.push(feedbackDistance)
  }
  if (typeof poseDistance === 'number' && Number.isFinite(poseDistance)) {
    candidates.push(poseDistance)
  }
  if (candidates.length === 0) return '-- m'

  // 非常接近目标时显示 0，避免浮点抖动
  const minDistance = Math.min(...candidates)
  if (minDistance <= 0.03) return '0.00 m'
  return minDistance.toFixed(2) + ' m'
})

const hasNavFeedback = computed(() => {
  if (typeof props.navFeedback?.distance_remaining === 'number') return true
  const target = props.multiPointMode ? props.activeWaypoint : goalPoint.value
  return distanceToTarget(target) !== null
})

function selectTool(tool) {
  if (props.connected) emit('update:poseTool', props.poseTool === tool ? '' : tool)
}
function onToolKey(e) {
  if (!props.activeView || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return
  if (e.key === 'Escape' && props.poseTool) {
    e.preventDefault()
    emit('update:poseTool','')
    return
  }
  const tool = poseTools.find(item => item.key === e.key.toUpperCase())
  if (tool && props.connected) {
    e.preventDefault()
    emit('update:poseTool',tool.id)
  }
}

async function openSaveDialog() {
  mapNameInput.value = ''
  saveMsg.value = ''
  showSaveDialog.value = true
  await nextTick()
  mapNameInputRef.value?.focus()
}

async function confirmSave() {
  const name = mapNameInput.value.trim()
  if (!name) return
  showSaveDialog.value = false
  isSaving.value = true
  saveMsg.value = ''
  try {
    const res = await fetch(`${API_BASE}/save_map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapName: name })
    })
    const data = await res.json()
    saveSuccess.value = data.success
    saveMsg.value = data.success ? `地图已保存: ${name}` : `${data.error}`
  } catch (err) {
    saveSuccess.value = false
    saveMsg.value = '无法连接到本地控制服务'
  } finally {
    isSaving.value = false
    setTimeout(() => { saveMsg.value = '' }, 5000)
  }
}

const containerRef = ref(null)
const mapCanvasRef = ref(null)
const mapInfo = ref(null)

// 离屏 Canvas，用于存储渲染好的地图图像
let offscreenCanvas = null
let costmapCanvas = null

// 视图变换状态
const scale = ref(1.0)
const offsetX = ref(0)
const offsetY = ref(0)
const rotation = ref(0), tilt = ref(0)
let userMoved = false

// 机器人与雷达状态
const robotPose = ref(null) // { x, y, yaw } in map frame
const laserPoints = shallowRef([]) // Array of { x, y } in map frame
const viewFrame = ref('map')
const frameWarning = ref('')
const noTransform = new Set()
let fitNextMap = true
// 交互状态
const isDragging = ref(false)
const pointers = new Map()
let gesture = null
let lastTouch = null

/**
 * 获取当前的坐标系信息。如果有地图用地图的，没有则用虚拟的。
 */
function getEffectiveMapInfo() {
  if (props.mapData?.info && normalizeFrame(props.mapData.header?.frame_id || 'map') === viewFrame.value) {
    return props.mapData.info
  }
  // 虚拟坐标系：500x500 像素，0.05米分辨率 (25m x 25m 区域)
  // 原点设在中心 (12.5m, 12.5m)
  return {
    width: 500,
    height: 500,
    resolution: 0.05,
    origin: {
      position: { x: -12.5, y: -12.5, z: 0 }
    }
  }
}

/**
 * 将 OccupancyGrid 原始数据生成图像到离屏 Canvas
 */
function updateOffscreenCanvas(grid) {
  offscreenCanvas = renderGrid(grid, offscreenCanvas, mapPalette)
  if (offscreenCanvas) {
    const { width, height, resolution } = grid.info
    mapInfo.value = { width, height, resolution }
    if (fitNextMap) autoFit()
  } else {
    mapInfo.value = null
  }
  requestDraw()
}

function updateCostmapCanvas(grid) {
  costmapCanvas = renderGrid(grid, costmapCanvas, costmapPalette)
  requestDraw()
}

/**
 * 转换世界坐标 (米) 到地图图像像素坐标

 */
function worldToPixel(wx, wy) {
  const info = getEffectiveMapInfo()
  const origin = info.origin.position
  const ori = info.origin.orientation
  const res = info.resolution
  
  // 1. 相对于 origin 的平移偏移 (米)
  let dx = wx - origin.x
  let dy = wy - origin.y
  
  // 2. 处理地图原点本身可能有旋转的情况 (虽然大多数地图原点不旋转)
  if (ori && (Math.abs(ori.z) > 0.001 || Math.abs(ori.w - 1) > 0.001)) {
    const mapYaw = Math.atan2(2 * (ori.w * ori.z + ori.x * ori.y), 1 - 2 * (ori.y * ori.y + ori.z * ori.z))
    const cosY = Math.cos(-mapYaw)
    const sinY = Math.sin(-mapYaw)
    const tx = dx * cosY - dy * sinY
    const ty = dx * sinY + dy * cosY
    dx = tx
    dy = ty
  }
  
  // 3. 转换为像素，并处理 Y 轴翻转 (ROS Y 向上, Canvas Y 向下)
  return {
    x: dx / res,
    y: (info.height - 1) - (dy / res)
  }
}

let isDrawPending = false
function mapYaw() { return quatToYaw(getEffectiveMapInfo().origin.orientation) }
function pixelToWorld(x, y) {
  const info = getEffectiveMapInfo()
  return compose({ ...info.origin.position, yaw:mapYaw() },
    { x:x*info.resolution, y:(info.height-1-y)*info.resolution, yaw:0 })
}
function frameTransform(frame, stamp = 0) {
  const name = normalizeFrame(frame || 'map')
  const matrix = props.frames.lookup(viewFrame.value, name, stamp)
  if (!matrix) noTransform.add(name)
  return matrix
}
function applyPlane(ctx, matrix, pixelOffset = 0) {
  const origin = projectPose(matrix, { x:0, y:0 })
  const x = projectPose(matrix, { x:1, y:0 })
  const y = projectPose(matrix, { x:0, y:1 })
  const o = worldToPixel(origin.x, origin.y)
  const u = worldToPixel(x.x, x.y), v = worldToPixel(y.x, y.y)
  ctx.transform(u.x-o.x, u.y-o.y, v.x-o.x, v.y-o.y, o.x, o.y+pixelOffset)
}
function drawOccupancy(ctx, image, data, opacity = 1) {
  const tf = frameTransform(data.header?.frame_id)
  if (!tf) return
  const info = data.info
  const origin = poseMatrix(info.origin.position, info.origin.orientation || {x:0,y:0,z:0,w:1})
  ctx.save()
  applyPlane(ctx, tf.clone().multiply(origin), 1)
  ctx.scale(info.resolution, -info.resolution)
  ctx.globalAlpha = opacity
  ctx.drawImage(image, 0, -image.height)
  ctx.restore()
}
function drawParticles(ctx, cloud) {
  const tf = frameTransform(cloud.frame, props.fixedFrame ? 0 : cloud.stamp)
  if (!tf) return
  const resolution = getEffectiveMapInfo().resolution
  ctx.save()
  applyPlane(ctx, tf)
  ctx.strokeStyle = '#00b400'
  ctx.lineWidth = resolution / scale.value
  ctx.stroke(cloud.path)
  ctx.restore()
}
watch(() => props.particles, requestDraw)

function drawGrid(ctx, canvas) {
  const corners = [[0,0],[canvas.width,0],[0,canvas.height],[canvas.width,canvas.height]]
    .map(([x,y]) => worldAt({x,y}))
  const xs = corners.map(p=>p.x), ys = corners.map(p=>p.y)
  const step = Math.max(1, 2 ** Math.ceil(Math.log2(9 * getEffectiveMapInfo().resolution / scale.value)))
  const minX=Math.floor(Math.min(...xs)/step)*step, maxX=Math.max(...xs)+step
  const minY=Math.floor(Math.min(...ys)/step)*step, maxY=Math.max(...ys)+step
  const line = (a,b) => { ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y) }
  ctx.lineWidth = 1/scale.value
  ctx.strokeStyle = '#525256'
  ctx.beginPath()
  for (let x=minX; x<=maxX; x+=step) line(worldToPixel(x,minY),worldToPixel(x,maxY))
  for (let y=minY; y<=maxY; y+=step) line(worldToPixel(minX,y),worldToPixel(maxX,y))
  ctx.stroke()
  const origin=worldToPixel(0,0)
  for (const [x,y,color] of [[1,0,'#ef6656'],[0,1,'#68ce73']]) {
    ctx.strokeStyle=color; ctx.lineWidth=2/scale.value; ctx.beginPath()
    line(origin, worldToPixel(x,y)); ctx.stroke()
  }
}
function requestDraw() {
  if (!props.activeView || isDrawPending) return
  isDrawPending = true
  requestAnimationFrame(() => {
    isDrawPending = false
    if (props.activeView) draw()
  })
}

function drawHeading(ctx, pose, length, color) {
  const origin = worldToPixel(pose.x, pose.y)
  ctx.save()
  ctx.translate(origin.x, origin.y)
  ctx.rotate(mapYaw() - pose.yaw)
  ctx.scale(1 / scale.value, 1 / scale.value)
  const tip = Math.min(length / 2, 12)
  ctx.beginPath()
  ctx.moveTo(0, -2)
  ctx.lineTo(length - tip, -2)
  ctx.lineTo(length - tip, -6)
  ctx.lineTo(length, 0)
  ctx.lineTo(length - tip, 6)
  ctx.lineTo(length - tip, 2)
  ctx.lineTo(0, 2)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

function drawGoalMarker(ctx, waypoint, index, color) {
  if (Number.isFinite(waypoint.yaw)) drawHeading(ctx, waypoint, 26, color)
  const gp = worldToPixel(waypoint.x, waypoint.y)
  const r = 8 / scale.value
  ctx.strokeStyle = color
  ctx.lineWidth = 2 / scale.value
  ctx.beginPath()
  ctx.arc(gp.x, gp.y, r, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(gp.x, gp.y, r * 0.45, 0, Math.PI * 2)
  ctx.fill()

  const label = index === null ? "G" : String(index + 1)
  ctx.font = `${12 / scale.value}px var(--font-mono)`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, gp.x, gp.y)
}

/**
 * 绘图逻辑
 */
function draw() {
  const canvas = mapCanvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return

  if (!container.clientWidth || !container.clientHeight) return
  if (canvas.width !== container.clientWidth) canvas.width = container.clientWidth
  if (canvas.height !== container.clientHeight) canvas.height = container.clientHeight
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const isMapVisible = props.layers.map && offscreenCanvas
  const isCostmapVisible = props.layers.costmap && costmapCanvas
  const isScanVisible = props.layers.scan && laserPoints.value.length > 0
  const isRobotVisible = props.layers.robot && robotPose.value

  ctx.save()
  ctx.translate(offsetX.value, offsetY.value)
  ctx.scale(scale.value, scale.value * Math.cos(tilt.value))
  ctx.rotate(rotation.value)
  ctx.imageSmoothingEnabled = false 
  
  noTransform.clear()
  if (props.layers.grid) drawGrid(ctx, canvas)
  if (isMapVisible) drawOccupancy(ctx, offscreenCanvas, props.mapData)
  if (isCostmapVisible) {
    const opacity = props.costmapTopic?.endsWith('/local_costmap/costmap') ? 0.7 : 0.3
    drawOccupancy(ctx, costmapCanvas, props.costmapData, opacity)
  }

  if (props.layers.particles && props.particles) drawParticles(ctx, props.particles)

  // 2. 画雷达点 (红色)
  if (isScanVisible) {
    ctx.fillStyle = '#ff643d'
    for (const p of laserPoints.value) {
      const pix = worldToPixel(p.x, p.y)
      ctx.beginPath()
      ctx.arc(pix.x, pix.y, 2.1 / scale.value, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // 3. 画机器人 (蓝色箭头)
  if (isRobotVisible && !(props.model && modelLocated.value)) {
    const pix = worldToPixel(robotPose.value.x, robotPose.value.y)
    ctx.save()
    ctx.translate(pix.x, pix.y)
    ctx.rotate(mapYaw() - robotPose.value.yaw)
    
    ctx.fillStyle = '#6366f1'
    ctx.beginPath()
    ctx.moveTo(8 / scale.value, 0)
    ctx.lineTo(-6 / scale.value, -6 / scale.value)
    ctx.lineTo(-6 / scale.value, 6 / scale.value)
    ctx.closePath()
    ctx.fill()
    
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1 / scale.value
    ctx.stroke()
    ctx.restore()
  }

  // 4. 画导航路径 (绿色折线)
  if (props.layers.path !== false && navPathPoints.value.length > 1) {
    ctx.strokeStyle = '#ff3939'
    ctx.lineWidth = 2 / scale.value
    ctx.beginPath()
    const first = worldToPixel(navPathPoints.value[0].x, navPathPoints.value[0].y)
    ctx.moveTo(first.x, first.y)
    for (let i = 1; i < navPathPoints.value.length; i++) {
      const pt = worldToPixel(navPathPoints.value[i].x, navPathPoints.value[i].y)
      ctx.lineTo(pt.x, pt.y)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (props.layers.goal && props.externalGoal) {
    const g = props.externalGoal
    const tf = frameTransform(g.frame)
    if (tf) drawGoalMarker(ctx, projectPose(tf, g), null, '#fc9b45')
  }
  if (props.layers.scan && props.scanData?.header) frameTransform(props.scanData.header.frame_id)
  if (props.layers.path && missingPathFrame) noTransform.add(missingPathFrame)
  // 5. 画目标点 / 航点
  if (props.layers.goal !== false) {
    if (props.multiPointMode) {
      if (props.activeWaypoint) {
        const point = inView(props.activeWaypoint)
        if (point) drawGoalMarker(ctx, point, 0, '#f97316')
      }
      for (let i = 0; i < props.waypoints.length; i++) {
        const point = inView(props.waypoints[i])
        if (point) drawGoalMarker(ctx, point, i + (props.activeWaypoint ? 1 : 0), '#a78bfa')
      }
    } else if (goalPoint.value) {
      const point = inView(goalPoint.value)
      if (point) drawGoalMarker(ctx, point, null, '#a78bfa')
    }
  }
  const fixedMissing = props.fixedFrame && !props.frames.names().includes(viewFrame.value) &&
    ![props.mapData?.header?.frame_id,props.costmapData?.header?.frame_id,props.scanData?.header?.frame_id,
      props.planData?.header?.frame_id,props.particles?.frame].some(name => normalizeFrame(name) === viewFrame.value)
  frameWarning.value = fixedMissing ? '等待 TF · 固定坐标系 ' + viewFrame.value :
    noTransform.size ? '等待 TF · ' + [...noTransform].join('、') + ' → ' + viewFrame.value : ''
  if (poseAnchor.value) {
    const origin = worldToPixel(poseAnchor.value.x, poseAnchor.value.y)
    ctx.fillStyle = '#28e846'
    ctx.beginPath()
    ctx.arc(origin.x, origin.y, 4 / scale.value, 0, Math.PI * 2)
    ctx.fill()
    if (poseDrag.value) {
      drawHeading(ctx, { ...poseAnchor.value, yaw:lastYaw[gesture.tool] }, 55, '#28e846')
    }
  }

  ctx.restore()
  if (props.model && props.activeView) modelOverlay.value?.renderView({
    width:canvas.width,height:canvas.height,metres:getEffectiveMapInfo().resolution/scale.value,
    heading:mapYaw()+rotation.value,tilt:tilt.value,frame:viewFrame.value,
    center:worldAt({x:canvas.width/2,y:canvas.height/2})
  })
}

// 监听图层配置变化
watch(() => props.layers, () => {
  requestDraw()
}, { deep: true })

function stampToSeconds(stamp) {
  if (!stamp) return null
  const sec = Number(stamp.sec ?? stamp.secs ?? 0)
  const nanosec = Number(stamp.nanosec ?? stamp.nsec ?? stamp.nsecs ?? 0)
  const value = sec + nanosec / 1e9
  return Number.isFinite(value) && value > 0 ? value : null
}

function quatToYaw(q) {
  return q ? Math.atan2(2*(q.w*q.z + q.x*q.y), 1 - 2*(q.y*q.y + q.z*q.z)) : 0
}
function compose(a, b) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw)
  return { x:a.x + c*b.x - s*b.y, y:a.y + s*b.x + c*b.y, yaw:a.yaw + b.yaw }
}
const zeroPose = { x:0, y:0, yaw:0 }
function lookupPose(target, source) {
  return projectPose(props.frames.lookup(target, source), zeroPose)
}
function inView(pose) {
  return pose && projectPose(frameTransform(pose.frame || 'map'), pose)
}
function distanceToTarget(target) {
  if (!props.navigationTf || !target || !props.frameRevision) return null
  // Keep arrival checks in the stored goal's frame, independent of the view.
  const frame = target.frame || 'map'
  const robot = lookupPose(frame,'base_link') || lookupPose(frame,'base_footprint')
  return robot ? Math.hypot(robot.x-target.x, robot.y-target.y) : null
}
function updateScene() {
  const mapFrame = normalizeFrame(props.mapData?.header?.frame_id)
  if (props.fixedFrame) viewFrame.value = props.fixedFrame
  else {
    const useOdom = !lookupPose('map','odom') && (lookupPose('odom','base_link') || lookupPose('odom','base_footprint'))
    const localized = lookupPose('map','base_link') || lookupPose('map','base_footprint')
    viewFrame.value = props.isNavigating ? 'map' : mapFrame || (useOdom ? 'odom' : localized ? 'map' : props.model?.frame || 'map')
  }
  modelLocated.value = !!(props.model && lookupPose(viewFrame.value,props.model.frame))
  robotPose.value = lookupPose(viewFrame.value, 'base_link') || lookupPose(viewFrame.value, 'base_footprint')
  updateLaserPoints(props.scanData)
  const path = props.planData
  const pathFrame = path?.header?.frame_id || 'map'
  const points = []
  missingPathFrame = ''
  for (const pose of path?.poses || []) {
    const frame = pose.frame || pathFrame
    const tf = props.frames.lookup(viewFrame.value, frame)
    if (!tf) { missingPathFrame = frame; break }
    points.push(projectPose(tf, pose.position || pose.pose.position))
  }
  navPathPoints.value = missingPathFrame ? [] : points
  requestDraw()
}
watch([() => props.frameRevision, () => props.fixedFrame, () => props.planData, () => props.isNavigating],
  updateScene, {immediate:true})
watch(() => props.model, model => {
  updateScene()
  if (model && !offscreenCanvas && !props.scanData && !userMoved && modelLocated.value) focusModel(false)
})
watch(() => props.externalGoal, requestDraw)
function updateLaserPoints(data) {
  const points = []
  if (data?.ranges) {
    const tf = props.frames.lookup(viewFrame.value, data.header?.frame_id || 'base_scan', stampToSeconds(data.header?.stamp))
    if (tf) for (let i = 0; i < data.ranges.length; i++) {
      const r = data.ranges[i]
      if (!Number.isFinite(r) || r < data.range_min || r > data.range_max) continue
      const a = data.angle_min + i*data.angle_increment
      const x=r*Math.cos(a), y=r*Math.sin(a), e=tf.elements
      points.push({x:e[12]+e[0]*x+e[4]*y, y:e[13]+e[1]*x+e[5]*y})
    }
  }
  laserPoints.value = points
  requestDraw()
}
watch(() => props.scanData, updateLaserPoints)

function autoFit() {
  if (!containerRef.value) return
  const container = containerRef.value
  const cw = container.clientWidth
  const ch = container.clientHeight
  const { width: mw, height: mh } = getEffectiveMapInfo()

  if (cw === 0 || ch === 0) return

  // 计算缩放：使图像完整放入容器，且充满其中一个维度
  if (offscreenCanvas) fitNextMap = false
  const s = offscreenCanvas ? Math.min(cw / mw, ch / mh) : 1
  rotation.value=0; tilt.value=0
  scale.value = s
  offsetX.value = (cw - mw * s) / 2
  offsetY.value = (ch - mh * s) / 2
  requestDraw()
}

function resetView() {
  userMoved=false
  autoFit()
  if (props.model && modelLocated.value && !offscreenCanvas && !props.scanData) focusModel(false)
}
function focusModel(manual=true) {
  const box=containerRef.value
  const pose=props.model && lookupPose(viewFrame.value,props.model.frame)
  if (!pose || !box?.clientWidth) return
  if (manual) userMoved=true
  const {resolution}=getEffectiveMapInfo()
  scale.value=Math.min(500, Math.min(box.clientWidth,box.clientHeight)*.34*resolution/props.model.size)
  anchor(worldToPixel(pose.x,pose.y),{x:box.clientWidth/2,y:box.clientHeight/2})
  requestDraw()
}
function localPoint(event) {
  const rect=containerRef.value.getBoundingClientRect()
  return {x:event.clientX-rect.left,y:event.clientY-rect.top}
}
function mapPixel(point) {
  const x=(point.x-offsetX.value)/scale.value
  const y=(point.y-offsetY.value)/(scale.value*Math.cos(tilt.value))
  const c=Math.cos(rotation.value),s=Math.sin(rotation.value)
  return {x:c*x+s*y,y:-s*x+c*y}
}
function worldAt(point) {
  const p=mapPixel(point)
  return pixelToWorld(p.x,p.y)
}
function anchor(pixel,screen) {
  const c=Math.cos(rotation.value),s=Math.sin(rotation.value)
  offsetX.value=screen.x-scale.value*(c*pixel.x-s*pixel.y)
  offsetY.value=screen.y-scale.value*Math.cos(tilt.value)*(s*pixel.x+c*pixel.y)
}
function adjustCamera(start,end,angle,pitch,factor) {
  const pixel=mapPixel(start)
  rotation.value=Math.atan2(Math.sin(rotation.value+angle),Math.cos(rotation.value+angle))
  tilt.value=Math.max(-Math.PI*.42,Math.min(Math.PI*.42,tilt.value+pitch))
  scale.value=Math.max(.02,Math.min(500,scale.value*factor))
  anchor(pixel,end)
  userMoved=true
  requestDraw()
}
function onWheel(e) {
  const p=localPoint(e)
  adjustCamera(p,p,0,0,Math.exp(-Math.sign(e.deltaY)*.14))
}
function pair() {
  const [a,b]=[...pointers.values()]
  return {center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},angle:Math.atan2(b.y-a.y,b.x-a.x),dist:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y))}
}
function onPointerDown(e) {
  if (e.button>2) return
  containerRef.value.focus({preventScroll:true})
  containerRef.value.setPointerCapture(e.pointerId)
  const p=localPoint(e)
  pointers.set(e.pointerId,p)
  if (pointers.size>1) {
    poseAnchor.value=null; poseDrag.value=null; lastTouch=null
    gesture={kind:'multi'}
  } else {
    const kind=e.button===1 || e.shiftKey ? 'pan' : e.button===2 ? 'zoom' : placingPose.value ? 'pose' : 'orbit'
    gesture={kind,start:p,moved:false,tool:props.poseTool,frame:viewFrame.value}
    if(kind==='pose') {poseAnchor.value=worldAt(p); poseDrag.value=null}
  }
  isDragging.value=true
  requestDraw()
}
function onPointerMove(e) {
  const old=pointers.get(e.pointerId)
  if (!old || !gesture) return
  const before=pointers.size===2 ? pair() : null
  const p=localPoint(e)
  pointers.set(e.pointerId,p)
  if (pointers.size>2) return
  if (before) {
    const after=pair()
    adjustCamera(before.center,after.center,after.angle-before.angle,0,after.dist/before.dist)
    return
  }
  if (gesture.kind==='multi') return
  const dx=p.x-old.x,dy=p.y-old.y
  if (gesture.kind==='pose') {
    updateHeading(p)
    requestDraw()
    return
  }
  if (Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)>3) gesture.moved=true
  if (!gesture.moved) return
  const box=containerRef.value, center={x:box.clientWidth/2,y:box.clientHeight/2}
  if (gesture.kind==='pan') adjustCamera(old,p,0,0,1)
  if (gesture.kind==='orbit') adjustCamera(center,center,dx*.008,-dy*.008,1)
  if (gesture.kind==='zoom') adjustCamera(gesture.start,gesture.start,0,0,Math.exp(-dy*.012))
}
function onPointerCancel(e) {
  if (!pointers.delete(e.pointerId)) return
  poseAnchor.value=null;poseDrag.value=null;lastTouch=null
  if (!pointers.size) {gesture=null;isDragging.value=false}
  requestDraw()
}
let lastGestureEnd=-Infinity, lastTouchAction=-Infinity
function onPointerUp(e) {
  if (!pointers.delete(e.pointerId) || !gesture) return
  if (gesture.kind==='pose') {
    if (e.button===0 && poseAnchor.value && props.connected && props.activeView &&
        props.poseTool===gesture.tool && viewFrame.value===gesture.frame) {
      updateHeading(localPoint(e))
      finishPose()
    }
    lastGestureEnd=performance.now()
    cancelGesture()
    return
  }
  if (gesture.moved || gesture.kind==='multi') {
    lastGestureEnd=performance.now()
    lastTouch=null
  } else if (e.pointerType==='touch') {
    const p=localPoint(e), now=performance.now()
    if (lastTouch && now-lastTouch.time<360 && Math.hypot(lastTouch.x-p.x,lastTouch.y-p.y)<15) {
      pickPresetAt(p)
      lastTouchAction=now;lastTouch=null
    } else lastTouch={...p,time:now}
  }
  if (!pointers.size) {gesture=null;isDragging.value=false}
}
function updateHeading(point) {
  if (!poseAnchor.value) return
  const end = worldAt(point)
  const dx = end.x - poseAnchor.value.x, dy = end.y - poseAnchor.value.y
  if (Math.hypot(dx,dy) < 1e-8) return
  poseDrag.value = end
  lastYaw[gesture.tool] = Math.atan2(dy, dx)
}

function toNavigationPose(pose, target) {
  const tf = props.frames.lookup(target, viewFrame.value)
  if (tf) return { ...projectPose(tf, pose), frame:target }
  settingMsg.value = '等待 TF · ' + viewFrame.value + ' → ' + target
  clearTimeout(settingTimer)
  settingTimer = setTimeout(() => { settingMsg.value = '' }, 3000)
  return null
}
function finishPose() {
  const tool = gesture.tool
  const target = (props.fixedFrame || props.isNavigating) ? 'map' : gesture.frame
  const pose = toNavigationPose({ ...poseAnchor.value, yaw:lastYaw[tool] }, target)
  if (!pose) return
  if (tool === 'initial') {
    emit('initial-pose-set', pose)
    settingMsg.value = '已发送初始位姿'
  } else if (props.multiPointMode && props.isNavigating) {
    emit('waypoint-add', pose)
    settingMsg.value = '航点已加入队列'
  } else {
    singleGoalReachedNotified.value = false
    goalPoint.value = pose
    emit('goal-set', pose)
    settingMsg.value = '已发送导航目标'
  }
  clearTimeout(settingTimer)
  settingTimer = setTimeout(() => { settingMsg.value = '' }, 1800)
  poseAnchor.value = null
  poseDrag.value = null
  emit('update:poseTool','')
  requestDraw()
}

function cancelGesture() {
  gesture = null
  poseAnchor.value = null
  poseDrag.value = null
  lastTouch = null
  isDragging.value = false
  for (const id of pointers.keys()) {
    if (containerRef.value?.hasPointerCapture(id)) containerRef.value.releasePointerCapture(id)
  }
  pointers.clear()
  requestDraw()
}
watch([() => props.poseTool, () => props.connected, () => props.activeView, viewFrame], cancelGesture)
watch(viewFrame, () => { userMoved = false; autoFit() })
function onWindowBlur() {
  cancelGesture()
  if (placingPose.value) emit('update:poseTool','')
}
function onDblClick(e) {
  if (e.button!==0 || performance.now()-Math.max(lastGestureEnd,lastTouchAction)<400) return
  pickPresetAt(localPoint(e))
}
function pickPresetAt(point) {
  if (props.poseTool !== 'preset' || !props.mapData || !props.isNavigating) return
  const pose = toNavigationPose(worldAt(point), 'map')
  if (pose) emit('preset-selected', pose)
}

let observer
watch(() => props.mapData, data => {
  updateScene()
  if (data?.info && data.data) updateOffscreenCanvas(data)
  else { offscreenCanvas = null; mapInfo.value = null; fitNextMap = true; requestDraw() }
})
watch(() => props.costmapData, data => {
  if (data?.info && data.data) updateCostmapCanvas(data)
  else { costmapCanvas = null; requestDraw() }
})

watch(() => props.multiPointMode, (enabled) => {
  if (enabled) {
    goalPoint.value = null
  }
  requestDraw()
})

watch(() => [props.waypoints, props.activeWaypoint, props.multiPointMode], () => {
  requestDraw()
}, { deep: true })

watch(() => props.activeWaypoint, (wp) => {
  if (!wp) {
    reachedWaypointKey.value = ''
    return
  }
  reachedWaypointKey.value = `${wp.x.toFixed(3)}_${wp.y.toFixed(3)}`
}, { deep: true })

watch(() => [props.frameRevision, props.activeWaypoint, props.multiPointMode, props.isNavigating], () => {
  if (!props.isNavigating || !props.multiPointMode) return
  const dist = distanceToTarget(props.activeWaypoint)
  if (dist !== null && dist <= waypointReachThreshold && reachedWaypointKey.value) {
    reachedWaypointKey.value = ''
    emit('waypoint-reached')
  }
}, { deep: true })

watch(() => [props.isNavigating, props.multiPointMode, goalPoint.value, props.frameRevision, props.navFeedback], () => {
  if (!props.isNavigating || props.multiPointMode || !goalPoint.value || singleGoalReachedNotified.value) return

  let reached = false
  const feedbackDistance = props.navFeedback?.distance_remaining
  if (typeof feedbackDistance === 'number' && Number.isFinite(feedbackDistance) && feedbackDistance <= 0.10) {
    reached = true
  }

  const distance = distanceToTarget(goalPoint.value)
  if (distance !== null && distance <= 0.10) reached = true

  if (reached) {
    singleGoalReachedNotified.value = true
    goalPoint.value = null
    requestDraw()
    arriveMsg.value = '已到达导航点'
    setTimeout(() => { arriveMsg.value = '' }, 2500)
  }
}, { deep: true })

watch(() => [props.isNavigating, props.multiPointMode], ([navigating, multi]) => {
  if (!navigating || multi) {
    singleGoalReachedNotified.value = false
  }
})

onMounted(() => {
  window.addEventListener('blur',onWindowBlur)
  observer = new ResizeObserver(() => {
    if (!containerRef.value?.clientWidth) return
    if (fitNextMap && !userMoved) resetView()
    requestDraw()
  })
  observer.observe(containerRef.value)
  if (props.mapData) updateOffscreenCanvas(props.mapData)
  if (props.costmapData) updateCostmapCanvas(props.costmapData)
})

onUnmounted(() => {
  window.removeEventListener('blur',onWindowBlur)
  observer?.disconnect()
  clearTimeout(settingTimer)
  clearTimeout(clearNoticeTimer)
})

defineExpose({
  resetView,
  clearGoal: () => { goalPoint.value = null; navPathPoints.value = []; draw() },
  clearPose: () => { poseAnchor.value = null; poseDrag.value = null; draw() }
})

</script>

<style scoped>
.header-left, .pose-tools {
  gap: 6px;
  flex-wrap: wrap;
  display: flex;
  align-items: center;
}
.pose-tool {
  display:inline-flex; align-items:center; gap:4px; padding:5px 7px;
  border:1px solid transparent; border-radius:4px; background:transparent;
  color:#243447; cursor:pointer; font:500 14px/1.3 var(--font-main); white-space:nowrap;
}
.pose-tool:hover:enabled { background:#f8fafc; border-color:#bdc8d1; }
.pose-tool[aria-pressed=true] { background:#e6f6e9; border-color:#72a780; }
.pose-tool:disabled { opacity:.5; cursor:default; }
.tool-arrow { width:17px; height:12px; background:#13a039; transform:rotate(-38deg);
  clip-path:polygon(0 40%,58% 40%,58% 10%,100% 50%,58% 90%,58% 60%,0 60%); }
.header-right {
  flex-wrap:wrap;
  display: flex;
  align-items: center;
  gap: 6px;
}
.btn-mini {
  background: #f8fafc;
  border: 1px solid #cfd6df;
  color: #334155;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-mini:hover:not(:disabled) {
  background: #e2e8f0;
}
.btn-mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-mini-save {
  background: rgba(52, 211, 153, 0.15);
  border-color: rgba(52, 211, 153, 0.4);
  color: #15803d;
}
.btn-mini-save:hover:not(:disabled) {
  background: rgba(52, 211, 153, 0.3);
}
.nav-status-mini {
  color: #15803d;
  font-size: 11px;
  font-weight: bold;
  margin-right: 4px;
}
.map-card :deep(.card-body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.map-canvas-container {
  touch-action:none;
  width: 100%;
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: #303030;
  cursor: grab;
}
.map-canvas-container:active {
  cursor: grabbing;
}
canvas {
  display: block;
}

.map-info {
  position: absolute;
  top: 12px;
  left: 12px;
  background: rgba(255, 255, 255, 0.92);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-secondary);
  pointer-events: none;
}
.map-overlay-hint {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 500;
  pointer-events: none;
  animation: fadein-down 0.3s ease;
  backdrop-filter: blur(4px);
}
.hint-goal {
  color: #2563eb;
  background: rgba(99, 102, 241, 0.25);
  border: 1px solid rgba(99, 102, 241, 0.4);
}
.hint-pose {
  color:#e6ffed; background:#173d2cea; border:1px solid #5f9f73; text-align:center; width:max-content; max-width:95%;
}

.map-overlay-feedback {
  position: absolute;
  top: 56px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 150px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(99, 102, 241, 0.35);
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(4px);
  z-index: 5;
}

.feedback-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.fb-label {
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.fb-value {
  font-size: 0.78rem;
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.fb-waiting {
  font-size: 0.72rem;
  color: var(--text-muted);
  text-align: right;
}
@keyframes fadein-down {
  from { opacity: 0; transform: translate(-50%, -10px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}

/* 保存提示 */
.save-toast {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 18px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
  animation: fadein 0.2s ease;
  white-space: nowrap;
  z-index: 10;
}
.save-toast-ok  { background: rgba(16,185,129,0.85); color: #fff; }
.save-toast-err { background: rgba(239,68,68,0.85);  color: #fff; }
@keyframes fadein { from { opacity:0; transform:translateX(-50%) translateY(6px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.24);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}
.modal-box {
  background: #ffffff;
  border: 1px solid #cfd6df;
  border-radius: 14px;
  padding: 28px 32px;
  min-width: 340px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
  animation: modal-in 0.18s ease;
}
@keyframes modal-in {
  from { transform: scale(0.92); opacity: 0; }
  to   { transform: scale(1);    opacity: 1; }
}
.modal-title { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); margin: 0 0 8px; }
.modal-desc  { font-size: 0.85rem; color: var(--text-muted); margin: 0 0 14px; }
.modal-input {
  width: 100%; box-sizing: border-box;
  background: #f8fafc;
  border: 1px solid #cfd6df;
  border-radius: 8px; padding: 10px 12px;
  color: var(--text-primary); font-size: 0.95rem; outline: none;
  transition: border-color 0.2s;
}
.modal-input:focus { border-color: #6366f1; }
.modal-actions { display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end; }
.btn-modal-cancel {
  background: #f8fafc;
  border: 1px solid #cfd6df;
  color: var(--text-muted); padding: 8px 18px;
  border-radius: 8px; cursor: pointer; font-size: 0.9rem;
  transition: all 0.2s;
}
.btn-modal-cancel:hover { background: #e2e8f0; }
.btn-modal-confirm {
  background: #2563eb;
  border: none; color: #fff; padding: 8px 20px;
  border-radius: 8px; cursor: pointer;
  font-size: 0.9rem; font-weight: 600;
  transition: all 0.2s;
}
.btn-modal-confirm:hover:not(:disabled) { background: #1d4ed8; }
.btn-modal-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
.rv-status { display:flex; align-items:center; flex-wrap:wrap; gap:4px 14px; padding:5px 10px; background:#e8eaed; color:#394651; border-top:1px solid #bfc6cd; font-size:14px; font-variant-numeric:tabular-nums; }
.rv-status code { font-size:14px; } .frame-warning { color:#855316; }
</style>
