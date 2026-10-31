# 语音导航点

1. 打开 http://192.168.31.250:5173 ，选择地图和底盘，开始导航。
2. 设置初始位置，等待定位就绪。
3. 在“语音导航点”取当前位置、双击地图选点，或填写地图坐标（米）和朝向（度）。选点只填表，不启动移动。
4. 填写名称，例如“厨房”，点击添加点位。支持修改、删除和点击前往。
5. 说“你好小云”，然后说“导航到厨房”。还可以说“有哪些导航点”“停止导航”“还有多远”。

点位按地图保存到 `/root/ros2_web/navigation_points.json`，重启不会丢失。
重启后仍需选择地图、开始导航并确认定位。语音工具不会自行启动导航或选择底盘。
同一地图名称不能重复；匹配忽略标点和空白，不跨地图或猜测相似点位。
“目标已下发”仅表示消息已经发布。到达、规划失败、激光数据过期、受阻等状态来自导航节点。
使用语音前请刷新旧网页，确保网页多点队列能在语音目标下发时退出。

## 配置与接口

语音助手 `/root/voice_assistant/config.yaml`：

```yaml
VISION_MCP_ENABLED: true
NAVIGATION_MCP_ENABLED: true
ROS2_WEB_API_URL: "http://127.0.0.1:3000/api"
```

导航与图片识别共用原 stdio MCP 服务，原 API 密钥保留在 config.yaml。
MCP 工具：`list_navigation_points`、`navigate_to_point(name)`、`cancel_navigation`、`get_navigation_status`。
点位和视觉返回的文本仅作为数据，不作为模型指令。

HTTP 接口沿用中控台的局域网访问方式：

- GET/POST `/api/navigation/points`：查询/创建；查询可按 mapPath 过滤。
- PUT/DELETE `/api/navigation/points/:id`：修改/删除。
- POST `/api/navigation/go-to`：按 id 或 name 前往当前地图的点。
- POST `/api/navigation/cancel`：取消当前目标。
- GET `/api/navigation/state`：连接、定位、状态、剩余距离。

当前连接已有的 `lite_navigation`：PoseStamped `/goal_pose`，Empty `/lite_navigation/cancel`，String `/lite_navigation/status`，PoseWithCovarianceStamped `/amcl_pose`。这不是 Nav2 action 客户端。
话题可在 ros_config.json 的 topics 中配置，新增可选键 navigation_status、localized_pose。

## 验证

```bash
node --test navigation.test.js
source /opt/ros/humble/setup.bash
source /root/chuyun_ws/install/setup.bash
ROS_DOMAIN_ID=198 ROS_LOCALHOST_ONLY=1 python3 test_navigation_ros.py
python3 -m unittest discover -s /root/voice_assistant/tests -q
```

ROS 测试使用隔离域中的模拟导航节点，不会移动实机；请勿改为机器人的 ROS 域。
实际环境需由使用者设置有效点位并进行实地导航验收。
