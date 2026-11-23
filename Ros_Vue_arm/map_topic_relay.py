"""Expose compatible map inputs through the console's existing read-only bridge."""
import json
from pathlib import Path
import re

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from rosidl_runtime_py.utilities import get_message
from std_msgs.msg import String
from particle_cloud_relay import AmclParticleRelay
from model_snapshot_relay import ModelSnapshotRelay
import yaml


PREFIX = '/web/map_inputs'
TYPES = {
    'nav_msgs/msg/OccupancyGrid', 'nav_msgs/msg/Path', 'nav2_msgs/msg/ParticleCloud',
    'sensor_msgs/msg/LaserScan', 'tf2_msgs/msg/TFMessage',
    'sensor_msgs/msg/PointCloud2', 'geometry_msgs/msg/PoseStamped',
}


class MapTopicRelay(Node):
    def __init__(self):
        super().__init__('web_map_topic_relay')
        config = yaml.safe_load(Path(__file__).with_name('foxglove_bridge.params.yaml').read_text())
        self.direct = [re.compile(s) for s in config['/**']['ros__parameters']['topic_whitelist']]
        self.relays = {}
        self.sources = None
        self.catalogue = self.create_publisher(String, PREFIX + '/_sources',
            QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL))
        self.particles = AmclParticleRelay(self, PREFIX + '/particle_cloud')
        self.model_snapshot = ModelSnapshotRelay(self, PREFIX)
        self.create_timer(1.0, self.refresh)

    def refresh(self):
        self.model_snapshot.refresh()
        particle_sources = []
        wanted = {}
        sources_by_name = {}
        for name, types in self.get_topic_names_and_types():
            is_description = name.rsplit('/', 1)[-1] == 'robot_description' and types == ['std_msgs/msg/String']
            if (len(types) != 1 or (types[0] not in TYPES and not is_description) or
                    name.startswith(PREFIX + '/') or
                    any(part.startswith('_') for part in name.split('/'))):
                continue
            sources = self.get_publishers_info_by_topic(name)
            if not sources:
                continue
            sources_by_name[name] = types[0]
            if name == '/particle_cloud' and types[0] == 'nav2_msgs/msg/ParticleCloud':
                particle_sources = sources
                continue
            if any(rex.fullmatch(name) for rex in self.direct):
                continue
            latched = all(p.qos_profile.durability == DurabilityPolicy.TRANSIENT_LOCAL for p in sources)
            reliable = all(p.qos_profile.reliability == ReliabilityPolicy.RELIABLE for p in sources)
            wanted[name] = (types[0], latched, reliable)

        self.particles.sync(particle_sources)

        for name, (signature, pub, sub) in list(self.relays.items()):
            if wanted.get(name) != signature:
                if sub is not None:
                    self.destroy_subscription(sub)
                self.destroy_publisher(pub)
                del self.relays[name]

        for name, signature in wanted.items():
            msg_type, latched, reliable = signature
            durability = DurabilityPolicy.TRANSIENT_LOCAL if latched else DurabilityPolicy.VOLATILE
            if name not in self.relays:
                pub = self.create_publisher(get_message(msg_type), PREFIX + name,
                                            QoSProfile(depth=1, durability=durability))
                self.relays[name] = (signature, pub, None)
            _, pub, sub = self.relays[name]
            if pub.get_subscription_count():
                if sub is None:
                    reliability = ReliabilityPolicy.RELIABLE if reliable else ReliabilityPolicy.BEST_EFFORT
                    qos = QoSProfile(depth=1, durability=durability, reliability=reliability)
                    sub = self.create_subscription(pub.msg_type, name, pub.publish, qos, raw=True)
                    self.relays[name] = (signature, pub, sub)
            elif sub is not None:
                self.destroy_subscription(sub)
                self.relays[name] = (signature, pub, None)

        # Foxglove can keep advertising a channel while its own subscription exists.
        # Report actual publishers so clients can release that last subscription.
        if self.sources != sources_by_name:
            self.sources = sources_by_name
            self.catalogue.publish(String(data=json.dumps(sources_by_name)))


if __name__ == '__main__':
    rclpy.init()
    node = MapTopicRelay()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()
