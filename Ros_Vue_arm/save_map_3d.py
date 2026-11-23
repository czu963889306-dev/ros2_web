"""Save the selected RTAB-Map run, including keyframes still held in memory."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
from contextlib import closing
import sqlite3
import subprocess
import sys
import tempfile
import uuid

ROOT = Path.home() / "maps_3d"
WORK = ROOT / "work"


def save_live(database):
    import rclpy
    from std_srvs.srv import Empty

    backup = Path(str(database) + ".back")
    before = backup.stat().st_ctime_ns if backup.exists() else None
    rclpy.init()
    node = rclpy.create_node("save_map_" + uuid.uuid4().hex[:12])
    try:
        client = node.create_client(Empty, "/mapping_3d/rtabmap/backup")
        if not client.wait_for_service(timeout_sec=8):
            raise RuntimeError("本轮建图的保存服务尚未就绪")
        future = client.call_async(Empty.Request())
        rclpy.spin_until_future_complete(node, future, timeout_sec=90)
        if not future.done() or future.result() is None or not backup.is_file() or backup.stat().st_ctime_ns == before:
            raise RuntimeError("建图节点没有完成本次快照，请稍后重试")
        return backup
    finally:
        node.destroy_node()
        rclpy.shutdown()


def save(session, running):
    if not re.fullmatch(r"[0-9]{13}-[0-9a-f]{12}", session):
        raise ValueError("无效的建图轮次")
    saved = ROOT / "saved"
    saved.mkdir(parents=True, exist_ok=True)
    key = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix=".saving-", dir=saved) as staging:
        tmp = Path(staging)
        with (WORK / ".rotation.lock").open("a") as rotation:
            fcntl.flock(rotation, fcntl.LOCK_SH)
            if os.readlink(WORK / "current") != session:
                raise ValueError("建图轮次已更换，请重新选择当前地图")
            db = WORK / session / "map.db"
            if not db.is_file():
                raise ValueError("当前地图还没有数据")
            source = save_live(db) if running else db
            with closing(sqlite3.connect(source.as_uri()+"?mode=ro", uri=True)) as src, closing(sqlite3.connect(tmp/"map.db")) as dst:
                src.backup(dst)
                if dst.execute("pragma quick_check").fetchone() != ("ok",):
                    raise RuntimeError("地图数据库校验未通过")
                if not dst.execute("select 1 from Node limit 1").fetchone():
                    raise ValueError("当前地图还没有关键帧")
        for mode in ("2", "3"):
            result = subprocess.run(["rtabmap-export", "--cloud", "--scan", "--voxel", "0.04",
                                     "--opt", mode, "--output", "map", "--output_dir", staging, str(tmp/"map.db")],
                                    cwd=staging, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            ply = tmp / "map_cloud.ply"
            if result.returncode == 0 and ply.is_file():
                with ply.open("rb") as fh:
                    if re.search(rb"element vertex [1-9][0-9]*[\r\n]", fh.read(1024)):
                        ply.rename(tmp/"map.ply")
                        break
        has_cloud = (tmp/"map.ply").is_file()
        # Publish the two downloads together, after all checks.
        (tmp/"map_cloud.ply").unlink(missing_ok=True)
        tmp.rename(saved / key)
    print(json.dumps(dict(id=key, ply=has_cloud)))


if __name__ == "__main__":
    try:
        save(sys.argv[1], sys.argv[2] == "running")
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
