<template>
  <section class="card map-card cloud-card">
    <div class="card-header cloud-header">
      <span>轨道视图 · Orbit</span>
      <div class="cloud-actions">
        <button v-if="!fileCloud" type="button" :disabled="!session || saving" @click="saveMap">{{ saving ? '保存中…' : '保存地图' }}</button>
        <button v-if="!mapping" type="button" @click="fileInput.click()">打开 PLY</button>
        <input ref="fileInput" type="file" accept=".ply" hidden @change="openPly" />
        <button v-if="fileCloud" type="button" @click="closePly">返回实时点云</button>
        <button v-if="modelVisible" type="button" @click="focusModel">聚焦机器人</button>
        <button v-if="count" type="button" @click="fitView">适配视图</button>
      </div>
    </div>
    <div class="cloud-stage" ref="stage">
      <span v-show="markerLabel.visible" class="robot-label" :style="{ left: markerLabel.x+'px', top: markerLabel.y+'px' }">机器人</span>
      <p v-if="error || (!count && !modelVisible)" class="cloud-message" role="status">{{ error || emptyText }}</p>
    </div>
    <div v-if="saveError || saved" class="pose-strip" role="status">
      <span v-if="saveError">{{ saveError }}</span>
      <template v-else>
        <span>已保存 {{ saved.id }}</span>
        <a :href="downloadUrl('db')">下载数据库</a>
        <a v-if="saved.ply" :href="downloadUrl('ply')">下载 PLY</a>
        <span v-else>本次数据库未导出点云</span>
      </template>
    </div>
    <div class="pose-strip" v-if="!fileCloud && poseVisible">
      <strong>机器人位姿</strong>
      <template v-if="displayPose">
        <span class="coords">X {{ displayPose.x.toFixed(2) }} · Y {{ displayPose.y.toFixed(2) }} · Z {{ displayPose.z.toFixed(2) }} m</span>
        <span>朝向 {{ (displayPose.yaw * 180 / Math.PI).toFixed(1) }}° · {{ displayPose.frame }}</span>
        <button type="button" @click="focusRobot">定位机器人</button>
      </template>
      <span v-else>{{ poseVisible ? '等待同坐标系的位姿' : '已隐藏' }}</span>
    </div>
    <div class="cloud-footer">
      <span>坐标系 <code>{{ viewFrame }}</code></span>
      <span v-if="cloudWarning" role="status">{{ cloudWarning }}</span>
      <span v-if="!fileCloud && poseVisible && pose && !spatialPose && pose.frame !== viewFrame">等待位姿变换 · {{ pose.frame }} → {{ viewFrame }}</span>
      <span v-if="model && !fileCloud">{{ modelVisible ? model.name + ' · ' + modelFrame : '模型等待定位' }}</span>
      <span v-if="armStatus && !fileCloud">{{ armStatus }}</span>
      <span v-if="historical && !fileCloud">上次建图</span>
      <span>{{ count && !cloudWarning ? count.toLocaleString() + ' 个显示点' : '等待点云' }}</span>
      <span v-if="count || modelVisible">左键旋转 · 中键平移 · 滚轮缩放</span>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { normalizeFrame, poseMatrix } from '../composables/displayFrames.js'
import { addModelLights } from '../composables/robotModel.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const props = defineProps({ session: String, cloud: Object, pose: Object, mapping: Boolean, connected: Boolean,
  model:Object, frames:Object, frameRevision:Number, fixedFrame:String, armPositions:Object, armStatus:String,
  historical: Boolean, gridVisible: Boolean, cloudVisible: Boolean, poseVisible: Boolean, cloudTopic: String })
const stage = ref(null)
const fileInput = ref(null)
const saving = ref(false)
const saved = ref(null)
const saveError = ref('')
const mapApi = `http://${window.location.hostname}:3000/api/maps_3d`
function downloadUrl(ext) { return `${mapApi}/${saved.value.id}/map.${ext}` }
async function saveMap() {
  if (saving.value || !props.session) return
  saving.value = true
  saveError.value = ''
  try {
    const res = await fetch(mapApi + '/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: props.session })
    })
    const result = await res.json()
    if (!res.ok) throw new Error(result.error || '地图保存失败')
    saved.value = result
  } catch (e) { saveError.value = e.message }
  finally { saving.value = false }
}
const fileCloud = shallowRef(null)
const clock = ref(performance.now())
const viewFrame = computed(() => fileCloud.value?.frame || props.fixedFrame ||
  normalizeFrame(props.cloud?.frame || props.pose?.frame || props.model?.frame || 'map'))
const cloudWarning = ref('')
const spatialPose = computed(() => {
  const pose = props.pose
  if (fileCloud.value || !props.connected || !pose) return null
  if (props.mapping && clock.value - pose.received > 2500) return null
  if (normalizeFrame(pose.frame) === viewFrame.value) return pose
  if (!props.frameRevision) return null
  const matrix = props.frames.lookup(viewFrame.value, pose.frame)
  if (!matrix) return null
  const world = matrix.clone().multiply(poseMatrix(pose, {x:pose.qx,y:pose.qy,z:pose.qz,w:pose.qw}))
  const p = new THREE.Vector3(), q = new THREE.Quaternion()
  world.decompose(p, q, new THREE.Vector3())
  return {...pose, x:p.x, y:p.y, z:p.z, qx:q.x, qy:q.y, qz:q.z, qw:q.w, frame:viewFrame.value}
})
const visiblePose = computed(() => props.poseVisible ? spatialPose.value : null)
const markerLabel = ref({ visible:false, x:0, y:0 })
let timer, robot
const projected = new THREE.Vector3()
let modelInstance
const modelVisible=ref(false), modelFrame=ref('')
function syncModel() {
  if (!scene) return
  if (modelInstance) scene.remove(modelInstance)
  modelInstance=props.model?.root.clone(true)
  modelVisible.value=false
  if (modelInstance) {scene.add(modelInstance);props.frames.applyJoints(modelInstance,props.armPositions)}
  positionModel()
}
function positionModel() {
  if (!modelInstance) {draw();return}
  const wasVisible=modelVisible.value
  const pose=spatialPose.value
  const frame=viewFrame.value
  const matrix=props.frames.lookup(frame,props.model.frame)
  modelFrame.value=frame
  modelVisible.value=modelInstance.visible=!fileCloud.value && !!(matrix || pose)
  if (matrix) matrix.decompose(modelInstance.position,modelInstance.quaternion,modelInstance.scale)
  else if (pose) {
    modelInstance.position.set(pose.x,pose.y,pose.z)
    modelInstance.quaternion.set(pose.qx,pose.qy,pose.qz,pose.qw).normalize()
  }
  if (modelInstance.visible && !wasVisible && !count.value && !userMovedView) focusModel()
  draw()
}
function focusModel() {
  if (!modelInstance?.visible) return
  const point=modelInstance.localToWorld(props.model.center.clone())
  camera.position.add(point.clone().sub(controls.target))
  controls.target.copy(point)
  fitRadius=props.model.size*.78
  camera.zoom=1
  controls.update()
  resize()
}
watch(()=>props.frameRevision, () => {
  if (modelInstance) props.frames.applyJoints(modelInstance,props.armPositions)
  positionModel()
  positionCloud()
})
watch(()=>props.model,syncModel)
watch(()=>props.armPositions, () => {
  if (!modelInstance) return
  props.frames.applyJoints(modelInstance,props.armPositions)
  draw()
})
watch([spatialPose,fileCloud,viewFrame],positionModel)

let readGeneration = 0
async function openPly(event) {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file || !renderer) return
  const generation = ++readGeneration
  let geometry
  try {
    if (file.size > 96 * 1024 * 1024) throw new Error('请选择 96 MB 以内的 PLY 文件')
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js')
    geometry = new PLYLoader().parse(await file.arrayBuffer())
    if (generation !== readGeneration) return
    const source = geometry.getAttribute('position')
    if (!source?.count) throw new Error('文件中没有点云')
    const step = Math.max(1, Math.ceil(source.count / 120000))
    const xyz = new Float32Array(Math.ceil(source.count / step) * 3)
    let length = 0
    for (let i = 0; i < source.count; i += step) {
      const x = source.getX(i), y = source.getY(i), z = source.getZ(i)
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        xyz[length++] = x; xyz[length++] = y; xyz[length++] = z
      }
    }
    if (!length) throw new Error('文件中没有有效坐标')
    error.value = ''
    fileCloud.value = { positions: xyz.subarray(0,length), frame: file.name }
    updateCloud()
    fitView()
  } catch (e) {
    if (generation === readGeneration) error.value = e.message || '无法读取 PLY 文件'
  } finally { geometry?.dispose() }
}
function closePly() {
  ++readGeneration
  fileCloud.value = null
  error.value = ''
  updateCloud()
  fitView()
}
const count = ref(0)
const error = ref('')
const emptyText = computed(() => !props.connected ? '连接机器人后可查看三维点云' :
  props.cloudVisible ? '等待点云 · ' + props.cloudTopic : '点云已隐藏')

let renderer, camera, scene, controls, observer, points, grid
let userMovedView = false
let fitRadius = 2
let raf = 0
const size = new THREE.Vector3()
const center = new THREE.Vector3()
const color = new THREE.Color()
const palette = new Float32Array(256 * 3)
for (let i = 0; i < 256; i++) color.setHSL(0.59 - (i / 255) * 0.49, 0.85, 0.58).toArray(palette, i * 3)
const displayPose = shallowRef(null)
const startPos = new THREE.Vector3(), endPos = new THREE.Vector3()
const startRot = new THREE.Quaternion(), endRot = new THREE.Quaternion()
let motionStart = 0, duration = 0, previousPose = null
let displayTime = 0
function stepRobot(now) {
  const t = duration ? Math.min(1, Math.max(0, (now - motionStart) / duration)) : 1
  robot.position.lerpVectors(startPos, endPos, t)
  robot.quaternion.slerpQuaternions(startRot, endRot, t)
  if (t === 1 || now - displayTime >= 48) {
    const { x, y, z, w } = robot.quaternion
    displayPose.value = { x: robot.position.x, y: robot.position.y, z: robot.position.z,
      yaw: Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)), frame: previousPose.frame }
    displayTime = now
  }
  if (t < 1) draw()
}
function draw() {
  if (raf || !renderer) return
  raf = requestAnimationFrame(now => {
    raf = 0
    if (robot?.visible) {
      stepRobot(now)
      const height = stage.value.clientHeight
      const scale = Math.max(1, (camera.top-camera.bottom) / camera.zoom / Math.max(1,height) * 82)
      robot.scale.setScalar(scale)
      projected.copy(robot.position).addScaledVector(camera.up, 0.28 * scale).project(camera)
      markerLabel.value = { visible: Math.abs(projected.x)<1 && Math.abs(projected.y)<1 && Math.abs(projected.z)<1,
        x:(projected.x+1)*stage.value.clientWidth/2, y:(1-projected.y)*height/2 }
    } else if (markerLabel.value.visible) markerLabel.value = {visible:false,x:0,y:0}
    if (robot) for (const part of robot.children) part.visible=!modelVisible.value
    renderer.render(scene, camera)
  })
}

function resize() {
  if (!renderer) return
  const { clientWidth: width, clientHeight: height } = stage.value
  if (!width || !height) return
  const aspect = width / height
  camera.top = fitRadius / Math.min(1, aspect)
  camera.bottom = -camera.top
  camera.right = camera.top * aspect
  camera.left = -camera.right
  camera.updateProjectionMatrix()
  renderer.setSize(width, height, false)
  draw()
}

function fitView() {
  const bounds = points?.geometry.boundingBox
  if (!bounds || bounds.isEmpty()) return
  if (!points.visible) return
  const extent = bounds.clone().applyMatrix4(points.matrix)
  const pose = visiblePose.value
  if (pose) extent.expandByPoint(new THREE.Vector3(pose.x, pose.y, pose.z))
  extent.getSize(size)
  extent.getCenter(center)
  const distance = Math.max(2, size.length() * 1.3)
  camera.zoom = 1
  camera.near = 0.01
  camera.far = Math.max(200, distance * 3)
  camera.position.set(1.3,-1.7,1.2).normalize().multiplyScalar(distance).add(center)
  camera.lookAt(center)
  camera.updateMatrixWorld()
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1)
  let left = Infinity, bottom = Infinity, top = -Infinity, end = -Infinity
  function measure(x,y,z) {
    const u = x*right.x + y*right.y + z*right.z
    const v = x*up.x + y*up.y + z*up.z
    left = Math.min(left,u); end = Math.max(end,u)
    bottom = Math.min(bottom,v); top = Math.max(top,v)
  }
  const xyz = points.geometry.getAttribute('position').array
  const sample = new THREE.Vector3()
  for (let i=0; i<xyz.length; i+=3) {
    sample.fromArray(xyz,i).applyMatrix4(points.matrix)
    measure(sample.x,sample.y,sample.z)
  }
  if (pose) measure(pose.x, pose.y, pose.z + .28)
  if (pose) measure(pose.x, pose.y, pose.z)
  const aspect = stage.value.clientWidth / Math.max(1,stage.value.clientHeight)
  fitRadius = Math.max(.45, Math.max(top-bottom,(end-left)/Math.max(.01,aspect)) * .57 * Math.min(1,aspect))
  const offset = right.clone().multiplyScalar((left+end)/2 - center.dot(right))
  offset.addScaledVector(up,(top+bottom)/2 - center.dot(up))
  camera.position.add(offset)
  controls.target.copy(center).add(offset)
  controls.update()
  resize()
}

function updateRobot() {
  if (!robot) return
  const pose = visiblePose.value
  robot.visible = !!pose
  if (!pose) {
    previousPose = null
    displayPose.value = null
    draw()
    return
  }
  if (previousPose === pose) return
  const gap = previousPose ? pose.received - previousPose.received : 0
  endPos.set(pose.x, pose.y, pose.z)
  endRot.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize()
  startPos.copy(robot.position)
  startRot.copy(robot.quaternion)
  motionStart = performance.now()
  duration = previousPose && props.mapping && gap > 0 && gap < 1000 &&
    startPos.distanceTo(endPos) < 0.5 && startRot.angleTo(endRot) < Math.PI / 4
    ? Math.min(300, Math.max(35, gap)) : 0
  const firstPose = !previousPose
  previousPose = pose
  if (firstPose && count.value && !userMovedView) fitView()
  draw()
}
watch(visiblePose, updateRobot)
function focusRobot() {
  if (!robot?.visible) return
  camera.position.add(robot.position.clone().sub(controls.target))
  controls.target.copy(robot.position)
  controls.update()
  draw()
}
function positionCloud() {
  if (!points) return
  const cloud = fileCloud.value || props.cloud
  const matrix = fileCloud.value ? new THREE.Matrix4() : props.frames.lookup(viewFrame.value, cloud?.frame)
  const wasVisible = points.visible
  points.visible = count.value > 0 && !!matrix
  cloudWarning.value = count.value && !matrix ? '等待 TF · ' + cloud.frame + ' → ' + viewFrame.value : ''
  if (points.visible) {
    points.matrix.copy(matrix)
    points.matrixWorldNeedsUpdate = true
    if (!wasVisible && !userMovedView) fitView()
  }
  draw()
}
watch(viewFrame, () => {
  previousPose = null
  positionCloud()
  updateRobot()
  if (!userMovedView && points?.visible) fitView()
})
function updateCloud() {
  if (!renderer) return
  const cloud = props.cloudVisible && (fileCloud.value || props.cloud)
  const xyz = cloud?.positions
  count.value = (xyz?.length || 0) / 3
  const geometry = new THREE.BufferGeometry()
  if (count.value) {
    geometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3))
    geometry.computeBoundingBox()
    const { min, max } = geometry.boundingBox
    const range = Math.max(max.z - min.z, 0.01)
    const rgb = new Float32Array(xyz.length)
    for (let i = 0; i < xyz.length; i += 3) {
      const t = (xyz[i + 2] - min.z) / range
      const j = Math.round(t * 255) * 3
      rgb[i] = palette[j]; rgb[i+1] = palette[j+1]; rgb[i+2] = palette[j+2]
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3))
  }
  points.geometry.dispose()
  points.geometry = geometry
  positionCloud()
  draw()
}

onMounted(() => {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  } catch {
    error.value = '浏览器未能打开 WebGL，请启用图形加速后刷新'
    return
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0x303030)
  renderer.domElement.setAttribute('aria-label', '可旋转、缩放的三维点云')
  stage.value.prepend(renderer.domElement)
  scene = new THREE.Scene()
  camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 200)
  camera.up.set(0, 0, 1)
  camera.position.set(3, -4, 3)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
  controls.mouseButtons.RIGHT = THREE.MOUSE.DOLLY
  controls.minZoom = 0.02
  controls.maxZoom = 100
  controls.addEventListener('change', draw)
  controls.addEventListener('start', () => { userMovedView = true })
  controls.update()
  grid = new THREE.GridHelper(20, 20, 0x8d8d90, 0x555559)
  grid.rotation.x = Math.PI / 2
  grid.visible = props.gridVisible
  scene.add(grid)
  points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
    size: 3.2, sizeAttenuation: false, vertexColors: true
  }))
  points.matrixAutoUpdate = false
  points.visible = false
  scene.add(points)
  robot = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({ color:0xff7138, depthTest:false,depthWrite:false })
  const body = new THREE.Mesh(new THREE.BoxGeometry(.32,.22,.12),material)
  body.position.z=.10
  const nose = new THREE.Mesh(new THREE.ConeGeometry(.12,.24,3),material)
  nose.rotation.z=-Math.PI/2
  nose.position.set(.24,0,.10)
  robot.add(body,nose)
  body.renderOrder = nose.renderOrder = 10
  scene.add(robot)
  addModelLights(scene)
  syncModel()
  updateRobot()
  timer=setInterval(() => { clock.value=performance.now() },500)
  observer = new ResizeObserver(resize)
  observer.observe(stage.value)
  resize()
  updateCloud()
})
watch([() => props.cloud, () => props.cloudVisible], updateCloud)
watch(() => props.gridVisible, visible => { if (grid) { grid.visible = visible; draw() } })
watch(() => props.mapping, running => {
  if (running) { ++readGeneration; fileCloud.value = null; error.value = ''; updateCloud() }
})
onUnmounted(() => {
  ++readGeneration
  clearInterval(timer)
  if (robot) {
    for (const child of robot.children) child.geometry.dispose()
    robot.children[0].material.dispose()
  }
  observer?.disconnect()
  controls?.dispose()
  if (raf) cancelAnimationFrame(raf)
  points?.geometry.dispose()
  points?.material.dispose()
  grid?.dispose()
  renderer?.dispose()
  renderer?.forceContextLoss()
})
</script>

<style scoped>
.cloud-actions { display:flex; flex-wrap:wrap; gap:6px; }
.cloud-header button:disabled { opacity:.5; cursor:default; }
.cloud-header button[aria-pressed=true] { background:#254b62; color:white; }
.robot-label { position:absolute; z-index:1; pointer-events:none; transform:translate(-50%,-100%); padding:2px 6px; border-radius:4px; color:white; background:#833613; font-size:12px; }
.pose-strip { display:flex; flex-wrap:wrap; align-items:center; gap:6px 14px; padding:8px 12px; font-size:.82rem; }
.pose-strip strong { color:#a2411b; }
.coords { font-variant-numeric:tabular-nums; }
.pose-strip button { cursor:pointer; padding:2px 6px; }
.cloud-card { overflow: hidden; }
.cloud-header, .cloud-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cloud-header button { font: inherit; font-size: .8rem; color: var(--text-secondary); cursor: pointer;
  padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 5px; background: var(--bg-card); }
.cloud-stage { position: relative; flex: 1; min-height: 300px; overflow: hidden; background: #303030; }
.cloud-stage :deep(canvas) { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cloud-message { position: absolute; top: 50%; left: 0; width: 100%; text-align: center;
  transform: translateY(-50%); color: #d7e6ee; pointer-events: none; font-size: .9rem; }
.cloud-footer { flex-wrap: wrap; padding: 8px 12px; color: var(--text-secondary); font-size: .76rem; }
.cloud-footer,.pose-strip { background:#e8eaed; border-top:1px solid #bfc6cd; color:#394651; padding:6px 10px; font-size:14px; }
</style>
