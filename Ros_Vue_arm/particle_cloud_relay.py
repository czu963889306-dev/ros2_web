"""Keep the last genuine AMCL cloud available to late-joining map displays."""
from time import monotonic

from geometry_msgs.msg import PoseWithCovarianceStamped
from nav2_msgs.msg import ParticleCloud
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_srvs.srv import Empty


class AmclParticleRelay:
    def __init__(self, node, output_topic):
        self.node = node
        self.output_topic = output_topic
        self.retained = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.writers = ()
        self.output = self.input = self.pose_sub = self.refresh_client = None
        self.refresh_call = None
        self.have_cloud = self.have_pose = self.requested = False

    def release_bootstrap(self):
        if self.pose_sub is not None:
            self.node.destroy_subscription(self.pose_sub)
            self.pose_sub = None
        if self.refresh_client is not None:
            self.node.destroy_client(self.refresh_client)
            self.refresh_client = self.refresh_call = None

    def reset(self):
        self.release_bootstrap()
        if self.input is not None:
            self.node.destroy_subscription(self.input)
            self.node.destroy_publisher(self.output)
            self.input = self.output = None
        self.have_cloud = self.have_pose = self.requested = False

    def receive(self, cloud):
        self.output.publish(cloud)
        self.have_cloud = True

    def pose_received(self, pose):
        self.have_pose = bool(pose.header.frame_id)

    def sync(self, sources):
        # A new DDS writer means a new localization session, even on the same map.
        writers = tuple(sorted(bytes(p.endpoint_gid) for p in sources))
        if writers != self.writers:
            self.reset()
            self.writers = writers
            if sources:
                self.output = self.node.create_publisher(ParticleCloud, self.output_topic, self.retained)
                qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT)
                self.input = self.node.create_subscription(ParticleCloud, '/particle_cloud',
                                                           self.receive, qos, raw=True)
                self.started = monotonic()

        if self.output is None:
            return
        if self.have_cloud or not self.output.get_subscription_count():
            if self.refresh_call is None or self.refresh_call.done():
                self.release_bootstrap()
            return
        # The relay may have joined after localization while the robot is stationary.
        # Request at most one normal sensor update per writer, and only after AMCL
        # has published an initial pose and a display is actually waiting.
        if self.requested or monotonic() - self.started < 3:
            return
        if not any(p.node_name == 'amcl' and p.node_namespace == '/' for p in sources):
            return
        if self.pose_sub is None:
            self.pose_sub = self.node.create_subscription(PoseWithCovarianceStamped, '/amcl_pose',
                                                          self.pose_received, self.retained)
        if self.have_pose:
            if self.refresh_client is None:
                self.refresh_client = self.node.create_client(Empty, '/request_nomotion_update')
            if self.refresh_client.service_is_ready():
                self.refresh_call = self.refresh_client.call_async(Empty.Request())
                self.requested = True
                self.node.get_logger().info('Requested one stationary AMCL update for an empty particle display cache')
