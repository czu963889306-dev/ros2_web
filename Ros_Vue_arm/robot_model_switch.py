"""Apply and verify the persisted model on this host, without restarting the chassis."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

from ament_index_python.packages import get_package_share_directory
import rclpy
from rclpy.qos import DurabilityPolicy, QoSProfile
from std_msgs.msg import String
from tf2_msgs.msg import TFMessage

CONFIG = Path('/etc/default/chuyun-robot-model')
UNIT = 'chuyun-robot-model.service'
MODELS = ('LEAP_ROS', 'LEAP_ROS_MAX', 'LEAP_ROS_PRO')


def persist(model):
    text = f'CHUYUN_ROBOT_MODEL={model}\nCHUYUN_MODEL_REVISION={uuid.uuid4().hex}\n'
    with tempfile.NamedTemporaryFile('w', dir=CONFIG.parent, delete=False) as f:
        try:
            f.write(text)
            f.flush()
            os.fchmod(f.fileno(), 0o644)
            os.fsync(f.fileno())
            os.replace(f.name, CONFIG)
        finally:
            Path(f.name).unlink(missing_ok=True)


def verify(model):
    name = model.lower()
    path = Path(get_package_share_directory('chuyun_description')) / 'urdf' / name / (name + '.urdf')
    xml = path.read_text().strip()
    fixed = {(j.find('parent').get('link'), j.find('child').get('link'))
             for j in ET.fromstring(xml).findall('joint') if j.get('type') == 'fixed'}
    node = rclpy.create_node('console_check_model_' + str(os.getpid()), start_parameter_services=False, enable_rosout=False)
    qos = QoSProfile(depth=10, durability=DurabilityPolicy.TRANSIENT_LOCAL)
    seen = set()
    description = None

    def receive(msg):
        nonlocal description
        description = msg.data.strip()

    def edges(msg):
        seen.update((t.header.frame_id, t.child_frame_id) for t in msg.transforms)

    try:
        node.create_subscription(String, '/robot_description', receive, qos)
        node.create_subscription(TFMessage, '/tf_static', edges, qos)
        deadline = time.monotonic() + 13
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.15)
            if description == xml and fixed <= seen:
                publishers = node.get_publishers_info_by_topic('/robot_description')
                if len(publishers) == 1 and publishers[0].node_name == 'robot_state_publisher':
                    return
        raise RuntimeError('未收到所选 URDF、完整静态 TF 或唯一的模型发布者')
    finally:
        node.destroy_node()


def activate(model):
    persist(model)
    subprocess.run(['systemctl', 'restart', UNIT], check=True, timeout=24)
    verify(model)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('target', choices=MODELS)
    parser.add_argument('expected', nargs='?', choices=MODELS)
    args = parser.parse_args()
    rclpy.init(args=[])
    try:
        if not args.expected:
            verify(args.target)
            return
        config = dict(line.split('=', 1) for line in CONFIG.read_text().splitlines())
        old = config['CHUYUN_ROBOT_MODEL']
        if old != args.expected:
            raise RuntimeError('型号已被其他页面更改，请刷新重试')
        if old == args.target:
            try:
                verify(old)
                return
            except RuntimeError:
                pass
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'leap_ros_bringup.service']).returncode:
            raise RuntimeError('底盘 bringup 服务未运行')
        try:
            activate(args.target)
        except Exception:
            activate(old)
            raise RuntimeError('新型号未能生效，已恢复 ' + old)
    finally:
        rclpy.try_shutdown()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
