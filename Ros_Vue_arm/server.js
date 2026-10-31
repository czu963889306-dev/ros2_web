import express from 'express';
import cors from 'cors';
import { PointStore, RosBridge, installNavigation } from './navigation.js';
import { installModelSettings, installVoiceSettings } from './model_settings.js';
import { installSystemStatus } from './system_status.js';
import { installWifi } from './wifi.js';
import { installServiceManager } from './service_manager.js';
import { installMapping } from './mapping.js';
import { installMapSaving } from './map_save.js';
import { installNavigationEngines } from './navigation_engines.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the installed source workspaces directly; no extra workspace-root script.
const ROS_SETUP_COMMAND = [
    '/opt/ros/humble/setup.bash',
    '/root/chuyun_ws/install/local_setup.bash',
    '/root/slam_ws/install/local_setup.bash',
    '/root/nav2_ws/install/local_setup.bash'
].map(file => 'source ' + shellQuote(file)).join(' && ');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());
installModelSettings(app, __dirname);
installVoiceSettings(app, __dirname);
installSystemStatus(app);
installWifi(app);
installServiceManager(app, __dirname);

// 记录所有后端的子进程
let activeProcesses = {};

// Use normal DDS discovery so this console receives ROS 2 messages from
// both this host and other hosts on the local network.
process.env.ROS_LOCALHOST_ONLY ??= '0';
delete process.env.FASTRTPS_DEFAULT_PROFILES_FILE;
delete process.env.FASTDDS_DEFAULT_PROFILES_FILE;

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 加载配置文件
function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'ros_config.json');
        const data = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('无法读取配置文件:', err);
        return { tasks: { mapping: [] } };
    }
}

let navigator;
const navigationRunning = () => navigator?.running() || false;
const navigationBridge = new RosBridge(__dirname);
installNavigation(app, {
    store: new PointStore(path.join(__dirname, 'navigation_points.json'), () => loadConfig().maps_dir || loadConfig().save_map.save_dir),
    bridge: navigationBridge, session: () => navigator?.session() || {}, running: navigationRunning
});

// 运行时配置（前端可读取的可配置项）
function cameraStreamUrlForRequest(req, camera = {}) {
    const forwardedProto = req.get('x-forwarded-proto');
    const protocol = (forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol) || 'http';
    const hostname = req.hostname || '127.0.0.1';
    const port = Number(camera.stream_port) || 8080;
    const configured = String(camera.stream_url || '').trim();

    if (!configured || configured.startsWith('/')) {
        const streamPath = configured || '/stream';
        const url = new URL(streamPath, 'http://' + hostname);
        url.protocol = protocol + ':';
        url.port = String(port);
        return url.toString();
    }

    try {
        const url = new URL(configured);
        if (['0.0.0.0', '127.0.0.1', 'localhost'].includes(url.hostname)) {
            url.hostname = hostname;
        }
        return url.toString();
    } catch {
        return configured;
    }
}

app.get('/api/runtime_config', (req, res) => {
    const config = loadConfig();
    res.json({
        topics: config.topics || {},
        services: config.services || {},
        camera: {
            ...(config.camera || {}),
            stream_url: cameraStreamUrlForRequest(req, config.camera || {})
        },
    });
});

// 提交机械臂末端位姿。success=true 仅表示控制器已接受目标。

app.post('/api/arm/pose', (req, res) => {
    const fields = ['x', 'y', 'z', 'pitch_deg'];
    const request = Object.fromEntries(fields.map((field) => [field, Number(req.body?.[field])]));
    if (fields.some((field) => !Number.isFinite(request[field]))) {
        return res.status(400).json({ success: false, error: 'X、Y、Z 和俯仰角必须是有效数字' });
    }

    const config = loadConfig();
    const serviceName = config.services?.set_arm_pose || '/set_arm_pose';
    if (!/^\/[a-zA-Z0-9_/]+$/.test(serviceName)) {
        return res.status(500).json({ success: false, error: '机械臂服务名配置无效' });
    }

    const payload = `{x: ${request.x}, y: ${request.y}, z: ${request.z}, pitch_deg: ${request.pitch_deg}}`;
    const command = [
        ROS_SETUP_COMMAND,
        `ros2 service call ${serviceName} leap_interfaces/srv/SetArmPose '${payload}'`
    ].join(' && ');

    const proc = spawn('bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let replied = false;

    const finish = (status, body) => {
        if (replied) return;
        replied = true;
        clearTimeout(timer);
        res.status(status).json(body);
    };

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', (error) => finish(500, { success: false, error: error.message }));
    proc.on('close', (code) => {
        if (code !== 0) {
            return finish(502, { success: false, error: stderr.trim() || `ROS 2 服务调用失败，退出码 ${code}` });
        }
        const accepted = /success\s*[=:]\s*(?:true|True)/.test(stdout);
        finish(accepted ? 200 : 422, {
            success: accepted,
            accepted,
            message: accepted ? '机械臂目标已提交' : '机械臂控制器拒绝了该目标',
            response: stdout.trim()
        });
    });

    const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(504, { success: false, error: '等待机械臂服务响应超时' });
    }, 10000);
});

async function fetchMediaMtxJson(baseUrl, path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
        const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`MediaMTX API ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

// 合并 MediaMTX 当前在线路径与已配置路径，供前端自动发现 WebRTC 通道。
app.get('/api/camera/streams', async (req, res) => {
    const config = loadConfig();
    const camera = config.camera || {};
    const apiBaseUrl = camera.mediamtx_api_url || 'http://127.0.0.1:9997';
    const streamMap = new Map();

    try {
        const results = await Promise.allSettled([
            fetchMediaMtxJson(apiBaseUrl, '/v3/paths/list'),
            fetchMediaMtxJson(apiBaseUrl, '/v3/config/paths/list')
        ]);

        const runtimeItems = results[0].status === 'fulfilled' ? (results[0].value.items || []) : [];
        const configuredItems = results[1].status === 'fulfilled' ? (results[1].value.items || []) : [];

        configuredItems.forEach((item) => {
            if (item?.name && item.name !== 'all_others') {
                streamMap.set(item.name, { name: item.name, ready: false, tracks: [] });
            }
        });

        runtimeItems.forEach((item) => {
            if (item?.name) {
                streamMap.set(item.name, {
                    name: item.name,
                    ready: Boolean(item.ready),
                    tracks: Array.isArray(item.tracks) ? item.tracks : []
                });
            }
        });

        const preferredPath = camera.preferred_webrtc_path || '';
        const streams = [...streamMap.values()].sort((a, b) => {
            if (a.ready !== b.ready) return a.ready ? -1 : 1;
            if (a.name === preferredPath) return -1;
            if (b.name === preferredPath) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({
            streams,
            webrtcPort: Number(camera.webrtc_port) || 8889,
            fallbackUrl: cameraStreamUrlForRequest(req, camera)
        });
    } catch (error) {
        res.status(503).json({
            streams: [],
            webrtcPort: Number(camera.webrtc_port) || 8889,
            fallbackUrl: cameraStreamUrlForRequest(req, camera),
            error: error.message
        });
    }
});


function spawnConfiguredTask(task) {
    const id = task.id;
    const command = task.command;
    const args = Array.isArray(task.args) ? task.args : [];
    const description = task.description || id;
    if (!id || !command || activeProcesses[id]) return false;

    console.log('[' + id + '] 启动: ' + description + ' (' + command + ' ' + args.join(' ') + ')');
    const fullCommand = ROS_SETUP_COMMAND + ' && exec ' + [command, ...args].map(shellQuote).join(' ');

    const proc = spawn('bash', ['-c', fullCommand], {
        detached: true,
        stdio: 'inherit'
    });

    proc.on('error', (err) => {
        console.error('[' + id + '] 启动错误:', err.message);
        if (activeProcesses[id] === proc) activeProcesses[id] = null;
    });

    proc.on('exit', (code) => {
        console.log('[' + id + '] 已退出 (代码: ' + code + ')');
        if (activeProcesses[id] === proc) activeProcesses[id] = null;
    });

    activeProcesses[id] = proc;
    return proc;
}

function scheduleConfiguredTask(task) {
    setTimeout(() => spawnConfiguredTask(task), Number(task.delay) || 0);
}

async function stopProcessById(id, proc = activeProcesses[id]) {
    if (!proc?.pid) return false;
    const signalGroup = signal => {
        try { process.kill(-proc.pid, signal); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    // Wait for the whole ROS launch process group before permitting another mapper.
    for (const [signal, waitMs] of [['SIGINT', 6000], ['SIGTERM', 2000], ['SIGKILL', 1000]]) {
        if (!signalGroup(signal)) return true;
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!signalGroup(0)) return true;
        }
    }
    throw new Error('任务进程尚未完全退出，请稍后重试');
}

const mapping = installMapping(app, { loadConfig, spawnTask: spawnConfiguredTask,
    stopTask: stopProcessById, navigationRunning });
navigator = installNavigationEngines(app, { loadConfig, spawnTask: spawnConfiguredTask,
    stopTask: stopProcessById, mappingRunning: () => mapping.running() });

// 通用启动任务接口
app.post('/api/run_task/:taskName', (req, res) => {
    if (req.params.taskName === 'navigation') return res.status(400).json({ success: false, error: '请通过开始导航接口指定地图和底盘' });
    const taskName = req.params.taskName;
    console.log(`收到启动任务请求: ${taskName}`);

    const config = loadConfig();
    const tasks = config.tasks[taskName] || [];

    if (tasks.length === 0) {
        return res.status(404).json({ success: false, error: `任务类别 ${taskName} 未定义或为空` });
    }

    try {
        tasks.forEach((task) => {
            const { id, command, args, delay, description } = task;

            scheduleConfiguredTask(task);
        });

        res.json({ success: true, message: `任务 [${taskName}] 已按配置启动` });
    } catch (error) {
        console.error(`[${taskName}] 启动失败:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Wait for navigation processes to exit before a mapper may claim map -> odom.
app.post('/api/stop_task/:taskName', async (req, res) => {
    const taskName = req.params.taskName;
    const tasks = loadConfig().tasks[taskName] || [];
    try {
        await Promise.all(tasks.map(task => stopProcessById(task.id)));
        res.json({ success: true, message: `任务 [${taskName}] 已停止` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 状态查询接口 (针对特定任务类别)
app.get('/api/task_status/:taskName', (req, res) => {
    const taskName = req.params.taskName;
    const config = loadConfig();
    const tasks = config.tasks[taskName] || [];

    const isRunning = tasks.some(task => !!activeProcesses[task.id]);
    res.json({ isRunning });
});

// 获取地图列表
app.get('/api/list_maps', (req, res) => {
    const config = loadConfig();
    const mapsDir = config.maps_dir || config.save_map?.save_dir || '/tmp';
    try {
        if (!fs.existsSync(mapsDir)) {
            return res.json({ maps: [] });
        }
        const files = fs.readdirSync(mapsDir)
            .filter(f => f.endsWith('.yaml'))
            .map(f => ({
                name: f.replace('.yaml', ''),
                path: path.join(mapsDir, f.replace('.yaml', ''))
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ maps: files });
    } catch (err) {
        console.error('[list_maps] 读取地图目录失败:', err);
        res.status(500).json({ maps: [], error: err.message });
    }
});

// Compatibility endpoint: use the selected engine's cancellation channel.
app.post('/api/cancel_navigation', async (req, res) => {
    try {
        if (!navigationRunning()) return res.status(409).json({ success: false, error: '导航未运行' });
        const result = await navigationBridge.call('cancel', { engine: navigator.session().engine, sessionId: navigator.session().proc?.pid || 0 });
        res.json({ success: true, ...result });
    } catch (error) { res.status(502).json({ success: false, error: error.message }); }
});

installMapSaving(app, { loadConfig, setupCommand: ROS_SETUP_COMMAND,
    mappingAlgorithm: () => mapping.status().algorithm });

// 停止所有活跃进程的函数
function stopAllProcesses() {
    navigationBridge.close();
    console.log('正在清理所有活跃进程...');
    Object.keys(activeProcesses).forEach((id) => {
        const proc = activeProcesses[id];
        if (proc && proc.pid) {
            try {
                process.kill(-proc.pid);
                console.log(`[${id}] 已停止`);
            } catch (e) {
                if (!e.message.includes('ESRCH')) {
                    console.error(`无法停止 ${id}:`, e.message);
                }
            }
            activeProcesses[id] = null;
        }
    });
}

// 监听进程退出信号
process.on('SIGINT', () => {
    stopAllProcesses();
    process.exit();
});

process.on('SIGTERM', () => {
    stopAllProcesses();
    process.exit();
});

app.listen(port, () => {
    console.log(`ROS 2 运行服务后端已启动并监听在 http://localhost:${port}`);
});
