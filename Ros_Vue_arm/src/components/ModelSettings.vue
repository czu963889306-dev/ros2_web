<template>
  <button class="settings-trigger" type="button" @click="open" aria-haspopup="dialog">⚙ 大模型配置</button>
  <Teleport to="body">
    <dialog v-if="opened" ref="dialog" class="model-dialog" aria-labelledby="model-settings-title"
      @close="closed" @click="backdrop" @keydown.stop @keyup.stop>
      <header class="settings-header">
        <div><h2 id="model-settings-title">大模型配置</h2><p>千问 · 阿里云百炼</p></div>
        <button type="button" class="close-button" aria-label="收起大模型配置" @click="close">×</button>
      </header>
      <div class="settings-content">
        <section class="provider-links" aria-label="千问配置入口">
          <a href="https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key" target="_blank" rel="noopener noreferrer">获取千问 API Key ↗</a>
          <a href="https://bailian.console.aliyun.com/" target="_blank" rel="noopener noreferrer">打开百炼控制台 ↗</a>
          <a href="https://help.aliyun.com/zh/model-studio/get-api-key/" target="_blank" rel="noopener noreferrer">配置帮助 ↗</a>
        </section>
        <p class="description">同一个百炼 API Key 用于对话、语音识别、语音合成和图片理解。接口地址与 API Key 需要属于同一地域。</p>
        <p v-if="loading" role="status">正在读取当前配置…</p>
        <form v-if="loaded" id="model-settings-form" @submit.prevent="save(true)">
          <div class="key-heading"><label for="model-api-key">API Key</label><span :class="configured ? 'configured' : 'missing'">{{ configured ? '● 已配置' : '○ 尚未配置' }}</span></div>
          <input id="model-api-key" v-model="apiKey" type="password" autocomplete="new-password" maxlength="4096"
            :placeholder="configured ? '留空保留现有密钥，填写则替换' : '粘贴百炼 API Key'" :disabled="saving" />
          <p class="field-hint">现有密钥不会回显；收起面板会清空尚未保存的新密钥。</p>

          <label for="model-base-url">模型接口 Base URL</label>
          <select id="model-base-url" v-model="form.BAILIAN_BASE_URL" required :disabled="saving" @change="endpointChanged('BAILIAN_BASE_URL')"><option v-for="item in optionsFor('BAILIAN_BASE_URL')" :key="item.value" :value="item.value">{{ item.label }}</option></select>
          <p class="field-hint endpoint-value">{{ form.BAILIAN_BASE_URL }}</p>
          <button type="button" class="text-button" @click="beijingDefaults" :disabled="saving">填入千问北京默认地址</button>

          <label for="model-chat">对话模型</label>
          <select id="model-chat" v-model="form.CHAT_MODEL" required :disabled="saving"><option v-for="item in optionsFor('CHAT_MODEL')" :key="item.value" :value="item.value">{{ item.label }}（{{ item.value }}）</option></select>

          <details class="advanced">
            <summary>语音、视觉与业务空间设置</summary>
            <label for="model-stt">语音识别模型（ASR）</label>
            <select id="model-stt" v-model="form.STT_MODEL" required :disabled="saving"><option v-for="item in optionsFor('STT_MODEL')" :key="item.value" :value="item.value">{{ item.label }}（{{ item.value }}）</option></select>
            <label for="model-tts">语音合成模型（TTS）</label>
            <select id="model-tts" v-model="form.TTS_MODEL" required :disabled="saving" @change="ttsChanged"><option v-for="item in optionsFor('TTS_MODEL')" :key="item.value" :value="item.value">{{ item.label }}</option></select>
            <label for="model-voice">语音音色</label>
            <select id="model-voice" v-model="form.TTS_VOICE" required :disabled="saving"><option v-for="item in optionsFor('TTS_VOICE')" :key="item.value" :value="item.value">{{ item.label }}（{{ item.value }}）</option></select><p class="field-hint">音色随语音合成模型联动。</p>
            <label for="model-tts-url">语音合成接口 URL</label>
            <select id="model-tts-url" v-model="form.BAILIAN_TTS_URL" required :disabled="saving" @change="endpointChanged('BAILIAN_TTS_URL')"><option v-for="item in optionsFor('BAILIAN_TTS_URL')" :key="item.value" :value="item.value">{{ item.label }}</option></select><p class="field-hint endpoint-value">{{ form.BAILIAN_TTS_URL }}</p>
            <label for="model-vision">图片理解模型</label>
            <select id="model-vision" v-model="form.VISION_MODEL" required :disabled="saving"><option v-for="item in optionsFor('VISION_MODEL')" :key="item.value" :value="item.value">{{ item.label }}（{{ item.value }}）</option></select>
            <div class="two-columns">
              <div><label for="model-region">百炼地域</label><select id="model-region" v-model="form.BAILIAN_REGION" required :disabled="saving" @change="regionChanged"><option v-for="item in optionsFor('BAILIAN_REGION')" :key="item.value" :value="item.value">{{ item.label }}</option></select></div>
              <div><label for="model-workspace">业务空间 ID（选填）</label><input id="model-workspace" v-model="form.BAILIAN_WORKSPACE_ID" :disabled="saving" placeholder="默认空间可留空" /></div>
            </div>
            <p class="field-hint">业务空间 ID 会将百炼默认域名转换为对应空间的专属域名。</p>
          </details>
        </form>
        <p v-if="message" role="status" :class="['result', { error: isError }]">{{ message }}</p>
        <button v-if="!loaded && !loading" type="button" class="secondary" @click="load">重新读取配置</button>
      </div>
      <footer class="settings-footer">
        <p>“保存并应用”将重启语音助手，当前对话会结束。</p>
        <div class="footer-actions">
          <button class="primary" form="model-settings-form" type="submit" :disabled="saving || !loaded">{{ saving ? '正在保存…' : '保存并应用' }}</button>
          <button class="secondary" type="button" @click="save(false)" :disabled="saving || !loaded">仅保存</button>
          <button class="secondary" type="button" @click="close">收起</button>
        </div>
      </footer>
    </dialog>
  </Teleport>
</template>

<script setup>
import { ref, nextTick } from 'vue'
const emit = defineEmits(['open'])
const dialog = ref(null), opened = ref(false), loaded = ref(false), loading = ref(false), saving = ref(false)
const configured = ref(false), apiKey = ref(''), form = ref({}), message = ref(''), isError = ref(false)
const catalog = ref({ choices: {}, voices: {}, endpoints: {} })
const endpoint = `http://${window.location.hostname}:3000/api/model-settings`
async function request(options = {}) {
  const response = await fetch(endpoint, { ...options, cache: 'no-store', signal: AbortSignal.timeout(35000) })
  const result = await response.json()
  if (!response.ok || !result.success) throw new Error(result.error || '配置操作失败')
  return result
}
async function load() {
  loading.value = true; message.value = ''; isError.value = false
  try { const result = await request(); form.value = result.settings; configured.value = result.api_key_configured; catalog.value = result; loaded.value = true }
  catch (error) { isError.value = true; message.value = error.message }
  finally { loading.value = false }
}
async function open() {
  if (opened.value) { close(); return }
  emit('open'); opened.value = true; await nextTick(); dialog.value.showModal()
  await load()
}
function close() { dialog.value?.close() }
function closed() { apiKey.value = ''; opened.value = false }
function backdrop(event) { if (event.target === dialog.value && event.clientX < dialog.value.getBoundingClientRect().left) close() }
function optionsFor(field) {
  const items = field === 'TTS_VOICE' ? (catalog.value.voices?.[form.value.TTS_MODEL] || []) : (catalog.value.choices?.[field] || [])
  const current = form.value[field]
  return current && !items.some(item => item.value === current) ? [{ value: current, label: '当前配置' }, ...items] : items
}
function ttsChanged() {
  const voices = catalog.value.voices?.[form.value.TTS_MODEL] || []
  if (voices.length && !voices.some(item => item.value === form.value.TTS_VOICE)) form.value.TTS_VOICE = voices[0].value
}
function useRegion(region) {
  const endpoint = catalog.value.endpoints?.[region]
  if (!endpoint) return
  if (form.value.BAILIAN_REGION !== region) form.value.BAILIAN_WORKSPACE_ID = ''
  form.value.BAILIAN_REGION = region
  form.value.BAILIAN_BASE_URL = endpoint.base_url
  form.value.BAILIAN_TTS_URL = endpoint.tts_url
}
function regionChanged() { form.value.BAILIAN_WORKSPACE_ID = ''; useRegion(form.value.BAILIAN_REGION) }
function endpointChanged(field) {
  const key = field === 'BAILIAN_BASE_URL' ? 'base_url' : 'tts_url'
  const match = Object.entries(catalog.value.endpoints || {}).find(([, value]) => value[key] === form.value[field])
  if (match) useRegion(match[0])
}
function beijingDefaults() { useRegion('cn-beijing'); form.value.BAILIAN_WORKSPACE_ID = '' }

async function save(apply) {
  if (saving.value || !loaded.value) return
  const element = document.getElementById('model-settings-form')
  if (!element.reportValidity()) return
  saving.value = true; isError.value = false; message.value = ''
  try {
    const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Model-Settings': '1' },
      body: JSON.stringify({ ...form.value, DASHSCOPE_API_KEY: apiKey.value, apply }) })
    apiKey.value = ''; configured.value = result.api_key_configured; form.value = result.settings
    message.value = result.message; isError.value = apply && !result.applied
  } catch (error) { isError.value = true; message.value = error.message }
  finally { saving.value = false }
}
</script>

<style scoped>
.settings-trigger { border:1px solid #cbd5e1; border-radius:6px; color:#1e40af; background:white; padding:8px 12px; cursor:pointer; font-size:.85rem; white-space:nowrap; }
.model-dialog { position:fixed; inset:0 0 0 auto; margin:0; width:min(560px,100vw); max-width:100vw; height:100dvh; max-height:100dvh; border:0; border-left:1px solid #cbd5e1; color:#0f172a; background:#fff; padding:0; box-shadow:-16px 0 50px #0f172a26; }
.model-dialog[open] { display:flex; flex-direction:column; } .model-dialog::backdrop { background:#0f172a66; }
.settings-header { display:flex; align-items:center; justify-content:space-between; padding:22px 24px; border-bottom:1px solid #e2e8f0; }
h2 { font-size:1.2rem; margin:0; } .settings-header p { margin-top:5px; font-size:.82rem; color:#64748b; }
.close-button { border:0; background:#f1f5f9; color:#475569; font-size:1.6rem; width:34px; height:34px; cursor:pointer; border-radius:6px; }
.settings-content { padding:22px 24px; overflow-y:auto; flex:1; min-height:0; }
.provider-links { display:flex; flex-wrap:wrap; gap:10px 16px; background:#eff6ff; padding:12px; border-radius:7px; }
a { color:#1d4ed8; font-size:.82rem; text-decoration:none; } a:hover { text-decoration:underline; }
.description { font-size:.83rem; line-height:1.65; color:#64748b; margin:14px 0 20px; }
label { display:block; margin:17px 0 7px; color:#334155; font-size:.86rem; font-weight:600; }
input,select { width:100%; max-width:100%; min-width:0; padding:10px 11px; border:1px solid #cbd5e1; border-radius:5px; background:#fff; color:#0f172a; font-size:.86rem; }
input:focus,select:focus { outline:2px solid #93c5fd; outline-offset:1px; } .key-heading { display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; } .key-heading label { margin:0; }
.configured,.missing { font-size:.78rem; } .configured { color:#15803d; } .missing { color:#a16207; }
.endpoint-value { overflow-wrap:anywhere; }
.field-hint { color:#64748b; font-size:.76rem; line-height:1.6; margin-top:6px; }
.text-button { background:none; border:0; color:#2563eb; padding:8px 0; font-size:.8rem; cursor:pointer; }
.advanced { border-top:1px solid #e2e8f0; margin-top:22px; padding-top:15px; } summary { color:#334155; cursor:pointer; font-size:.86rem; font-weight:600; }
.two-columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.result { margin-top:16px; padding:11px; background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; border-radius:6px; font-size:.85rem; line-height:1.6; }
.result.error { background:#fff7ed; border-color:#fed7aa; color:#9a3412; }
.settings-footer { padding:16px 24px 22px; border-top:1px solid #e2e8f0; background:#f8fafc; } .settings-footer p { font-size:.76rem; color:#64748b; margin:0 0 12px; }
.footer-actions { display:flex; gap:9px; flex-wrap:wrap; } .primary,.secondary { padding:9px 15px; border-radius:5px; cursor:pointer; font-size:.85rem; border:1px solid #cbd5e1; }
.primary { background:#2563eb; color:white; border-color:#2563eb; } .secondary { background:#fff; color:#334155; } button:disabled { opacity:.5; cursor:default; }
@media(max-width:500px) { .settings-header,.settings-content,.settings-footer { padding-left:16px; padding-right:16px; } .two-columns { grid-template-columns:1fr; gap:0; } }
</style>
