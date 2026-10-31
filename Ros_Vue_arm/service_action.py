"""Run a whitelisted service operation outside ros2-web's systemd control group."""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/run/ros2-web-service-actions')
SCRIPT = '/root/ros_service_ctl.sh'

def write(path, job):
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(job, stream, ensure_ascii=False)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temp, path)

def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f-]{36}', sys.argv[1]):
        raise SystemExit(2)
    path = ROOT / (sys.argv[1] + '.json')
    job = json.loads(path.read_text())
    try:
        allowed = subprocess.run(['/bin/bash', SCRIPT, 'services'], capture_output=True, text=True, timeout=8, check=True).stdout.splitlines()
        if job['unit'] not in allowed or job['action'] not in ('start','stop','restart'):
            raise ValueError('Unmanaged operation')
        # Let HTTP 202 reach the browser before a web service stop/restart.
        time.sleep(1)
        result = subprocess.run(['/bin/bash', SCRIPT, job['action'], job['unit']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
        state = subprocess.run(['/usr/bin/systemctl', 'show', '--value', '-p', 'ActiveState', job['unit']], capture_output=True, text=True, timeout=8).stdout.strip()
        success = result.returncode == 0 and (state == 'inactive' if job['action'] == 'stop' else state == 'active')
        job.update(state='succeeded' if success else 'failed', message='服务操作已完成' if success else '服务操作未成功，请查看该服务日志', active_state=state)
    except Exception:
        job.update(state='failed', message='服务操作失败或超时，请检查该服务状态与日志')
    job['finished_at'] = int(time.time() * 1000)
    write(path, job)

if __name__ == '__main__': main()
