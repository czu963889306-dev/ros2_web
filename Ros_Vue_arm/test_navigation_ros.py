"""Run ONLY in isolated ROS_DOMAIN_ID=198 with ROS_LOCALHOST_ONLY=1. No robot moves."""
import json
import math
import os
import queue
import subprocess
import sys
import threading
import time
import tempfile
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped
from std_msgs.msg import Empty, String

assert os.environ.get('ROS_DOMAIN_ID') == '198' and os.environ.get('ROS_LOCALHOST_ONLY') == '1', 'Isolated ROS domain required'
rclpy.init()
node = Node('lite_navigation')
goals, cancels, replies = queue.Queue(), queue.Queue(), queue.Queue()
node.create_subscription(PoseStamped, '/goal_pose', goals.put, 5)
node.create_subscription(Empty, '/lite_navigation/cancel', cancels.put, 5)
latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL, reliability=ReliabilityPolicy.RELIABLE)
status = node.create_publisher(String, '/lite_navigation/status', latched)
pose = node.create_publisher(PoseWithCovarianceStamped, '/amcl_pose', 5)
def tick():
    p = PoseWithCovarianceStamped(); p.header.frame_id = 'map'; p.pose.pose.orientation.w = 1.0
    pose.publish(p)
node.create_timer(0.1, tick)
def spin():
    try: rclpy.spin(node)
    except rclpy.executors.ExternalShutdownException: pass
spin_thread = threading.Thread(target=spin, daemon=True)
spin_thread.start()
proc = subprocess.Popen(['/root/chuyun_ws/install/chuyun_navigation2/lib/chuyun_navigation2/web_navigation_bridge'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def read():
    for line in proc.stdout:
        replies.put(json.loads(line))
threading.Thread(target=read, daemon=True).start()
serial = 0
def call(method, params=None):
    global serial
    serial += 1
    proc.stdin.write(json.dumps({'id': serial, 'method': method, 'params': params or {}}) + '\n'); proc.stdin.flush()
    result = replies.get(timeout=8)
    assert result['id'] == serial
    return result
try:
    status.publish(String(data='IDLE'))
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = call('state')['result']
        if state['connected'] and state['pose']: break
        time.sleep(0.2)
    assert state['connected'] and not state['ready'], state
    target = {'frame_id': 'map', 'x': 1.25, 'y': -2.0, 'yaw': math.pi / 2}
    assert 'error' in call('go', target)
    assert goals.empty()
    status.publish(String(data='LOCALIZED')); time.sleep(0.3)
    assert call('state')['result']['ready']
    assert call('go', target)['result'] == {'submitted': True, 'arrived': False}
    message = goals.get(timeout=3)
    assert message.header.frame_id == 'map' and message.pose.position.x == 1.25 and message.pose.position.y == -2.0
    assert abs(message.pose.orientation.z - math.sqrt(0.5)) < 1e-6
    assert call('state')['result']['status'] == 'GOAL_SUBMITTED'
    status.publish(String(data='ARRIVED')); time.sleep(0.2)
    assert call('state')['result']['status'] == 'ARRIVED'
    assert call('cancel')['result']['submitted']; cancels.get(timeout=3)
    assert 'error' in call('go', {**target, 'x': None})
    print('PASS: isolated ROS2 readiness, exact PoseStamped, orientation, arrival status, cancellation, invalid goal')

    # Exercise actual speech-text routing -> stdio MCP -> HTTP -> isolated ROS.
    # Test targets and HTTP listener exist only in this test process.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'voice_assistant'))
    from assistant import Config, BailianClient
    test_points = {'A点': {**target, 'x': 1.911, 'y': -0.137},
                   'B点': {**target, 'x': 5.545, 'y': -2.435},
                   'C点': {**target, 'x': 4.118, 'y': 0.779}}
    class TestApi(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            assert self.path == '/api/navigation/points'
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'success': True, 'activeMap': 'isolated', 'points':
                [{'name': n, 'mapPath': 'isolated'} for n in test_points]}, ensure_ascii=False).encode())
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            point = test_points.get(body.get('name'))
            if self.path != '/api/navigation/go-to' or point is None:
                self.send_response(400); payload = {'success': False, 'error': '当前地图没有该点位。可用点位：A点、B点'}
            else:
                result = call('go', point)
                assert 'error' not in result, result
                self.send_response(200); payload = {'success': True, **result['result'], 'point': {'name': body['name']}}
            self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), TestApi)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'config.yaml'
            config.write_text('DASHSCOPE_API_KEY: test\nVISION_MCP_ENABLED: true\nROS2_WEB_API_URL: http://127.0.0.1:' + str(server.server_port) + '/api\n')
            client = BailianClient(Config.from_file(config))
            try:
                for name, point in test_points.items():
                    spoken = 'C顶' if name == 'C点' else name
                    answer = ''.join(client.chat_stream([{'role': 'user', 'content': '导航到' + spoken + '。'}]))
                    assert '已下发前往' + name in answer, answer
                    goal = goals.get(timeout=3)
                    assert goal.pose.position.x == point['x'] and goal.pose.position.y == point['y']
                answer = ''.join(client.chat_stream([{'role': 'user', 'content': '导航到一号位。'}]))
                assert '未成功' in answer and 'A点、B点' in answer and goals.empty(), answer
            finally:
                if client.mcp: client.mcp.close()
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)
    print('PASS: A/B and C顶 -> C点 -> real stdio MCP -> HTTP -> isolated ROS2 goals; unknown name rejected')
finally:
    try:
        proc.stdin.close()
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill(); proc.wait(timeout=3)
        rclpy.shutdown()
        spin_thread.join(timeout=5)
        node.destroy_node()
