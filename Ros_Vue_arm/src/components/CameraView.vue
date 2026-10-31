<template>
  <div class="card camera-card">
    <div class="card-header camera-header">
      <span>摄像头</span>
      <span class="camera-source-badge" :class="sourceState">
        {{ sourceStatusText }}
      </span>
    </div>

    <div class="card-body camera-body">
      <div
        v-if="!isExpanded"
        class="camera-frame"
        :class="{ 'is-webrtc': activeMode === 'webrtc' }"
        @dblclick="openExpanded"
      >
        <iframe
          v-if="activeMode === 'webrtc' && activeUrl"
          :key="streamKey"
          class="camera-stream camera-webrtc"
          :src="webrtcEmbedUrl"
          title="WebRTC 摄像头画面"
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen
          scrolling="no"
          @load="streamLoaded = true"
        ></iframe>

        <img
          v-else-if="activeMode === 'image' && activeUrl"
          :key="streamKey"
          class="camera-stream camera-image"
          :src="imageDisplayUrl"
          alt="摄像头画面"
          @load="onImageLoaded"
          @error="onImageError"
          @click="openExpanded"
        >

        <button
          v-if="activeUrl"
          class="camera-expand-trigger"
          type="button"
          title="&#x70b9;&#x51fb;&#x653e;&#x5927;"
          @click.stop="openExpanded"
        >
          <span aria-hidden="true">&#x2197;</span>
          <span>&#x653e;&#x5927;</span>
        </button>

        <div v-if="showPlaceholder" class="camera-placeholder">
          {{ cameraMessage }}
        </div>
      </div>

      <div class="camera-source-info">
        <span>{{ activeSourceText }}</span>
        <span>{{ autoMode ? '自动检测' : '手动选择' }}</span>
      </div>

      <div class="camera-controls">
        <input
          v-model.trim="draftUrl"
          class="url-input camera-url-input"
          type="text"
          placeholder="HTTP/MJPEG 或 WebRTC 地址"
          @input="onUrlInput"
          @keyup.enter="applyUrl"
        >
        <button class="btn camera-btn" type="button" @click="applyUrl">应用</button>
        <button class="btn camera-btn camera-btn-secondary" type="button" @click="enableAutoDetect">自动</button>
        <button class="btn camera-btn camera-btn-secondary" type="button" @click="reloadStream">刷新</button>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="isExpanded"
      class="camera-lightbox"
      role="dialog"
      aria-modal="true"
      @click.self="closeExpanded"
    >
      <div class="camera-lightbox-content">
        <button
          class="camera-lightbox-close"
          type="button"
          title="&#x5173;&#x95ed;"
          aria-label="&#x5173;&#x95ed;"
          @click="closeExpanded"
        >
          <span aria-hidden="true">&times;</span>
        </button>

        <iframe
          v-if="activeMode === 'webrtc' && activeUrl"
          :key="'expanded-webrtc-' + streamKey"
          class="camera-stream camera-webrtc"
          :src="webrtcEmbedUrl"
          title="WebRTC &#x6444;&#x50cf;&#x5934;&#x753b;&#x9762;"
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen
          scrolling="no"
        ></iframe>

        <img
          v-else-if="activeMode === 'image' && activeUrl"
          :key="'expanded-image-' + streamKey"
          class="camera-stream camera-image"
          :src="imageDisplayUrl"
          alt="&#x6444;&#x50cf;&#x5934;&#x753b;&#x9762;"
          @load="onImageLoaded"
          @error="onImageError"
        >
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  defaultUrl: { type: String, default: '' },
  discoveryUrl: { type: String, default: '' }
})

const draftUrl = ref(props.defaultUrl)
const activeUrl = ref('')
const activeMode = ref('')
const activePath = ref('')
const autoMode = ref(true)
const streamKey = ref(0)
const streamLoaded = ref(false)
const sourceState = ref('detecting')
const cameraMessage = ref('正在检测摄像头通道...')
const isExpanded = ref(false)
let discoveryTimer = null

const showPlaceholder = computed(() => {
  if (!activeUrl.value) return true
  return activeMode.value === 'image' && !streamLoaded.value
})

const activeSourceText = computed(() => {
  if (activeMode.value === 'webrtc') return `WebRTC${activePath.value ? ` · ${activePath.value}` : ''}`
  if (activeMode.value === 'image') return 'HTTP / MJPEG'
  return '尚未选择通道'
})

const sourceStatusText = computed(() => {
  if (sourceState.value === 'online') return '在线'
  if (sourceState.value === 'fallback') return 'HTTP'
  if (sourceState.value === 'error') return '异常'
  return '检测中'
})

const imageDisplayUrl = computed(() => {
  if (!activeUrl.value) return ''
  const separator = activeUrl.value.includes('?') ? '&' : '?'
  return `${activeUrl.value}${separator}_=${streamKey.value}`
})

const webrtcEmbedUrl = computed(() => {
  if (!activeUrl.value) return ''
  try {
    const url = new URL(activeUrl.value, window.location.href)
    url.pathname = url.pathname.replace(/\/whep\/?$/, '')
    url.searchParams.set('controls', 'false')
    url.searchParams.set('muted', 'true')
    url.searchParams.set('autoplay', 'true')
    url.searchParams.set('playsInline', 'true')
    url.searchParams.set('disablepictureinpicture', 'true')
    url.searchParams.set('_', streamKey.value.toString())
    return url.toString()
  } catch {
    return activeUrl.value
  }
})

function setSource(mode, url, path = '', ready = false) {
  const changed = activeMode.value !== mode || activeUrl.value !== url || activePath.value !== path
  activeMode.value = mode
  activeUrl.value = url
  activePath.value = path
  sourceState.value = mode === 'webrtc' ? (ready ? 'online' : 'detecting') : 'fallback'
  cameraMessage.value = mode === 'webrtc' ? '正在连接 WebRTC 通道...' : '等待摄像头画面...'
  if (changed) {
    streamLoaded.value = false
    streamKey.value += 1
  }
}

function isWebRtcUrl(url) {
  if (!url) return false
  if (!url.includes('://')) return true
  try {
    const parsed = new URL(url)
    return parsed.port === '8889' || /\/whep\/?$/.test(parsed.pathname)
  } catch {
    return false
  }
}

function normalizeManualUrl(url) {
  if (url.includes('://')) return url
  const path = url.replace(/^\/+/, '')
  return `http://${window.location.hostname}:8889/${path}`
}

function applyUrl() {
  if (!draftUrl.value) {
    enableAutoDetect()
    return
  }
  autoMode.value = false
  const mode = isWebRtcUrl(draftUrl.value) ? 'webrtc' : 'image'
  setSource(mode, normalizeManualUrl(draftUrl.value), '', mode !== 'webrtc')
}

function onUrlInput() {
  autoMode.value = false
}

function openExpanded() {
  if (activeUrl.value) isExpanded.value = true
}

function closeExpanded() {
  isExpanded.value = false
}

function onWindowKeydown(event) {
  if (event.key === 'Escape' && isExpanded.value) {
    closeExpanded()
  }
}

function reloadStream() {
  streamLoaded.value = false
  streamKey.value += 1
  if (autoMode.value) detectStreams()
}

function enableAutoDetect() {
  autoMode.value = true
  sourceState.value = 'detecting'
  cameraMessage.value = '正在检测 WebRTC 通道...'
  detectStreams()
}

function onImageLoaded() {
  streamLoaded.value = true
  sourceState.value = 'fallback'
}

function onImageError() {
  streamLoaded.value = false
  sourceState.value = 'error'
  cameraMessage.value = 'HTTP 摄像头画面暂不可用'
}

async function detectStreams() {
  if (!autoMode.value || !props.discoveryUrl) return
  try {
    const response = await fetch(props.discoveryUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (!autoMode.value) return
    const streams = Array.isArray(data.streams) ? data.streams : []
    // 仅把 MediaMTX 已经 ready 的路径当作 WebRTC 候选；未 ready 时必须走 HTTP 回退。
    const selected = streams.find((stream) => stream && stream.ready === true)

    if (selected) {
      const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
      const port = Number(data.webrtcPort) || 8889
      const encodedPath = selected.name.split('/').map(encodeURIComponent).join('/')
      const url = `${protocol}//${window.location.hostname}:${port}/${encodedPath}`
      setSource('webrtc', url, selected.name, Boolean(selected.ready))
      draftUrl.value = url
      return
    }

    const fallbackUrl = data.fallbackUrl || props.defaultUrl
    if (fallbackUrl) {
      setSource('image', fallbackUrl, '', true)
      draftUrl.value = fallbackUrl
    } else {
      activeUrl.value = ''
      sourceState.value = 'error'
      cameraMessage.value = '未发现可用的摄像头通道'
    }
  } catch (error) {
    if (props.defaultUrl) {
      setSource('image', props.defaultUrl, '', true)
      draftUrl.value = props.defaultUrl
    } else {
      activeUrl.value = ''
      sourceState.value = 'error'
      cameraMessage.value = `通道检测失败：${error.message}`
    }
  }
}

watch(() => props.defaultUrl, (url) => {
  if (!url || autoMode.value || activeMode.value !== 'image') return
  draftUrl.value = url
  setSource('image', url, '', true)
})

onMounted(() => {
  detectStreams()
  discoveryTimer = window.setInterval(detectStreams, 4000)
  window.addEventListener('keydown', onWindowKeydown)
})

onUnmounted(() => {
  if (discoveryTimer) window.clearInterval(discoveryTimer)
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>
