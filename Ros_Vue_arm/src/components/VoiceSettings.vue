<template>
  <button class="settings-trigger" type="button" aria-haspopup="dialog" @click="open">语音助手配置</button>
  <Teleport to="body">
    <dialog v-if="opened" ref="dialog" class="voice-dialog" aria-labelledby="voice-settings-title" @close="closed" @keydown.stop @keyup.stop>
      <header><div><h2 id="voice-settings-title">语音助手配置</h2><p>画面快照 · 唤醒与对话 · 音频与导航</p></div><button type="button" class="close" aria-label="关闭语音助手配置" @click="close">×</button></header>
      <div class="content">
        <p class="hint">模型、音色和 API Key 请在顶部「大模型配置」中设置。</p>
        <p v-if="loading" role="status">正在读取语音助手配置…</p>
        <form v-if="loaded" id="voice-settings-form" @submit.prevent="save(true)">
          <details v-for="group in visibleGroups" :key="group.id" :open="group.id === 'vision'">
            <summary>{{ group.label }}</summary>
            <div v-for="field in group.fields" :key="field.key" class="field">
              <label :for="'voice-' + field.key" :class="{toggle: field.type === 'boolean'}">
                <input v-if="field.type === 'boolean'" :id="'voice-' + field.key" v-model="form[field.key]" type="checkbox" :disabled="saving" />{{ field.label }}
              </label>
              <select v-if="field.type === 'select'" :id="'voice-' + field.key" v-model="form[field.key]" :disabled="saving"><option v-if="!field.options.some(o => o[0] === form[field.key])" :value="form[field.key]">{{ form[field.key] }}（当前值）</option><option v-for="option in field.options" :key="option[0]" :value="option[0]">{{ option[1] }}</option></select>
              <textarea v-else-if="field.type === 'textarea'" :id="'voice-' + field.key" v-model="form[field.key]" rows="4" maxlength="4000" :disabled="saving" />
              <input v-else-if="field.type === 'number'" :id="'voice-' + field.key" v-model.number="form[field.key]" type="number" step="1" :min="field.min" :max="field.max" required :disabled="saving" />
              <input v-else-if="field.type !== 'boolean'" :id="'voice-' + field.key" v-model="form[field.key]" type="text" maxlength="2048" :disabled="saving" spellcheck="false" />
              <p v-if="field.hint" class="hint">{{ field.hint }}</p>
              <div v-if="field.key === 'VISION_SNAPSHOT_URL'" class="presets"><button type="button" :disabled="saving" @click="form.VISION_SNAPSHOT_URL = 'http://{wifi_ip}:8080/snapshot'">使用动态 Wi-Fi 地址</button><button type="button" :disabled="saving" @click="form.VISION_SNAPSHOT_URL = 'http://127.0.0.1:8080/snapshot'">使用本机地址</button></div>
            </div>
          </details>
        </form>
        <p v-if="message" :class="['result', {error: isError}]" role="status">{{ message }}</p>
        <button v-if="!loaded && !loading" type="button" class="secondary" @click="load">重新读取配置</button>
      </div>
      <footer><p class="hint">保存并应用会重启语音助手，当前对话将结束。</p><div class="actions"><button type="submit" form="voice-settings-form" class="primary" :disabled="saving || !loaded">{{ saving ? '正在保存…' : '保存并应用' }}</button><button type="button" class="secondary" :disabled="saving || !loaded" @click="save(false)">仅保存</button><button type="button" class="secondary" @click="close">收起</button></div></footer>
    </dialog>
  </Teleport>
</template>
<script setup>
import { ref, computed, nextTick } from 'vue'
const emit = defineEmits(['open'])
const dialog = ref(null), opened = ref(false), loading = ref(false), loaded = ref(false), saving = ref(false)
const form = ref({}), groups = ref([]), message = ref(''), isError = ref(false)
const visibleGroups = computed(() => groups.value.map(group => group.id === 'vision'
  ? { ...group, fields: group.fields.filter(field => field.key === 'VISION_SNAPSHOT_URL') }
  : group))
const endpoint = `${window.location.protocol}//${window.location.hostname}:3000/api/voice-settings`
async function request(options = {}) {
  const response = await fetch(endpoint, { ...options, cache:'no-store', signal:AbortSignal.timeout(35000) })
  const result = await response.json()
  if (!response.ok || !result.success) throw new Error(result.error || '语音助手配置操作失败')
  return result
}
async function load() {
  loading.value = true; loaded.value = false; message.value = ''; isError.value = false
  try { const result = await request(); form.value = result.settings; groups.value = result.groups; loaded.value = true }
  catch (error) { message.value = error.message; isError.value = true }
  finally { loading.value = false }
}
async function open() {
  emit('open'); opened.value = true; await nextTick(); dialog.value?.showModal()
  if (!saving.value) await load()
}
function close() { dialog.value?.close() }
function closed() { opened.value = false; if (!saving.value) { form.value = {}; loaded.value = false } }
async function save(apply) {
  if (saving.value || !loaded.value) return
  if (!document.getElementById('voice-settings-form')?.reportValidity()) return
  saving.value = true; message.value = ''; isError.value = false
  try {
    const result = await request({ method:'PUT', headers:{'Content-Type':'application/json','X-Voice-Settings':'1'}, body:JSON.stringify({ ...Object.fromEntries(visibleGroups.value.flatMap(group => group.fields.map(field => [field.key, form.value[field.key]]))), apply }) })
    form.value = result.settings; groups.value = result.groups; message.value = result.message; isError.value = apply && !result.applied
  } catch (error) { message.value = error.name === 'TimeoutError' || error instanceof TypeError ? '设备暂时无法访问，请重新读取配置确认保存结果。' : error.message; isError.value = true }
  finally { saving.value = false }
}
</script>
<style scoped>
button,input,select,textarea { font:inherit; } button { cursor:pointer; } button:disabled { opacity:.55; cursor:not-allowed; }
.settings-trigger,.secondary { padding:9px 13px; border:1px solid #cbd5e1; border-radius:8px; color:#334155; background:white; }
.settings-trigger:hover,.secondary:hover { background:#eff6ff; border-color:#93c5fd; }
.voice-dialog { box-sizing:border-box; width:min(660px,calc(100% - 24px)); max-height:90dvh; margin:auto; border:1px solid #e2e8f0; border-radius:16px; padding:0; background:#fff; color:#1e293b; box-shadow:0 24px 70px #0f172a44; }
.voice-dialog::backdrop { background:#0f172a88; } header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:20px; border-bottom:1px solid #e2e8f0; }
h2 { margin:0; font-size:21px; } header p { margin:6px 0 0; color:#64748b; font-size:13px; }.close { background:none; border:0; font-size:28px; color:#64748b; padding:0 8px; }
.content { padding:4px 20px 20px; } details { border:1px solid #e2e8f0; border-radius:10px; margin-top:14px; padding:14px; } summary { cursor:pointer; font-weight:600; } .field { margin-top:16px; } label { display:block; font-size:14px; margin-bottom:8px; }
input:not([type=checkbox]),select,textarea { box-sizing:border-box; width:100%; padding:10px; border:1px solid #cbd5e1; border-radius:7px; background:white; color:#1e293b; } textarea { resize:vertical; }.toggle { display:flex; align-items:center; gap:8px; }.toggle input { width:16px; height:16px; accent-color:#2563eb; }
.hint { font-size:12px; color:#64748b; line-height:1.7; margin:8px 0; overflow-wrap:anywhere; }.presets { display:flex; gap:12px; flex-wrap:wrap; }.presets button { border:0; padding:2px 0; color:#2563eb; background:none; font-size:12px; }
.result { padding:12px; border-radius:8px; background:#ecfdf5; color:#065f46; line-height:1.6; }.result.error { background:#fef2f2; color:#b91c1c; } footer { padding:12px 20px 18px; border-top:1px solid #e2e8f0; }.actions { display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; }.primary { padding:10px 14px; border:1px solid #2563eb; border-radius:8px; background:#2563eb; color:white; }
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
@media(max-width:500px) { .voice-dialog { max-height:94dvh; } header,.content { padding-left:16px; padding-right:16px; } }
</style>
