# 机器人中控台 (Robot Control Console)

## 项目简介

这是一个基于 Web 的机器人中控台，用于实时监控和控制 ROS 2 机器人。该项目集成了地图展示、摇杆控制、状态监测以及建图管理等功能。

项目演示视频：[Bilibili](https://www.bilibili.com/video/BV1wx326wEw6/?vd_source=339f0240733dcda285627ff53cbd145f)

![1](Ros_Vue_arm/img/image.png)

## 核心功能

* 实时 SLAM 栅格地图显示。
* 机器人摇杆远程控制。
* 电池电压与里程计数据实时监测。
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
* **`tasks.navigation`**: 导航启动命令，当前为 `ros2 launch xuegecar_navigation2 navigation2.launch.py`。
* **`save_map.save_dir`**: 地图保存目录，当前为 `/root/chuyun_ws/src/xuegecar_navigation2/maps`。
* **`maps_dir`**: 历史地图读取目录，当前为 `/root/chuyun_ws/src/xuegecar_navigation2/maps`。
* **`camera.stream_url`**: 摄像头视频流地址，当前为 `http://192.168.31.194:8081/`。
* **`topics`**: 前端订阅和发布的 ROS 2 话题名。如果机器人的话题名不同，请直接修改这里。

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
* `battery`
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
`/root/chuyun_ws/src/xuegecar_navigation2/maps`

## 技术路线

* 前端框架：Vue 3 + Vite
* 后端服务：Node.js (Express)
* 协议：Foxglove WebSocket v1 协议
* 机器人系统：ROS 2
