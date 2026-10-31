import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installModelSettings } from './model_settings.js';

test('settings API origin checks, validation, retain-key body, apply and failed restart reporting', async () => {
  const app = express(); app.use(express.json());
  const calls = []; let restarts = 0, rejectRestart = false;
  installModelSettings(app, '.', {
    execute: async (mode, values) => {
      calls.push({ mode, values });
      if (values?.CHAT_MODEL === 'bad') return { success: false, error: '模型格式无效' };
      return { success: true, api_key_configured: true, settings: { CHAT_MODEL: 'qwen-plus' }, changed: true };
    },
    restart: async () => { restarts++; if (rejectRestart) throw new Error('offline'); }
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/model-settings`;
  const send = (body, extra = {}) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Model-Settings': '1', ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(url)).json()).api_key_configured, true);
    assert.equal((await send({ CHAT_MODEL: 'qwen-plus' }, { Origin: 'http://evil.example:5173' })).status, 403);
    assert.equal((await send({ CHAT_MODEL: 'qwen-plus' }, { 'X-Model-Settings': '' })).status, 403);
    assert.equal((await send({ apply: 'false' })).status, 400);
    assert.equal((await send({ CHAT_MODEL: 'bad' })).status, 400);
    const saved = await (await send({ CHAT_MODEL: 'qwen-plus', DASHSCOPE_API_KEY: '', apply: false }, { Origin: 'http://127.0.0.1:5173' })).json();
    assert.equal(saved.saved, true); assert.equal(saved.applied, false); assert.equal(restarts, 0);
    assert.equal(calls.at(-1).values.DASHSCOPE_API_KEY, '');
    assert.equal((await (await send({ CHAT_MODEL: 'qwen-plus', apply: true })).json()).applied, true);
    assert.equal(restarts, 1);
    rejectRestart = true;
    const failed = await (await send({ CHAT_MODEL: 'qwen-plus', apply: true })).json();
    assert.equal(failed.saved, true); assert.equal(failed.applied, false);
    assert.match(failed.message, /重启失败/);
  } finally { await new Promise(r => server.close(r)); }
});
