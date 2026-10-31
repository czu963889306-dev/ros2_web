# 机器人中控台 (Robot Control Console)

## 项目简介

这是一个基于 Web 的机器人中控台，用于实时监控和控制 ROS 2 机器人。该项目集成了地图展示、摇杆控制、状态监测以及建图管理等功能。

项目演示视频：[Bilibili](https://www.bilibili.com/video/BV1wx326wEw6/?vd_source=339f0240733dcda285627ff53cbd145f)

![1](img/image.png)

## 核心功能

* 顶部显示当前 Wi-Fi IP，支持扫描和连接无线网络，详见 [Wi-Fi 设置](WIFI.md)。

* 实时 SLAM 栅格地图显示。
* 机器人摇杆与键盘远程控制：W/S 前后、Q/E 横移、A/D 转向，并可在控制卡片中设置线速度和角速度。
* 机械臂控制工具栏：支持 1–5 号舵机角度、一键回正（90°/0°/180°/180°/180°，通道间隔 1.2 秒）和末端 X/Y/Z/俯仰角目标设置。
* 里程计数据实时监测。
* 自动发现并播放 MediaMTX WebRTC 通道，同时支持 HTTP/MJPEG 摄像头地址。
* Foxglove Bridge 仅开放中控台所需话题和客户端发布能力，以降低板端 CPU 占用。
* 网页订阅 12 Hz 的 `/web/tf` 和 10 Hz 的 `/web/odom`；机器人控制与导航仍使用原始 `/tf` 与 `/odom`。开机服务使用惰性订阅，无网页客户端时不处理上游数据。
* 可视化建图控制（开始/停止建图）。
* 地图保存功能，支持在网页端输入地图名称。
* 视图自动重置功能，在开始建图/导航时自动对齐视野。
* 页面自动连接 Foxglove WebSocket（默认 `ws://<页面主机>:8765`）。
* 连接成功会显示“已连接”，连接失败会显示错误信息。

## 环境要求

* Ubuntu 22.04 (WSL 兼容)
* ROS 2 Humble
* Node.js (建议版本 v18+)
* foxglove_bridge

## 快速启动

在项目根目录下执行以下脚本，即可同时启动后端服务和前端界面：

```bash
bash start_console.sh
```

启动成功后，在浏览器访问：`http://localhost:5173`

## 部署配置 (重要)

当您将项目部署到自己的电脑或机器人上时，ROS 2 启动命令、话题名、地图路径、摄像头地址等运行配置均以项目根目录下的 `ros_config.json` 为准。

如果 README 中的说明与 `ros_config.json` 当前内容不一致，请以 `ros_config.json` 为准。

### 1. 修改 `ros_config.json`

该文件位于项目根目录，控制着所有 ROS 2 指令的触发和路径：

* **`tasks.startup`**: 后台启动任务，当前用于启动 Foxglove Bridge。
* **`tasks.mapping`**: 建图启动命令，当前为 `ros2 launch slam_gmapping slam_gmapping.launch.py`。
* **`tasks.navigation`**: 导航启动命令，当前为 `ros2 launch chuyun_navigation2 lite_navigation.launch.py`，使用单进程轻量定位、A* 与全向路径跟踪。
* **`save_map.save_dir`**: 地图保存目录，当前为 `/root/chuyun_ws/src/chuyun_navigation2/maps`。
* **`maps_dir`**: 历史地图读取目录，当前为 `/root/chuyun_ws/src/chuyun_navigation2/maps`。
* **`camera.stream_url`**: 摄像头视频流路径，默认使用 `/stream`；后端会根据访问网页的主机名和 `camera.stream_port` 自动生成完整地址。* **`topics`**: 前端订阅和发布的 ROS 2 话题名。如果机器人的话题名不同，请直接修改这里。

## 配置说明

项目核心逻辑由 `ros_config.json` 驱动，你可以直接在该文件中修改 ROS 2 指令：

* `startup`: 配置后台自动运行的任务（如 Foxglove Bridge 的高带宽模式设置）。
* `mapping`: 配置建图算法及其参数。
* `navigation`: 配置导航启动命令及参数。
* `save_map`: 配置地图保存命令及保存路径。
* `camera`: 配置摄像头视频流地址。
* `topics`: 配置前端使用的话题名（不同机器人可直接改这里）。

`topics` 典型字段：

* `cmd_vel`
* `map`
* `costmap`
* `scan`
* `tf`
* `odom`
* `plan`
* `goal_pose`
* `initial_pose`
* `navigate_feedback`
* `imu`

## 地图保存说明

通过网页端保存的地图文件（.yaml 和 .pgm）默认存储在以下路径：
`/root/chuyun_ws/src/chuyun_navigation2/maps`

## 技术路线

* 前端框架：Vue 3 + Vite
* 后端服务：Node.js (Express)
* 协议：Foxglove WebSocket v1 协议
* 机器人系统：ROS 2
# 大模型配置

## 顶部系统资源

顶部状态栏显示 CPU 占用率、内存使用率、CPU 温度和设备时间。
GET `/api/system-status` 返回设备数据，服务器每 2 秒缓存一次采样，网页每 2 秒刷新，时钟每秒更新。
CPU 为所有核心平均占用率；内存为 MemTotal 减 MemAvailable；温度优先取 CPU 传感器，RK3566 可使用 soc-thermal。
数据不可用时显示“—”。设备时间使用服务器系统时钟与时区，不修改系统时间。

模型、音色、地域及接口地址使用单选下拉列表，API Key 和业务空间 ID 保留输入框。
切换语音合成模型会联动兼容音色，切换北京/新加坡会联动模型与语音接口地址。
已保存但不在预置列表的配置会保留为“当前配置”，打开面板不会覆盖原值。

## 电池状态

订阅标准 `sensor_msgs/msg/BatteryState`，默认话题 `/battery_state`，可通过 ros_config.json 的 topics.battery_state 调整。
Foxglove 白名单必须同时允许该话题。支持 JSON 和 CDR 消息。
顶部显示电量，右侧卡片显示百分比、电压和充电状态；电量使用消息中 0–1 的 percentage，不根据电压猜测。
低于或等于 20% 标红，NaN/未知数据不显示成 0，15 秒无新消息显示过期，断线后清空读数。

验证：`node --test battery.test.js`。CDR 夹具由 ROS2 rclpy 序列化生成。

顶部“大模型配置”按钮打开侧边面板，可通过“收起”、关闭按钮或 Esc 关闭。
面板支持 API Key、Base URL、对话模型，以及语音识别/合成、音色、视觉模型和业务空间设置。
内含千问百炼 API Key 管理、控制台与官方配置帮助链接。

API Key 留空保留现有值，读取接口只返回“是否已配置”，不回显现有密钥。
“仅保存”写入原有 `/root/voice_assistant/config.yaml`；“保存并应用”保存后重启 `voice-assistant`。
配置文件以 0600 权限原子替换，录音、摄像头、唤醒词和导航等其他配置保留。
接口为 GET/PUT `/api/model-settings`，PUT 需要 JSON 和 `X-Model-Settings: 1` 请求头。



### 建图算法选择（250，2026-10-22）

连接机器人后，点击「开始建图」打开选择弹窗，选择 Cartographer、Gmapping 或 SLAM Toolbox，再点击「开始建图」。状态栏显示正在运行的算法。切换前先停止当前建图；导航与建图互斥。

- `GET /api/mapping_algorithms`：获取选项。
- `POST /api/start_mapping`：JSON `{ "algorithm": "cartographer" | "gmapping" | "slam_toolbox" }`。未提供算法时使用 `default_mapping_algorithm`（默认 `slam_toolbox`）。
- `POST /api/stop_mapping`：停止当前算法并等待整个 ROS 启动进程组退出。
- `GET /api/mapping_status`：返回 `isRunning`、`algorithm`、`label`、`isTransitioning`、`error`。
- 原通用 `/api/run_task/mapping`、`/api/stop_task/mapping`、`/api/task_status/mapping` 共用同一状态和互斥控制。

命令定义在 `ros_config.json` 的 `mapping_algorithms`，API 只接受上述三个算法 ID。Cartographer 使用 `chuyun_laser_2d_ekf.lua`，订阅 `/odometry/filtered`，只发布 `map -> odom`；底盘 EKF 继续发布 `odom -> base_footprint`。

`PORT` 可指定后端端口；`ROS_LOCALHOST_ONLY` 未指定时为 `0`。隔离测试使用端口 3011、ROS 域 216 和 `ROS_LOCALHOST_ONLY=1`，不向实车发送目标或速度。

本次核查：250 网页导航仍使用 `lite_navigation.launch.py` 和 `lite_navigation_diff/omni.yaml`；52 网页使用 `nav2_rk3566.launch.py` 和 `nav2_rk3566_diff/omni.yaml`。迁移的 `nav2_ws` 默认参数相同，但网页导航启动配置不同。


### 导航方式选择（250）

选择地图后点击“开始导航”，在弹窗选择 Nav2 或 Lite，再选择差速轮或麦克纳姆轮。
关闭导航后可以重新选择；建图与导航互斥，停止会等待整个进程组退出。

- Nav2：`nav2_rk3566.launch.py`，使用从 52 同步的 `nav2_rk3566_diff.yaml` / `nav2_rk3566_omni.yaml`。
- Lite：`lite_navigation.launch.py`，保留 `lite_navigation_diff.yaml` / `lite_navigation_omni.yaml`。
- `GET /api/navigation_engines` 返回选项；`POST /api/start_navigation` 接收 `engine` (`nav2` / `lite`)、`mapPath`、`driveType` (`diff` / `omni`)。省略 `engine` 时默认 Lite。
- `/api/navigation_status` 返回当前导航方式、地图、底盘及进程状态；进程启动不代表定位已经就绪。
- 两种导航共用 `/goal_pose`、`/initialpose`；Nav2 使用 action 反馈与 `/navigation/cancel`，Lite 使用 `/lite_navigation/feedback`、`/lite_navigation/cancel`。网页和预设点接口会按当前导航方式选择。
- Nav2 启动文件沿用 250 的 DDS 发现设置，不强制使用 52 的本机过滤配置。

验证：`node --test *.test.js`、`npm run build`。ROS 隔离验证记录位于 `/root/ros_navigation_update_20261022/`。


### RK3528 上的 Nav2 TF 运行库

250 的硬件已确认是 RK3528，`nav2_rk3566` 名称沿用 52 的参数配置。导航 YAML 与 52 保持一致。
当前 Nav2 启动文件仅为子进程添加 `/root/nav2_ws/tf2_compat_0_25_22/lib`，加载从 52 同步的两个 TF2 0.25.22 库，避免系统 TF2 0.25.23 与迁移 Nav2 组合出现的异步 TF 等待死锁。该目录是当前使用的运行依赖，不是备份。
验证和来源记录：`/root/nav2_localization_fix_20261022/`、`/root/nav2_ws/tf2_compat_0_25_22/manifest.json`。

## 语音助手配置

顶部「语音助手配置」可设置快照地址和画面来源、USB 摄像头参数、唤醒词、提示词、录音判定、音量、网络超时及语音导航接口。

快照地址支持 `http://{wifi_ip}:8080/snapshot`，每次取图动态使用当前 Wi-Fi IP；同机摄像头也可使用 `http://127.0.0.1:8080/snapshot`。保存的是语音助手 `/root/voice_assistant/config.yaml` 中的对应字段，模型和 API Key 仍在「大模型配置」中管理。

「仅保存」在下次语音助手启动时生效；「保存并应用」会重启语音助手并结束当前对话。保存会校验输入并保留其他配置。两个配置入口共用写入锁，避免同时保存覆盖。

接口为 `GET/PUT /api/voice-settings`，写入使用 JSON、`X-Voice-Settings: 1` 和 `apply` 布尔参数。

## 服务与日志

`start_console.sh` 提供已构建页面，避免开发服务器自动刷新干扰中控台重启恢复。修改前端后执行 `npm run build` 更新 `dist`，访问端口仍为 5173。

顶部「服务日志」打开服务窗口，名单直接读取 `/root/ros_service_ctl.sh services`，包括原有 6 个服务及 `voice-assistant.service`。Qwen、SSH 等脚本名单外的服务不能通过窗口查看日志或操作。

选中服务后可查看状态和最近 100/200/500 行 systemd journal 日志，支持每 3 秒自动刷新、暂停刷新和跟随末尾。启动、停止、重启只改变当前运行状态，不修改开机自启设置。

操作在独立的 systemd 临时任务中运行，结果存放于 `/run/ros2-web-service-actions`，中控台重启后仍可查询。该目录只保留最近 50 个操作记录，重启设备后清空。

停止中控台会断开网页，需通过 SSH 执行 `bash /root/ros_service_ctl.sh start ros2-web` 恢复。话题降频服务是中控台的依赖，停止或重启它也可能使网页断开。窗口会显示相应提示。

接口：`GET /api/services`、`GET /api/services/logs?unit=...&lines=200`、`POST /api/services/action`、`GET /api/services/jobs/:id`。写入使用 JSON 和 `X-Service-Manager: 1`；只允许完整白名单服务名及 start/stop/restart。
