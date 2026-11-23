"""Relay revision-tagged snapshots using two long-lived, depth-one DDS writers."""
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rosidl_runtime_py.convert import message_to_ordereddict
from std_msgs.msg import String
from tf2_msgs.msg import TFMessage


class ModelSnapshotRelay:
    def __init__(self, node, prefix):
        self.node = node
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.description = node.create_publisher(String, prefix + '/_model_description', latched)
        self.static_tf = node.create_publisher(String, prefix + '/_model_static_tf', latched)
        self.identity = None
        self.subscriptions = []
        self.writer_ids = None
        self.fixed = None
        self.transforms = {}

    def release_inputs(self):
        for sub in self.subscriptions:
            self.node.destroy_subscription(sub)
        self.subscriptions.clear()
        self.transforms.clear()
        self.fixed = None

    def refresh(self):
        try:
            lines = Path('/etc/default/chuyun-robot-model').read_text().splitlines()
            config = dict(line.split('=', 1) for line in lines)
            identity = (config['CHUYUN_ROBOT_MODEL'].lower(), config['CHUYUN_MODEL_REVISION'])
        except (OSError, KeyError, ValueError):
            return
        model, revision = identity
        if model not in ('leap_ros', 'leap_ros_max', 'leap_ros_pro') or not re.fullmatch('[0-9a-f]{32}', revision):
            return
        # Refresh input subscriptions when a DDS writer is replaced. The two web writers
        # survive every switch, so late clients receive only their latest snapshots.
        writers = tuple(tuple(sorted(bytes(p.endpoint_gid) for p in self.node.get_publishers_info_by_topic(topic)))
                        for topic in ('/robot_description', '/tf_static'))
        if identity == self.identity and writers == self.writer_ids:
            return
        self.release_inputs()
        self.identity, self.writer_ids = identity, writers
        def snapshot(pub, **content):
            payload = json.dumps(dict(revision=revision, **content), separators=(',', ':'), allow_nan=False)
            pub.publish(String(data=payload))

        if not all(writers):
            snapshot(self.description, data='')
            snapshot(self.static_tf, transforms=[])
            return
        receive_qos = QoSProfile(depth=32, durability=DurabilityPolicy.TRANSIENT_LOCAL,
                                 reliability=ReliabilityPolicy.RELIABLE)

        def receive_description(msg):
            try:
                root = ET.fromstring(msg.data)
                if root.get('name') != model:
                    return
                fixed = {(j.find('parent').get('link'), j.find('child').get('link'))
                         for j in root.findall('joint') if j.get('type') == 'fixed'}
            except (ET.ParseError, AttributeError):
                return
            snapshot(self.description, data=msg.data)
            if self.fixed == fixed:
                return
            self.fixed = fixed
            self.transforms.clear()
            if len(self.subscriptions) > 1:
                self.node.destroy_subscription(self.subscriptions.pop())
            self.subscriptions.append(self.node.create_subscription(TFMessage, '/tf_static', receive_tf, receive_qos))

        def receive_tf(msg):
            pairs = {(t.header.frame_id, t.child_frame_id) for t in msg.transforms}
            if ('base_footprint', 'base_link') in pairs and pairs != self.fixed:
                return
            for transform in msg.transforms:
                self.transforms[transform.child_frame_id] = transform
            snapshot(self.static_tf, transforms=[message_to_ordereddict(t) for t in self.transforms.values()])

        self.subscriptions.append(self.node.create_subscription(String, '/robot_description', receive_description, receive_qos))
