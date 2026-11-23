<template>
  <aside class="displays" aria-label="地图显示项">
    <header><strong>显示项</strong><span lang="en">Displays</span></header>
    <details class="global-options" open>
      <summary>全局选项 <span lang="en">Global Options</span></summary>
      <div class="properties">
        <label for="fixed-frame">固定坐标系 <span lang="en">Fixed Frame</span></label>
        <select id="fixed-frame" :value="customFrame ? '@custom' : fixedFrame" @change="chooseFrame($event.target.value)">
          <option value="">自动</option>
          <option v-for="frame in choices" :key="frame" :value="frame">{{ frame }}</option>
          <option value="@custom">手动输入…</option>
        </select>
        <form v-if="customFrame" @submit.prevent="chooseFrame(frameDraft.trim().replace(/^\/+/, ''))">
          <input v-model="frameDraft" aria-label="自定义固定坐标系" placeholder="例如 base_link" required pattern="[^\s@]+" @keydown.esc.prevent="customFrame = false" />
          <button type="submit">应用</button>
        </form>
      </div>
    </details>
    <ul>
      <li v-for="row in rows" :key="row.id">
        <div class="entry">
          <input type="checkbox" :checked="row.enabled" :aria-label="'显示' + row.label" @change="$emit('toggle', row.id, $event.target.checked)" />
          <button type="button" class="disclosure" :aria-expanded="expanded === row.id" @click="expand(row)">
            <span>{{ row.label }}</span>
            <i :class="{ good: row.status === '已接收' || row.status === '可见', off: !row.enabled }" :title="row.status" />
            <b aria-hidden="true">{{ expanded === row.id ? '▾' : '▸' }}</b>
          </button>
        </div>
        <Transition name="property-slide">
        <div v-if="expanded === row.id" class="property-slide"><div class="property-clip"><div class="properties">
          <div class="meta"><code>{{ row.type }}</code><span>{{ row.id === 'particles' && row.status === '已接收' ? particleCount + ' 个粒子' : row.status }}</span></div>
          <template v-if="row.id === 'model'">
            <label for="robot-model-source">整机型号</label>
            <select id="robot-model-source" :value="modelSource" :disabled="modelBusy || !modelSource" @change="$emit('modelSource', $event.target.value)">
              <option value="" disabled>读取板上型号…</option>
              <option v-for="name in robotVariants" :key="name" :value="name">{{ name }}</option>
            </select>
            <span v-if="modelStatus" class="model-info" role="status">{{ modelStatus }}</span>
          </template>
          <template v-if="row.key">
            <label :for="'topic-' + row.id">订阅话题</label>
            <select :id="'topic-' + row.id" :value="choice(row)" @change="choose(row, $event.target.value)">
              <option value="">默认 · {{ row.fallback }}</option>
              <option v-for="name in row.options" :key="name" :value="name">{{ name }}</option>
              <option v-if="row.custom && !row.options.includes(row.topic)" :value="row.topic">{{ row.topic }}</option>
              <option value="custom">手动输入…</option>
            </select>
            <form v-if="editing" @submit.prevent="apply(row)">
              <input ref="input" v-model="draft" aria-label="自定义话题名称" autocomplete="off" spellcheck="false" placeholder="/robot/scan" @keydown.esc.prevent="editing = false" />
              <button type="submit">应用</button>
            </form>
            <span v-if="editing && invalid" class="error" role="alert">请输入以 / 开头的 ROS 话题名</span>
            <code class="current" :title="row.topic">{{ row.topic }}</code>
          </template>
          <span v-else-if="!row.key">单元格 1 m</span>
        </div></div></div>
        </Transition>
      </li>
    </ul>
  </aside>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { validTopic } from '../composables/mapDisplays.js'
const props = defineProps({ fixedFrame:String, frameNames:Array, particleCount: Number, rows: Array, view: String, modelStatus: String, modelSource: String, modelBusy:Boolean, robotVariants: Array })
const emit = defineEmits(['toggle', 'select', 'modelSource', 'fixedFrame'])
const customFrame = ref(false), frameDraft = ref('')
const choices = computed(() => [...new Set(['map', 'odom', ...props.frameNames, props.fixedFrame].filter(Boolean))])
function chooseFrame(value) {
  customFrame.value = value === '@custom'
  if (customFrame.value) frameDraft.value = props.fixedFrame
  else emit('fixedFrame', value)
}
const expanded = ref('map')
const editing = ref(false)
const invalid = ref(false)
const draft = ref('')
const input = ref([])
watch(() => props.view, mode => { expanded.value = mode === '2d' ? 'map' : 'cloud'; editing.value = false })
function expand(row) {
  expanded.value = expanded.value === row.id ? '' : row.id
  editing.value = false
}
function choice(row) { return editing.value ? 'custom' : row.custom ? row.topic : '' }
async function choose(row, value) {
  editing.value = value === 'custom'
  invalid.value = false
  if (editing.value) {
    draft.value = row.custom ? row.topic : ''
    await nextTick()
    input.value[0]?.focus()
  } else emit('select', row.id, value)
}
function apply(row) {
  const value = draft.value.trim()
  invalid.value = !validTopic(value)
  if (invalid.value) return
  emit('select', row.id, value === row.fallback ? '' : value)
  editing.value = false
}
</script>

<style scoped>
.global-options { border-bottom:1px solid #c1c7cc; }
.global-options summary { padding:9px 10px; cursor:pointer; font-weight:600; }
.global-options span { color:#53626f; font-size:14px; font-weight:400; }
.displays { min-width:0; background:#f3f4f5; color:#303844; border-right:1px solid #bac1c8; overflow:auto; font-size:17px; }
header { display:flex; align-items:baseline; gap:7px; min-height:44px; padding:10px 12px; background:#e2e5e8; border-bottom:1px solid #c1c7cc; }
header strong { font-size:18px; } header span,.meta { color:#53626f; }
ul { list-style:none; margin:0; padding:2px 0; }
li { border-bottom:1px solid #d9dfe3; }
.entry { display:flex; align-items:center; gap:8px; padding:0 10px; min-height:43px; }
input[type="checkbox"] { accent-color:#3973aa; width:17px; height:17px; flex-shrink:0; }
.disclosure { display:flex; align-items:center; gap:7px; flex:1; text-align:left; padding:8px 0; border:0; color:inherit; background:none; cursor:pointer; font:inherit; }
.disclosure span { flex:1; } .disclosure b { color:#5f6c78; font-size:15px; }
i { width:7px; height:7px; border-radius:50%; background:#ac7527; } i.good { background:#36815b; } i.off { background:#949da6; }
.property-slide { display:grid; grid-template-rows:1fr; }
.property-clip { min-height:0; overflow:hidden; }
.property-slide-enter-active,.property-slide-leave-active { transition:grid-template-rows .18s ease; }
.property-slide-enter-from,.property-slide-leave-to { grid-template-rows:0fr; }
@media(prefers-reduced-motion:reduce) { .property-slide-enter-active,.property-slide-leave-active { transition:none; } }
.properties { padding:4px 10px 10px 16px; display:grid; gap:6px; border-left:2px solid #7497b6; background:#fafbfc; }
.meta,form { display:flex; align-items:center; justify-content:space-between; gap:4px; }
.meta { font-size:14px; flex-wrap:wrap; } .meta span { white-space:nowrap; }
.properties label { color:#445260; font-size:15px; }
select, form input { width:100%; min-width:0; padding:5px 3px; background:white; border:1px solid #acb8c2; border-radius:3px; font:15px/1.45 monospace; color:#202a35; }
form button { white-space:nowrap; padding:4px; cursor:pointer; }
.current { font-size:15px; color:#475a69; overflow-wrap:anywhere; }
.model-info { font-size:14px; overflow-wrap:anywhere; } .error { color:#a12b23; }
</style>
