import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'

const assets = import.meta.glob('../assets/robot/**/*.stl', { eager:true, query:'?url', import:'default' })
const children = (node, tag) => Array.from(node?.children || []).filter(el => el.localName === tag)
const child = (node, tag) => children(node, tag)[0]

function numbers(node, attribute, fallback) {
  const raw = node?.getAttribute(attribute)
  if (!raw) return fallback
  const result = raw.trim().split(/\s+/).map(Number)
  if (result.length !== fallback.length || !result.every(Number.isFinite)) throw Error('无效的 ' + attribute)
  return result
}
function origin(object, node) {
  object.position.fromArray(numbers(node, 'xyz', [0,0,0]))
  const [r,p,y] = numbers(node, 'rpy', [0,0,0])
  object.rotation.set(r,p,y,'ZYX')
}
export async function loadRobotModel(xml, signal, useLiveFixedJoints = true) {
  signal.throwIfAborted()
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const robot = doc.documentElement
  if (robot.localName !== 'robot' || doc.querySelector('parsererror')) throw Error('URDF 格式无效')
  const links = new Map(), globalColors = new Map(), geometries = new Set(), materials = new Map()
  const root = new THREE.Group()
  const meshes = new Map()
  const loader = new STLLoader()
  const visualJobs = []
  function dispose() {
    for (const g of geometries) g.dispose()
    for (const m of materials.values()) m.dispose()
    root.clear()
    geometries.clear()
    materials.clear()
    meshes.clear()
  }
  async function geometryFor(shape) {
    if (!shape) throw Error('缺少可视几何体')
    switch (shape.localName) {
      case 'box': return new THREE.BoxGeometry(...numbers(shape,'size',[1,1,1]))
      case 'sphere': return new THREE.SphereGeometry(Number(shape.getAttribute('radius')),24,16)
      case 'cylinder': {
        const r = Number(shape.getAttribute('radius'))
        return new THREE.CylinderGeometry(r,r,Number(shape.getAttribute('length')),32).rotateX(Math.PI/2)
      }
      case 'mesh': {
        const path = shape.getAttribute('filename') || ''
        const url = path.startsWith('package://') && assets['../assets/robot/' + path.slice(10)]
        if (!url) throw Error('缺少模型网格 ' + path.split('/').pop())
        if (!meshes.has(url)) {
          const response = await fetch(url, { signal })
          if (!response.ok) throw Error('无法读取网格 ' + path)
          const bytes = await response.arrayBuffer()
          signal.throwIfAborted()
          meshes.set(url, loader.parse(bytes))
        }
        return meshes.get(url)
      }
      default: throw Error('不支持的几何体 ' + shape.localName)
    }
  }
  try {
    for (const mat of children(robot,'material')) globalColors.set(mat.getAttribute('name'),child(mat,'color'))
    for (const link of children(robot,'link')) {
      const name = link.getAttribute('name')
      if (!name || links.has(name)) throw Error('连杆名称无效')
      const group = new THREE.Group()
      group.name = name
      links.set(name,group)
      for (const visual of children(link,'visual')) visualJobs.push([group,visual])
    }
    for (const joint of children(robot,'joint')) {
      const parent = links.get(child(joint,'parent')?.getAttribute('link'))
      const target = links.get(child(joint,'child')?.getAttribute('link'))
      if (!parent || !target || target.parent) throw Error('关节引用无效')
      for (let a=parent; a; a=a.parent) if (a===target) throw Error('关节层级有环')
      origin(target,child(joint,'origin'))
      if (robot.getAttribute('name') === 'leap_ros_pro' && joint.getAttribute('type') === 'revolute') {
        const axis = new THREE.Vector3(...numbers(child(joint,'axis'),'xyz',[1,0,0])).normalize()
        target.userData.armJoint = { name: joint.getAttribute('name'), axis: axis.toArray(),
          position: target.position.toArray(), rotation: target.quaternion.toArray() }
      }
      target.userData.parentLink = parent.name
      target.userData.keepUrdfPose = !useLiveFixedJoints && joint.getAttribute('type') === 'fixed'
      parent.add(target)
    }
    const roots = [...links.values()].filter(l=>!l.parent)
    if (roots.length !== 1 || !visualJobs.length) throw Error('模型缺少根连杆或可视部件')
    root.add(roots[0])
    // Decode one visual at a time to bound temporary STL buffers on small devices.
    for (const [group,visual] of visualJobs) {
      signal.throwIfAborted()
      const shape = child(visual,'geometry')?.firstElementChild
      const geometry = await geometryFor(shape)
      geometries.add(geometry)
      const mat = child(visual,'material')
      const rgba = numbers(child(mat,'color') || globalColors.get(mat?.getAttribute('name')), 'rgba', [.5,.55,.6,1])
      const colorKey = rgba.join(',')
      if (!materials.has(colorKey)) {
        const [r,g,b,a] = rgba
        materials.set(colorKey, new THREE.MeshLambertMaterial({color:new THREE.Color(r,g,b), opacity:a, transparent:a<1}))
      }
      const mesh = new THREE.Mesh(geometry,materials.get(colorKey))
      origin(mesh,child(visual,'origin'))
      if (shape.localName==='mesh') mesh.scale.fromArray(numbers(shape,'scale',[1,1,1]))
      group.add(mesh)
    }
    signal.throwIfAborted()
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3()).length()
    if (!(size > 0 && Number.isFinite(size))) throw Error('模型尺寸无效')
    return { root, frame:roots[0].name, name:robot.getAttribute('name') || roots[0].name,
      visualCount:visualJobs.length, size, center:box.getCenter(new THREE.Vector3()), dispose }
  } catch (error) { dispose(); throw error }
}

export function addModelLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff,0xcbd2dc,1.7))
  const sun = new THREE.DirectionalLight(0xffffff,2.1)
  sun.position.set(1,-2,4)
  scene.add(sun)
}
