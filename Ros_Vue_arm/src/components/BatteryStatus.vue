<template>
  <div v-if="compact" class="battery-compact" :class="{ low: view.low, muted: !view.fresh }" :title="details" role="status" aria-live="off">
    <span class="battery-icon" aria-hidden="true"><span :style="{ width: (view.percentage ?? 0) + '%' }"></span></span>
    <span>{{ view.percentage === null ? view.label : `${view.percentage}%` }}</span>
    <span v-if="view.status === '充电中'" title="充电中">⚡</span>
  </div>
  <section v-else class="card battery-card">
    <div class="card-header">电池状态 <span v-if="view.low" class="low-label">低电量</span></div>
    <div class="card-body">
      <div class="battery-main"><strong :class="{ low: view.low }">{{ view.percentage === null ? '—' : view.percentage + '%' }}</strong><span>{{ view.status || view.label }}</span></div>
      <div class="battery-meter" role="progressbar" aria-label="剩余电量" :aria-valuenow="view.percentage ?? undefined" aria-valuemin="0" aria-valuemax="100"><span :class="{ low: view.low }" :style="{ width: (view.percentage ?? 0) + '%' }"></span></div>
      <div class="battery-details"><span>电压</span><strong>{{ view.voltage === null ? '—' : view.voltage.toFixed(2) + ' V' }}</strong></div>
      <p v-if="!view.fresh || view.percentage === null" class="battery-note">{{ view.label }}</p>
    </div>
  </section>
</template>
<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { batteryView } from '../composables/battery.js'
const props = defineProps({ data: Object, receivedAt: Number, connected: Boolean, compact: Boolean })
const now = ref(Date.now())
let timer
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(timer))
const view = computed(() => batteryView(props.data, props.receivedAt, now.value, props.connected))
const details = computed(() => [view.value.label, view.value.status, view.value.voltage === null ? '' : view.value.voltage.toFixed(2) + ' V'].filter(Boolean).join(' · '))
</script>
<style scoped>
.battery-compact { display:flex; align-items:center; gap:7px; font-size:.85rem; color:#15803d; white-space:nowrap; }
.battery-icon { width:25px; height:13px; padding:2px; border:1px solid currentColor; border-radius:3px; position:relative; }
.battery-icon::after { content:''; position:absolute; right:-4px; top:3px; width:2px; height:5px; background:currentColor; }
.battery-icon>span { display:block; height:100%; background:currentColor; border-radius:1px; }
.muted { color:#64748b; } .low,.low-label { color:#dc2626; }
.battery-card .card-header { display:flex; justify-content:space-between; } .low-label { font-size:.72rem; }
.battery-main { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.battery-main>strong { font-size:1.6rem; color:#15803d; } .battery-main>strong.low { color:#dc2626; }
.battery-main>span { color:#64748b; font-size:.8rem; }
.battery-meter { height:7px; border-radius:5px; background:#e2e8f0; margin:10px 0 14px; overflow:hidden; }
.battery-meter>span { display:block; height:100%; background:#16a34a; transition:width .3s; } .battery-meter>span.low { background:#dc2626; }
.battery-details { display:flex; justify-content:space-between; font-size:.83rem; color:#64748b; } .battery-details>strong { color:#334155; }
.battery-note { font-size:.77rem; color:#64748b; margin-top:8px; }
</style>
