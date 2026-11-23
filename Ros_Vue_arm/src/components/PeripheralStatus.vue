<template>
  <section class="peripheral-status" aria-label="外设状态">
    <ul class="peripheral-list" aria-live="polite">
      <li v-for="item in items" :key="item.label" :class="item.state" :title="item.label">
        <span class="peripheral-dot" aria-hidden="true"></span>
        <span>{{ item.text }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps({
  cameras: { type: Array, default: null },
  voiceOnline: { type: Boolean, default: null },
  boardReceivedAt: { type: Number, default: 0 },
  rosConnected: Boolean
})

const now = ref(Date.now())
let timer
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(timer))

const boardOnline = computed(() =>
  props.rosConnected && props.boardReceivedAt > 0 && now.value - props.boardReceivedAt < 15000
)

function status(label, online, onlineText, offlineText) {
  if (online === null) return { label, text: label + '待检测', state: 'unknown' }
  return { label, text: online ? onlineText : offlineText, state: online ? 'online' : 'offline' }
}

const items = computed(() => [
  status('相机', props.cameras === null ? null : props.cameras.length > 0,
    props.cameras?.map(camera => camera.name).join('、'), '相机掉线'),
  status('单片机控制板', boardOnline.value, '单片机控制板在线', '单片机控制板掉线'),
  status('语音模块', props.voiceOnline, '语音模块在线', '语音模块掉线')
])
</script>

<style scoped>
.peripheral-status { min-width:0; max-width:100%; margin-left:auto; }
.peripheral-list {
  display:flex;
  justify-content:flex-end;
  flex-wrap:wrap;
  gap:4px 6px;
  list-style:none;
  margin:0;
  padding:0;
}
.peripheral-list li {
  display:flex;
  align-items:baseline;
  gap:4px;
  min-width:0;
  max-width:100%;
  padding:4px 6px;
  border-radius:5px;
  font-size:.75rem;
  font-weight:600;
  overflow-wrap:anywhere;
}
.online { color:#15803d; background:#f0fdf4; }
.offline { color:#b91c1c; background:#fef2f2; }
.unknown { color:#475569; background:#f1f5f9; }
.peripheral-dot { width:6px; height:6px; flex:0 0 6px; border-radius:50%; background:currentColor; }
</style>
