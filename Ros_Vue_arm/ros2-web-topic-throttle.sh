#!/usr/bin/env bash
set -eo pipefail

source /opt/ros/humble/setup.bash
if [[ -f /root/chuyun_ws/install/setup.bash ]]; then
  source /root/chuyun_ws/install/setup.bash
fi

pids=()

stop_children() {
  if ((${#pids[@]})); then
    for pid in "${pids[@]}"; do
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    done
    wait "${pids[@]}" 2>/dev/null || true
    pids=()
  fi
}

start_children() {
  # Use normal DDS discovery for local and LAN ROS 2 communication.
  export ROS_LOCALHOST_ONLY=0
  unset FASTRTPS_DEFAULT_PROFILES_FILE
  unset FASTDDS_DEFAULT_PROFILES_FILE
  echo "[ros2-web-topic-throttle] fixed multi-machine communication ROS_LOCALHOST_ONLY=$ROS_LOCALHOST_ONLY"

  # /tf is multiplexed: map->odom and odom->base_footprint arrive in separate
  # messages. Publish a 12 Hz snapshot containing the newest value of every edge.
  setsid ros2 run chuyun_bringup web_tf_aggregator \
    --ros-args -p publish_rate:=12.0 -p max_transform_age:=2.0 &
  pids+=("$!")

  # Keep the TF aggregator alive even on systems where topic_tools is not installed.
  # The odometry throttle is optional; TF is required by the web console.
  if ros2 pkg prefix topic_tools >/dev/null 2>&1; then
    setsid ros2 run topic_tools throttle messages /odometry/filtered 10.0 /web/odometry/filtered \
      --ros-args -r __node:=web_odom_throttle -p lazy:=true &
    pids+=("$!")
  else
    echo "[ros2-web-topic-throttle] topic_tools is not installed; skipping odometry throttle" >&2
  fi
}

children_alive() {
  local pid
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
  done
  ((${#pids[@]} > 0))
}

trap stop_children EXIT INT TERM

start_children
while true; do
  if ! children_alive; then
    stop_children
    start_children
  fi
  sleep 1
done
