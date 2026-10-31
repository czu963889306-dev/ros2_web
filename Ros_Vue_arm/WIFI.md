# Wi-Fi 设置

在机器人中控台顶部查看 **Wi-Fi IP** 和当前网络名称，点击 **Wi-Fi 连接** 打开设置。

1. 页面自动扫描附近的 Wi-Fi，也可点击“重新扫描”。列表显示信号强度、频段、加密方式和当前连接。
2. 选择网络，输入密码后点击“连接 Wi-Fi”。已保存的网络可留空使用原密码。
3. 成功后保存连接并启用自动连接；连接失败时尝试恢复原 Wi-Fi。

切换网络可能使网页与设备断开。电脑或手机需接入同一网络，再使用设备的新 IP 访问 `http://设备IP:5173`。设备通过 DHCP 获取无线 IP，地址可能改变。也可通过已配置的有线地址 `http://192.168.2.2:5173` 访问，电脑需在同一有线网段。

支持个人 WPA/WPA2、WPA3、OWE 和开放网络。暂不支持 WEP、企业认证或手动添加隐藏 SSID。顶部显示无线接口的 IPv4，每 3 秒更新；无法读取时显示“读取失败”，不会把旧地址当作当前状态。

## 运行要求与实现

后端需要 `/usr/bin/nmcli` 和运行中的 NetworkManager，以及管理无线连接和写入 `/etc/NetworkManager/system-connections` 的权限。当前设备由 root 运行 ros2-web。只管理无线接口，优先使用 `wlan0`。

- `wifi.js`：NetworkManager 适配、网络扫描、异步连接任务及失败回退。
- `src/components/WifiSettings.vue`：中文设置弹窗和顶部状态。
- `GET /api/wifi/status`：无线状态及 IP。
- `POST /api/wifi/scan`：扫描网络。
- `POST /api/wifi/connect`：提交 `{ssid, bssid, password}`，返回连接任务。
- `GET /api/wifi/jobs/:id`：查询连接结果。

POST 请求使用 JSON 和 `X-Wifi-Settings: 1`，浏览器来源限设备本身的 5173/3000 端口。密码不进入命令行参数、日志或 API 返回；新配置文件权限为 0600，失败时清理新配置。原有已保存网络保留。服务沿用中控台现有的局域网访问方式。

设置弹窗阻止控制键事件传播，打开时停止键盘控制。密码提交或收起弹窗后清空。

## 验证

```bash
node --test *.test.js
npm run build
```

自动化覆盖 SSID 转义和去重、输入校验、密码处理、连接成功保存、失败回退、回退失败报告、并发限制和 HTTP 请求校验。
