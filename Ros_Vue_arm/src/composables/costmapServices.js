import { computed, reactive } from 'vue'

const targets = [
  { area: '全局', name: '/global_costmap/clear_entirely_global_costmap' },
  { area: '局部', name: '/local_costmap/clear_entirely_local_costmap' }
]

export function costmapServices(send) {
  const services = reactive(new Map())
  const pending = new Map()
  const ready = computed(() => targets.every(t => services.has(t.name)))
  let nextId = 0

  function finish(service, id, error) {
    const call = pending.get(id)
    if (!call || call.service !== service) return
    pending.delete(id)
    clearTimeout(call.timer)
    if (error) call.reject(new Error(error))
    else call.resolve()
  }
  function disconnect() {
    services.clear()
    for (const [id, call] of pending) finish(call.service, id, '连接中断，结果未知')
  }
  function advertise(list) {
    for (const s of list || []) {
      if (targets.some(t => t.name === s.name) && /^nav2_msgs\/(srv\/)?ClearEntireCostmap$/.test(s.type)) {
        services.set(s.name, s.id)
      }
    }
  }
  function unadvertise(ids) {
    for (const [name, service] of services) {
      if (!ids.includes(service)) continue
      services.delete(name)
      for (const [id, call] of pending) if (call.service === service) finish(service, id, '服务已离线，结果未知')
    }
  }
  function response(view) {
    if (view.byteLength < 13) return
    const service = view.getUint32(1, true), id = view.getUint32(5, true)
    // The Empty ROS reply still has a CDR encapsulation header.
    const valid = view.getUint32(9, true) === 3 && view.byteLength >= 20 &&
      view.getUint8(13) === 99 && view.getUint8(14) === 100 && view.getUint8(15) === 114
    finish(service, id, valid ? '' : '服务响应格式无效')
  }
  function clear(name) {
    const service = services.get(name)
    if (service === undefined) return Promise.reject(new Error('服务未就绪'))
    const id = nextId = (nextId + 1) >>> 0
    const frame = new Uint8Array(24)
    const header = new DataView(frame.buffer)
    frame[0] = 2
    header.setUint32(1, service, true)
    header.setUint32(5, id, true)
    header.setUint32(9, 3, true)
    frame.set([99, 100, 114], 13) // Encoding "cdr", followed by a ROS ClearEntireCostmap request.
    frame[17] = 1 // CDR little-endian, with an empty request member and padding.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(service, id, '响应超时，结果未知'), 6000)
      pending.set(id, { service, timer, resolve, reject })
      try { send(frame) } catch { finish(service, id, '发送失败') }
    })
  }
  async function clearBoth() {
    const results = await Promise.allSettled(targets.map(t => clear(t.name)))
    if (results.every(r => r.status === 'fulfilled')) return '已清除全局和局部代价地图'
    throw new Error(results.map((r, i) => targets[i].area + (r.status === 'fulfilled' ? '已清除' : '：' + r.reason.message)).join('，'))
  }
  return { ready, clearBoth, advertise, unadvertise, response, finish, disconnect }
}
