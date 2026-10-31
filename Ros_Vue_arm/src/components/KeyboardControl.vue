<template>
  <div class="card keyboard-control-card">
    <div class="card-header motion-control-header">
      <span>键盘控制</span>
      <button
        type="button"
        class="speed-settings-toggle"
        :aria-expanded="showSettings"
        @click="toggleSettings"
      >
        设置
      </button>
    </div>

    <div class="card-body keyboard-control-container">
      <form v-if="showSettings" class="speed-settings-panel" @submit.prevent="applySpeedSettings">
        <label class="speed-setting-field">
          <span>线速度上限</span>
          <span class="speed-setting-input">
            <input
              v-model.number="linearSpeedDraft"
              type="number"
              min="0.01"
              max="3"
              step="0.01"
              required
            >
            <span>m/s</span>
          </span>
        </label>
        <label class="speed-setting-field">
          <span>角速度上限</span>
          <span class="speed-setting-input">
            <input
              v-model.number="angularSpeedDraft"
              type="number"
              min="0.01"
              max="6"
              step="0.1"
              required
            >
            <span>rad/s</span>
          </span>
        </label>
        <button type="submit" class="speed-settings-apply">应用</button>
      </form>

      <div class="keyboard-control-description">
        使用键盘控制底盘，点击页面后按住对应按键即可持续发送速度。
      </div>

      <div class="keyboard-speed-display">
        <div class="keyboard-speed-item">
          <span>线速度上限</span>
          <strong>{{ linearSpeedDisplay }} m/s</strong>
        </div>
        <div class="keyboard-speed-item">
          <span>角速度上限</span>
          <strong>{{ angularSpeedDisplay }} rad/s</strong>
        </div>
      </div>

      <div class="keyboard-hint" aria-label="键盘控制说明">
        <div><kbd>Q</kbd><span>左移</span></div>
        <div><kbd>W</kbd><span>前进</span></div>
        <div><kbd>E</kbd><span>右移</span></div>
        <div><kbd>A</kbd><span>左转</span></div>
        <div><kbd>S</kbd><span>后退</span></div>
        <div><kbd>D</kbd><span>右转</span></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  maxLinearSpeed: {
    type: Number,
    default: 0.15
  },
  maxAngularSpeed: {
    type: Number,
    default: 0.8
  }
})

const emit = defineEmits(['speed-settings-change'])
const showSettings = ref(false)
const linearSpeedDraft = ref(props.maxLinearSpeed)
const angularSpeedDraft = ref(props.maxAngularSpeed)

const linearSpeedDisplay = computed(() => Number(props.maxLinearSpeed).toFixed(2))
const angularSpeedDisplay = computed(() => Number(props.maxAngularSpeed).toFixed(2))

function toggleSettings() {
  linearSpeedDraft.value = props.maxLinearSpeed
  angularSpeedDraft.value = props.maxAngularSpeed
  showSettings.value = !showSettings.value
}

function applySpeedSettings() {
  emit('speed-settings-change', {
    linear: linearSpeedDraft.value,
    angular: angularSpeedDraft.value
  })
  showSettings.value = false
}
</script>
