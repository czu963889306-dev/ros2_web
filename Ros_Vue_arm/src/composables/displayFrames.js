import { Matrix4 } from 'three/src/math/Matrix4.js'
import { Quaternion } from 'three/src/math/Quaternion.js'
import { Vector3 } from 'three/src/math/Vector3.js'

export const normalizeFrame = frame => String(frame || '').trim().replace(/^\/+/, '')
const unit = new Vector3(1, 1, 1)

export function poseMatrix(p, q) {
  return new Matrix4().compose(new Vector3(p.x, p.y, p.z || 0),
    new Quaternion(q.x, q.y, q.z, q.w).normalize(), unit)
}

// Project a full ROS transform onto the XY plane of the selected display frame.
export function projectPose(matrix, pose) {
  if (!matrix || !pose) return null
  const e = matrix.elements, z = pose.z || 0, yaw = pose.yaw || 0
  const c = Math.cos(yaw), s = Math.sin(yaw)
  return { x:e[12]+e[0]*pose.x+e[4]*pose.y+e[8]*z,
    y:e[13]+e[1]*pose.x+e[5]*pose.y+e[9]*z,
    yaw:Math.atan2(e[1]*c+e[5]*s, e[0]*c+e[4]*s) }
}

export class ModelFrames {
  constructor() {
    this.dynamic = new Map()
    this.fixed = new Map()
    this.robotFixedChildren = new Set()
    this.latest = new Map()
  }

  update(kind, data, snapshot=false) {
    const store = this[kind]
    let topologyChanged = false
    if (!data) {
      topologyChanged = store.size > 0
      store.clear()
      if(kind==='fixed')this.robotFixedChildren.clear()
    }
    // robot_state_publisher sends all fixed joints together. Other broadcasters
    // may publish independent frames on the same topic.
    const isRobotSnapshot = kind === 'fixed' && data?.transforms.some(t =>
      normalizeFrame(t.header.frame_id) === 'base_footprint' && normalizeFrame(t.child_frame_id) === 'base_link')
    if(isRobotSnapshot){
      const present=new Set(data.transforms.map(t=>normalizeFrame(t.child_frame_id)))
      for(const child of this.robotFixedChildren){
        if(!present.has(child) && store.delete(child))topologyChanged=true
      }
      this.robotFixedChildren=present
    }
    if(snapshot && data){
      const present=new Set(data.transforms.map(t=>normalizeFrame(t.child_frame_id)))
      for(const child of store.keys())if(!present.has(child)){store.delete(child);topologyChanged=true}
    }
    for (const t of data?.transforms || []) {
      const from = normalizeFrame(t.header.frame_id), to = normalizeFrame(t.child_frame_id)
      if (!from || !to || from === to) continue
      const prev = store.get(to)
      const sameParent = prev?.from === from
      if (!sameParent) topologyChanged = true
      const matrix = poseMatrix(t.transform.translation, t.transform.rotation)
      const history = sameParent ? prev.history : []
      if (kind === 'dynamic') {
        const stamp = t.header.stamp
        const time = stamp?.sec + stamp?.nanosec / 1e9
        if (time > 0 && history.at(-1)?.time !== time) {
          history.push({ time, matrix })
          while (history.length > 1 && (history.length > 256 || history[0].time < time - 5)) history.shift()
        }
      }
      store.set(to, { from, to, matrix, history })
    }
    this.latest.clear()
    return topologyChanged
  }

  names() {
    const names = new Set()
    for (const store of [this.dynamic, this.fixed]) for (const edge of store.values()) {
      names.add(edge.from)
      names.add(edge.to)
    }
    return [...names].sort()
  }

  lookup(target, source, stamp = 0) {
    const from = normalizeFrame(target), to = normalizeFrame(source)
    if (!from || !to) return null
    const key = from + '|' + to
    if (!stamp && this.latest.has(key)) return this.latest.get(key)
    const seen = new Set([from]), queue = [[from, new Matrix4()]]
    for (const [frame, matrix] of queue) {
      if (frame === to) {
        if (!stamp) this.latest.set(key, matrix)
        return matrix
      }
      for (const store of [this.dynamic, this.fixed]) for (const edge of store.values()) {
        if (edge.from !== frame && edge.to !== frame) continue
        const forward = edge.from === frame, next = forward ? edge.to : edge.from
        if (seen.has(next)) continue
        seen.add(next)
        let m = edge.matrix
        if (stamp && edge.history.length) {
          m = edge.history.reduce((a,b) => Math.abs(b.time-stamp)<Math.abs(a.time-stamp) ? b : a).matrix
        }
        queue.push([next, matrix.clone().multiply(forward ? m : m.clone().invert())])
      }
    }
    if (!stamp) this.latest.set(key, null)
    return null
  }
  applyJoints(instance, armPositions) {
    const axis = new Vector3(), delta = new Quaternion()
    instance.traverse(link=>{
      if (!link.userData.parentLink || link.userData.keepUrdfPose) return
      const joint = link.userData.armJoint
      const angle = joint && armPositions?.[joint.name]
      if (Number.isFinite(angle)) {
        link.position.fromArray(joint.position)
        delta.setFromAxisAngle(axis.fromArray(joint.axis), angle)
        link.quaternion.fromArray(joint.rotation).multiply(delta)
        return
      }
      const edge=this.dynamic.get(link.name) || this.fixed.get(link.name)
      if (edge?.from===link.userData.parentLink) edge.matrix.decompose(link.position,link.quaternion,link.scale)
    })
  }
}
