import { computed, reactive, ref, watch } from 'vue'

import {modelDescriptionTopic,modelStaticTopic,readModelSnapshot} from './robotDisplayModel.js'

export const displays = [
  { id: 'grid', label: '网格', type: 'Grid', views: ['2d', '3d'] },
  { id: 'map', label: '栅格地图', type: 'OccupancyGrid', schema: 'nav_msgs/OccupancyGrid', key: 'map', views: ['2d'] },
  { id: 'costmap', label: '代价地图', type: 'OccupancyGrid', schema: 'nav_msgs/OccupancyGrid', key: 'costmap', views: ['2d'] },
  { id: 'particles', label: 'AMCL 粒子云', type: 'ParticleCloud', schema: 'nav2_msgs/ParticleCloud', key: 'particle_cloud', views: ['2d'] },
  { id: 'scan', label: '激光', type: 'LaserScan', schema: 'sensor_msgs/LaserScan', key: 'scan', views: ['2d'] },
  { id: 'model', label: '机器人模型', type: 'RobotModel', schema: 'std_msgs/String', key: 'robot_description', views: ['2d', '3d'] },
  { id: 'robot', label: '机器人位姿', type: 'TF', schema: 'tf2_msgs/TFMessage', key: 'tf', views: ['2d'] },
  { id: 'path', label: '路径', type: 'Path', schema: 'nav_msgs/Path', key: 'plan', views: ['2d'] },
  { id: 'goal', label: '目标与航点', type: 'PoseStamped', schema: 'geometry_msgs/PoseStamped', key: 'goal_pose', views: ['2d'] },
  { id: 'cloud', label: '点云', type: 'PointCloud2', schema: 'sensor_msgs/PointCloud2', key: 'cloud', views: ['3d'] },
  { id: 'pose3d', label: '机器人位姿', type: 'PoseStamped', schema: 'geometry_msgs/PoseStamped', key: 'pose3d', views: ['3d'] }
]

const storageKey = 'robot-console.map.topic-overrides.v1'
const relayPrefix = '/web/map_inputs/'
export function validTopic(name) {
  return typeof name === 'string' && /^(\/[a-zA-Z_][a-zA-Z0-9_]*)+$/.test(name)
}
export function useMapDisplays(foxglove, defaults, connected, view, sinks, modelRevision) {
  const enabled = reactive(Object.fromEntries(displays.map(d => [d.id, true])))
  const modelVisibilityKey = 'robot-console.map.show-model.v1'
  try { enabled.model = localStorage.getItem(modelVisibilityKey) !== 'false' } catch { /* Storage is optional. */ }
  watch(() => enabled.model, visible => {
    try { localStorage.setItem(modelVisibilityKey, String(visible)) } catch { /* Storage is optional. */ }
  })
  const overrides = ref({})
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey))
    for (const { id, key } of displays) {
      if (key && validTopic(saved?.[id])) overrides.value[id] = saved[id]
    }
  } catch { /* Storage is optional. */ }
  function select(id, name) {
    if (name && !validTopic(name)) return
    if (name) overrides.value[id] = name
    else delete overrides.value[id]
    try { localStorage.setItem(storageKey, JSON.stringify(overrides.value)) } catch { /* private browser */ }
  }
  const sources = ref(null)
  const catalogTopic = relayPrefix + '_sources'
  watch(() => connected.value && foxglove.findChannelByTopic(catalogTopic), (channel, _, cleanup) => {
    sources.value = null
    if (!Number.isInteger(channel)) return
    const id = foxglove.subscribe(catalogTopic, message => {
      try { sources.value = JSON.parse(message.data) } catch { sources.value = null }
    }, channel)
    cleanup(() => foxglove.unsubscribe(id))
  }, { immediate: true })
  const channels = computed(() => {
    const bySchema = new Map()
    let liveDescription = null
    for (const channel of foxglove.availableChannels.values()) {
      const schema = channel.schemaName?.replace('/msg/', '/')
      if (channel.encoding !== 'cdr' || channel.topic === catalogTopic) continue
      if (channel.topic === modelDescriptionTopic || channel.topic === modelStaticTopic) {
        if(channel.topic===modelDescriptionTopic)liveDescription=channel
        continue
      }
      if (!bySchema.has(schema)) bySchema.set(schema, new Map())
      const names = bySchema.get(schema)
      const relayed = channel.topic.startsWith(relayPrefix)
      const name = relayed ? channel.topic.slice(relayPrefix.length - 1) : channel.topic
      if (name==='/robot_description')continue
      if (sources.value && sources.value[name]?.replace('/msg/', '/') !== schema) continue
      if (!relayed || !names.has(name)) names.set(name, channel)
    }
    if(liveDescription){
      const schema='std_msgs/String'
      if(!bySchema.has(schema))bySchema.set(schema,new Map())
      bySchema.get(schema).set('/robot_description',liveDescription)
    }
    return bySchema
  })
  const received = reactive({})
  const rows = computed(() => displays.filter(d => d.views.includes(view.value)).map(d => {
    const fallback = defaults.value[d.key] || ''
    const topic = overrides.value[d.id] || fallback
    const names = channels.value.get(d.schema)
    const status = !enabled[d.id] ? '已隐藏' : !d.key ? '可见' : !connected.value ? '未连接' :
      !names?.has(topic) ? '等待话题' : received[d.id] ? '已接收' : '等待数据'
    return { ...d, fallback, topic, custom: !!overrides.value[d.id], enabled: enabled[d.id], status,
      options: names ? [...names.keys()].filter(name => name !== fallback).sort() : [] }
  }))
  for (const d of displays.filter(d => d.key)) {
    const topic = computed(() => overrides.value[d.id] || defaults.value[d.key])
    const channel = computed(() => {
      const needsPose = d.id === 'pose3d' && view.value === '3d' && enabled.model
      const needsTf = d.id === 'robot'
      if (!connected.value || !(needsTf || needsPose || (enabled[d.id] && d.views.includes(view.value)))) return null
      return channels.value.get(d.schema)?.get(topic.value) || null
    })
    watch([topic, channel, () => ['model','robot'].includes(d.id) ? modelRevision.value : null], ([name, ch], _prev, cleanup) => {
      received[d.id] = false
      sinks[d.id](null)
      if (!ch) return
      const id = foxglove.subscribe(ch.topic, message => {
        if (ch.topic === modelDescriptionTopic) {
          message=readModelSnapshot(message,modelRevision.value)
          if(!message)return
        }
        if (sinks[d.id](message,name) !== false) received[d.id] = ch.topic !== modelDescriptionTopic || !!message.data
      }, ch.id)
      if (id !== null) cleanup(() => foxglove.unsubscribe(id))
    }, { immediate: true })
  }
  return { enabled, rows, select, overrides }
}
