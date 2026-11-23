import { robotModelState } from './robot_model_settings.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readCameras, readVoiceModule } from './peripheral_status.js';

export function parseCpu(text) {
  const line = text.split('\n').find(line => /^cpu\s/.test(line));
  if (!line) return null;
  // guest/guest_nice are already included in user/nice. Do not count twice.
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 5 || fields.some(value => !Number.isFinite(value) || value < 0)) return null;
  return { total: fields.reduce((a, b) => a + b, 0), idle: fields[3] + fields[4] };
}

export function cpuPercent(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total, idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.round((total - idle) / total * 1000) / 10;
}

export function parseMemory(text) {
  const values = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB/gm)].map(match => [match[1], Number(match[2]) * 1024]));
  const total = values.MemTotal;
  if (!total || !Number.isFinite(total)) return null;
  if (values.MemAvailable === undefined && values.MemFree === undefined) return null;
  const available = values.MemAvailable ?? ((values.MemFree || 0) + (values.Buffers || 0) + (values.Cached || 0) + (values.SReclaimable || 0) - (values.Shmem || 0));
  const used = total - Math.max(0, Math.min(total, available));
  return { total_bytes: total, used_bytes: used, percent: Math.round(used / total * 1000) / 10 };
}

export async function readCpuTemperature(root = '/sys/class/thermal') {
  const entries = await fs.readdir(root);
  const readings = await Promise.all(entries.filter(name => /^thermal_zone\d+$/.test(name)).map(async name => {
    try {
      const [type, raw] = await Promise.all([fs.readFile(path.join(root, name, 'type'), 'utf8'), fs.readFile(path.join(root, name, 'temp'), 'utf8')]);
      const value = Number(raw.trim()) / 1000;
      if (!/cpu|soc|package/i.test(type) || !raw.trim() || !Number.isFinite(value) || value < -100 || value > 200) return null;
      return { value, priority: /cpu|package/i.test(type) ? 0 : 1 };
    } catch { return null; }
  }));
  const sensor = readings.filter(Boolean).sort((a, b) => a.priority - b.priority)[0];
  return sensor ? Math.round(sensor.value * 10) / 10 : null;
}

export function installSystemStatus(app, { voiceConfig } = {}) {
  let previous = null, running = false;
  const empty = { cpu_percent: null, memory: null, cpu_temperature_c: null, cameras: null, voice_online: null, sampled_at: null };
  let snapshot = empty;
  async function sample() {
    if (running) return;
    running = true;
    try {
      const [cpu, memory, temperature, cameras, voice] = await Promise.allSettled([
        fs.readFile('/proc/stat', 'utf8'), fs.readFile('/proc/meminfo', 'utf8'), readCpuTemperature(),
        readCameras(), voiceConfig ? readVoiceModule(voiceConfig) : null
      ]);
      const current = cpu.status === 'fulfilled' ? parseCpu(cpu.value) : null;
      snapshot = {
        cpu_percent: cpuPercent(previous, current),
        memory: memory.status === 'fulfilled' ? parseMemory(memory.value) : null,
        cpu_temperature_c: temperature.status === 'fulfilled' ? temperature.value : null,
        cameras: cameras.status === 'fulfilled' ? cameras.value : null,
        voice_online: voice.status === 'fulfilled' ? voice.value : null,
        sampled_at: Date.now()
      };
      previous = current;
    } finally { running = false; }
  }
  sample();
  const timer = setInterval(sample, 2000); timer.unref();
  app.get('/api/system-status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fresh = snapshot.sampled_at !== null && Date.now() - snapshot.sampled_at < 8000;
    res.json({ success: true, hostname: os.hostname(), ros_domain_id: Number(process.env.ROS_DOMAIN_ID ?? 0), ...(fresh ? snapshot : empty),
      robot_model: await robotModelState().catch(() => null), server_time: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  });
}
