#!/bin/bash
# =================================================================
# 出云中控台启动脚本
# =================================================================

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WORKSPACE_DIR="$SCRIPT_DIR"

echo "---------------------------------------------------"
echo "正在启动出云中控台..."
echo "工作目录: $WORKSPACE_DIR"
echo "---------------------------------------------------"

# 1. 检查并加载 Node.js 环境 (适配 WSL/NVM)
echo "检查 Node.js 环境..."
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
fi

if ! command -v node &> /dev/null; then
    echo "错误: 未检测到 Node.js。请确保已安装 Node.js (建议使用 NVM)。"
    exit 1
fi

# 2. Load ROS and source-built workspaces in dependency order.
echo "正在加载 ROS、底盘、SLAM 和 Nav2 源码工作空间..."
for ros_setup_file in \
    /opt/ros/humble/setup.bash \
    /root/chuyun_ws/install/local_setup.bash \
    /root/slam_ws/install/local_setup.bash \
    /root/nav2_ws/install/local_setup.bash; do
    if [ ! -f "$ros_setup_file" ]; then
        echo "错误: 缺少工作空间安装环境 $ros_setup_file" >&2
        exit 1
    fi
    source "$ros_setup_file" || exit 1
done
unset ros_setup_file

# 2.6 WSL 兼容性设置
export QT_X11_NO_MITSHM=1
export LIBGL_ALWAYS_SOFTWARE=0 # 如果仿真崩溃，可尝试改为 1

if ! command -v ros2 &> /dev/null; then
    echo "错误: 依然无法加载 ROS 2 环境，请检查安装。"
    exit 1
fi

if ! ros2 pkg list | grep "foxglove_bridge" > /dev/null 2>&1; then
    echo "警告: 未检测到 foxglove_bridge。可以运行: sudo apt install -y ros-humble-foxglove-bridge"
else
    echo "OK: Foxglove Bridge 已准备就绪。"
fi

# 进入项目目录
cd "$WORKSPACE_DIR" || { echo "错误: 无法进入目录 $WORKSPACE_DIR"; exit 1; }

# 3. 检查 node_modules 是否存在
if [ ! -d "node_modules" ]; then
    echo "未检测到 node_modules，正在安装依赖..."
    npm install
fi

# 获取本机 IP (用于显示访问地址)
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "中控台即将运行。"
echo "本机访问地址: http://localhost:5173"
if [ -n "$LOCAL_IP" ]; then
    echo "外部设备访问: http://$LOCAL_IP:5173"
fi
echo "按下 Ctrl+C 可停止运行。"
echo "---------------------------------------------------"

# 4. 启动后端服务 (管理 ROS 2 任务)
if [ -f "server.js" ]; then
    echo "正在启动后端服务 (端口 3000)..."
    node server.js &
    BACKEND_PID=$!
    
    # 等待后端启动
    # Wait for the backend HTTP endpoint and retry the startup trigger.
    # During boot, Node/ROS initialization can take longer than two seconds.
    echo "Waiting for the backend service..."
    startup_triggered=false
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 2 -X POST http://localhost:3000/api/run_task/startup > /dev/null; then
            startup_triggered=true
            echo "Automatic startup triggered."
            break
        fi
        sleep 1
    done
    if [ "$startup_triggered" != true ]; then
        echo "Error: backend did not become ready within 30 seconds." >&2
        exit 1
    fi
    
    # 处理退出信号，确保先停止 ROS 任务再关闭后端
    CLEANUP_DONE=false
    cleanup() {
        if [ "$CLEANUP_DONE" = true ]; then return; fi
        CLEANUP_DONE=true
        
        echo ""
        echo "---------------------------------------------------"
        echo "正在停止出云中控台服务..."
        
        # 释放所有由后端启动的 ROS 任务 (静默执行)
        curl -s -X POST http://localhost:3000/api/stop_task/startup > /dev/null 2>&1
        curl -s -X POST 'http://localhost:3000/api/stop_task/mapping?scope=console-processes' > /dev/null 2>&1
        
        # 杀掉后端进程
        if [ -n "$BACKEND_PID" ]; then
            kill $BACKEND_PID 2>/dev/null
        fi
        
        echo "中控台已退出，未清理外部 ROS 进程。"
        echo "---------------------------------------------------"
    }
    trap cleanup INT TERM EXIT
else
    echo "警告: 未找到 server.js，后端服务未启动。"
fi

# 5. 提供已构建页面，避免服务重启时 HMR 自动刷新导致页面丢失
echo "正在启动前端界面..."
if [ ! -f dist/index.html ]; then
    npm run build || exit 1
fi
npm run preview -- --port 5173 --strictPort
