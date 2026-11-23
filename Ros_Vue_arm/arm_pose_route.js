// Keep DDS discovery and the service client alive in chuyun_arm_bridge.
export function registerArmPoseRoutes(app, loadConfig, bridgeUrl = 'http://127.0.0.1:18081') {
    async function forward(path, options, res) {
        try {
            const response = await fetch(`${bridgeUrl}${path}`, {
                ...options,
                signal: AbortSignal.timeout(3000)
            });
            const body = await response.json();
            return res.status(response.status).json(body);
        } catch (error) {
            const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
            return res.status(timedOut ? 504 : 503).json({
                success: false,
                error: timedOut
                    ? '等待机械臂桥接响应超时；指令可能已执行，请确认状态后再操作'
                    : '机械臂桥接服务不可用，请检查 chuyun-arm-bridge 服务',
                ...(timedOut ? { execution_unknown: true } : {})
            });
        }
    }

    app.get('/api/arm/health', (_req, res) => forward('/health', {}, res));

    app.post('/api/arm/pose', (req, res) => {
        const fields = ['x', 'y', 'z', 'pitch_deg'];
        if (fields.some((field) => typeof req.body?.[field] !== 'number'
            || !Number.isFinite(req.body[field]) || Math.abs(req.body[field]) > 3.402823466e38)) {
            return res.status(400).json({ success: false, error: 'X、Y、Z 和俯仰角必须是有效数字' });
        }
        const service = loadConfig().services?.set_arm_pose || '/set_arm_pose';
        if (!/^\/[a-zA-Z0-9_/]+$/.test(service)) {
            return res.status(500).json({ success: false, error: '机械臂服务名配置无效' });
        }
        return forward('/pose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...Object.fromEntries(fields.map((field) => [field, req.body[field]])),
                service
            })
        }, res);
    });
}
