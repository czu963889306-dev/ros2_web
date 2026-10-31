<template>
  <div class="card" v-if="connected">
    <div class="card-header arm-header">
      <span>机械臂控制</span>
      <span class="arm-badge">通道 1–5 + 末端位姿</span>
    </div>

    <div class="card-body arm-body">
      <section class="home-panel">
        <div>
          <div class="home-title">机械臂回正</div>
          <div class="home-values">1: 90° · 2: 0° · 3–5: 180° · 约 5 秒</div>
        </div>
        <button class="home-button" :disabled="!servoReady || homing" @click="homeArm">
          {{ homing ? '回正中…' : '一键回正' }}
        </button>
      </section>

      <section class="arm-section">
        <div class="section-title">单舵机</div>
        <div class="servo-row">
          <label class="field compact-field">
            <span>通道</span>
            <select v-model.number="servo.channel" :disabled="sendingServo || homing">
              <option v-for="channel in 5" :key="channel" :value="channel">
                {{ channel }}{{ channel === 5 ? ' · 夹爪' : '' }}
              </option>
            </select>
          </label>
          <label class="field angle-field">
            <span>角度</span>
            <div class="number-with-unit">
              <input
                v-model.number="servo.angle"
                type="number"
                min="0"
                max="180"
                step="1"
                inputmode="decimal"
                :disabled="sendingServo || homing"
              >
              <b>°</b>
            </div>
          </label>
        </div>
        <input
          v-model.number="servo.angle"
          class="angle-slider"
          type="range"
          min="0"
          max="180"
          step="1"
          aria-label="舵机角度"
          :disabled="sendingServo || homing"
        >
        <button class="arm-submit" :disabled="!servoReady || sendingServo || homing" @click="sendServo">
          {{ sendingServo ? '发送中…' : '发送舵机角度' }}
        </button>
      </section>

      <section class="arm-section pose-section">
        <div class="section-title">末端位姿</div>
        <div class="pose-grid">
          <label v-for="field in poseFields" :key="field.key" class="field">
            <span>{{ field.label }}</span>
            <div class="number-with-unit">
              <input
                v-model.number="pose[field.key]"
                type="number"
                :step="field.step"
                inputmode="decimal"
                :disabled="sendingPose || homing"
              >
              <b>{{ field.unit }}</b>
            </div>
          </label>
        </div>
        <button class="arm-submit pose-submit" :disabled="sendingPose || homing" @click="sendPose">
          {{ sendingPose ? '正在提交…' : '提交末端位姿' }}
        </button>
        <div class="accept-hint">success 表示目标已接受，不代表动作已完成。</div>
      </section>

      <div v-if="status.text" class="arm-status" :class="status.type" role="status">
        {{ status.text }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

const props = defineProps({
  connected: Boolean,
  servoReady: Boolean
})

const emit = defineEmits(['servo-command', 'home-command'])
const API_BASE = `http://${window.location.hostname}:3000/api`
const HOME_ANGLES = Object.freeze([90.0, 0.0, 180.0, 180.0, 180.0])

const servo = reactive({ channel: 1, angle: 90 })
const pose = reactive({ x: 0.16, y: 0.0, z: 0.12, pitch_deg: 0.0 })
const poseFields = [
  { key: 'x', label: 'X', unit: 'm', step: 0.01 },
  { key: 'y', label: 'Y', unit: 'm', step: 0.01 },
  { key: 'z', label: 'Z', unit: 'm', step: 0.01 },
  { key: 'pitch_deg', label: '俯仰', unit: '°', step: 1 }
]
const sendingServo = ref(false)
const sendingPose = ref(false)
const homing = ref(false)
const status = reactive({ type: '', text: '' })

function setStatus(type, text) {
  status.type = type
  status.text = text
}

function sendServo() {
  const channel = Number(servo.channel)
  const angle = Number(servo.angle)
  if (!Number.isInteger(channel) || channel < 1 || channel > 5) {
    return setStatus('error', '舵机通道必须为 1–5')
  }
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
    return setStatus('error', '舵机角度必须在 0–180° 之间')
  }

  sendingServo.value = true
  emit('servo-command', { channel, angle })
  setStatus('success', `已向 ${channel} 号舵机发送 ${angle.toFixed(0)}°`)
  window.setTimeout(() => { sendingServo.value = false }, 250)
}

function homeArm() {
  if (!props.servoReady || homing.value) return
  homing.value = true
  setStatus('pending', '正在按顺序发送 5 个舵机回正角度，请等待约 5 秒…')
  emit('home-command', [...HOME_ANGLES])
  window.setTimeout(() => {
    homing.value = false
    setStatus('success', '回正命令已全部发送')
  }, 5600)
}

async function sendPose() {
  const payload = Object.fromEntries(Object.keys(pose).map((key) => [key, Number(pose[key])]))
  if (Object.values(payload).some((value) => !Number.isFinite(value))) {
    return setStatus('error', '末端位姿参数必须全部为有效数字')
  }

  sendingPose.value = true
  setStatus('pending', '正在等待机械臂控制器响应…')
  try {
    const response = await fetch(`${API_BASE}/arm/pose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await response.json()
    if (!response.ok || !data.success) {
      throw new Error(data.error || data.message || '目标未被接受')
    }
    setStatus('success', '末端位姿目标已提交')
  } catch (error) {
    setStatus('error', error.message || '机械臂服务调用失败')
  } finally {
    sendingPose.value = false
  }
}
</script>

<style scoped>
.arm-header {
  justify-content: space-between;
}

.arm-badge {
  padding: 2px 6px;
  border-radius: 999px;
  background: #eef2ff;
  color: #4f46e5;
  font-size: 0.62rem;
  font-weight: 600;
}

.arm-body,
.arm-section {
  display: grid;
  gap: 10px;
}

.home-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid #bfdbfe;
  border-radius: var(--radius-sm);
  background: #eff6ff;
}

.home-title {
  color: #1e3a8a;
  font-size: 0.76rem;
  font-weight: 700;
}

.home-values {
  margin-top: 3px;
  color: #64748b;
  font-family: var(--font-mono);
  font-size: 0.61rem;
  white-space: nowrap;
}

.home-button {
  padding: 8px 10px;
  border: 1px solid #2563eb;
  border-radius: var(--radius-sm);
  background: #fff;
  color: #1d4ed8;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
  transition: var(--transition);
  white-space: nowrap;
}

.home-button:hover:not(:disabled) {
  background: #dbeafe;
}

.home-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.pose-section {
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.section-title {
  color: var(--text-secondary);
  font-size: 0.76rem;
  font-weight: 700;
}

.servo-row,
.pose-grid {
  display: grid;
  gap: 8px;
}

.servo-row {
  grid-template-columns: 0.9fr 1.1fr;
}

.pose-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.field > span {
  color: var(--text-muted);
  font-size: 0.68rem;
}

.field input,
.field select {
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 7px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: #fff;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  outline: none;
}

.field input:focus,
.field select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.number-with-unit {
  position: relative;
}

.number-with-unit input {
  padding-right: 26px;
}

.number-with-unit b {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  font-size: 0.66rem;
  pointer-events: none;
}

.angle-slider {
  width: 100%;
  accent-color: var(--accent-primary);
}

.arm-submit {
  width: 100%;
  padding: 9px 10px;
  border: 1px solid #2563eb;
  border-radius: var(--radius-sm);
  background: #2563eb;
  color: #fff;
  font-size: 0.78rem;
  font-weight: 650;
  cursor: pointer;
  transition: var(--transition);
}

.arm-submit:hover:not(:disabled) {
  background: #1d4ed8;
}

.arm-submit:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.pose-submit {
  background: #0f766e;
  border-color: #0f766e;
}

.pose-submit:hover:not(:disabled) {
  background: #115e59;
}

.accept-hint {
  color: var(--text-muted);
  font-size: 0.66rem;
  line-height: 1.45;
}

.arm-status {
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-size: 0.72rem;
  line-height: 1.35;
}

.arm-status.success {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.arm-status.pending {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #bfdbfe;
}

.arm-status.error {
  color: #b91c1c;
  background: #fef2f2;
  border-color: #fecaca;
}
</style>
