"""Apply one robot-wide ROS domain change outside the console service."""
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.request import urlopen
from pathlib import Path

CONFIG = Path('/etc/default/chuyun-ros-domain')
RUNTIME = Path('/run/chuyun-ros-domain')
JOB = RUNTIME / 'job.json'
MICRO_ROS_AGENT = 'micro-ros-agent.service'
MICRO_ROS_SERIAL = Path('/dev/ttyUSB0')
UNITS = (
    MICRO_ROS_AGENT, 'leap_ros_bringup.service', 'chuyun-arm-bridge.service',
    'chuyun_wifi_config.service', 'astra-pro-depth.service', 'chuyun-mapping-3d.service',
    'ros2-web-topic-throttle.service', 'ros2-web.service',
)


def domain(value):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]{0,2}', value) or int(value) > 232:
        raise ValueError('ROS_DOMAIN_ID 须为 0 到 232 的整数')
    return int(value)


def atomic_write(path, text, mode):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as out:
        temp = Path(out.name)
        try:
            out.write(text)
            out.flush()
            os.fchmod(out.fileno(), mode)
            os.fsync(out.fileno())
            os.replace(temp, path)
            fd = os.open(path.parent, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            temp.unlink(missing_ok=True)


def configured():
    match = re.fullmatch(r'ROS_DOMAIN_ID=([0-9]+)\n?', CONFIG.read_text())
    if not match:
        raise RuntimeError('域号配置文件格式异常')
    return domain(match[1])


def job_state(job, state, message):
    job.update(state=state, message=message, updated_at=int(time.time() * 1000))
    atomic_write(JOB, json.dumps(job, ensure_ascii=False), 0o600)


def run(*args, timeout=15):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout).stdout.strip()


def active_units():
    output = run('systemctl', 'show', '-p', 'Id,ActiveState', *UNITS)
    active = []
    for block in output.split('\n\n'):
        item = dict(line.split('=', 1) for line in block.splitlines())
        if item['ActiveState'] in ('active', 'activating', 'reloading'):
            active.append(item['Id'])
    return active


def verify(units, target):
    pids = []
    for name in units:
        pid = int(run('systemctl', 'show', '-p', 'MainPID', '--value', name))
        if not pid:
            raise RuntimeError(name + ' 尚未启动')
        env = (Path('/proc') / str(pid) / 'environ').read_bytes().split(b'\0')
        if f'ROS_DOMAIN_ID={target}'.encode() not in env:
            raise RuntimeError(name + ' 的生效域号不一致')
        pids.append(pid)
    if 'ros2-web.service' in units:
        with urlopen('http://127.0.0.1:3000/api/system-status', timeout=2) as reply:
            if json.load(reply).get('ros_domain_id') != target:
                raise RuntimeError('等待中控台进入新域')
    return pids


def restart(units, target):
    atomic_write(CONFIG, f'ROS_DOMAIN_ID={target}\n', 0o644)
    if not units:
        return
    required = [name for name in units if name != MICRO_ROS_AGENT]
    agent_enabled = MICRO_ROS_AGENT in units
    if agent_enabled:
        # ExecStartPre waits for the serial port. Its next ExecStart reads CONFIG.
        # Restart a live agent even if the port was unplugged just before switching.
        if MICRO_ROS_SERIAL.exists() or int(run('systemctl', 'show', '-p', 'MainPID', '--value', MICRO_ROS_AGENT)):
            run('systemctl', '--no-block', 'restart', MICRO_ROS_AGENT)
    if required:
        run('systemctl', 'restart', *required, timeout=170)

    deadline = time.monotonic() + 35
    previous_pids = None
    while True:
        try:
            monitored = required
            if agent_enabled and MICRO_ROS_SERIAL.exists():
                monitored = [*required, MICRO_ROS_AGENT]
            pids = verify(monitored, target)
            if pids == previous_pids:
                return
            previous_pids = pids
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            previous_pids = None
        if time.monotonic() >= deadline:
            raise RuntimeError('ROS 服务未在目标域就绪')
        time.sleep(1.25)


def request(target, expected):
    prior = json.loads(JOB.read_text()) if JOB.exists() else {}
    if prior.get('state') in ('queued', 'running'):
        unit = 'chuyun-ros-domain-' + prior['id'] + '.service'
        state = subprocess.run(['systemctl', 'show', '-p', 'ActiveState', '--value', unit],
                               capture_output=True, text=True, timeout=10).stdout.strip()
        if state in ('active', 'activating', 'deactivating'):
            return {'code': 409, 'error': '正在切换 ROS 域号'}
        job_state(prior, 'failed', '上次切换已中断，请重新应用')
    old = configured()
    if expected != old:
        return {'code': 409, 'error': '域号配置已改变，请刷新后重试'}
    if target == old and prior.get('state') != 'failed':
        return {'code': 200, 'changed': False, 'domain': old}
    job = {'id': uuid.uuid4().hex, 'previous': old, 'target': target}
    job_state(job, 'queued', '正在准备切换 ROS 域号')
    try:
        run('systemd-run', '--quiet', '--collect', '--property=Type=exec',
            '--unit=chuyun-ros-domain-' + job['id'],
            '/usr/bin/python3', str(Path(__file__).resolve()), 'apply', job['id'])
    except Exception:
        job_state(job, 'failed', '未能启动域号切换任务')
        raise
    return {'code': 202, 'changed': True, 'job': job}


def apply(job_id):
    job = json.loads(JOB.read_text())
    if job['id'] != job_id or job['state'] != 'queued':
        raise RuntimeError('域号请求已失效')
    job_state(job, 'running', '正在重启 ROS 服务')
    units = []
    try:
        # Allow the accepted response to reach the browser before restarting ros2-web.
        time.sleep(1)
        units = active_units()
        restart(units, job['target'])
        job_state(job, 'succeeded', 'ROS 域号已生效')
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        try:
            if configured() != job['previous'] or units:
                restart(units, job['previous'])
            message = '切换失败，已恢复原域号'
        except Exception as rollback:
            print(str(rollback), file=sys.stderr, flush=True)
            message = '切换失败，部分 ROS 服务需要检查'
        job_state(job, 'failed', message)
        raise


def main(args):
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    with (RUNTIME / 'lock').open('a') as lock:
        if len(args) == 3 and args[0] == 'request':
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {'code': 409, 'error': '正在切换 ROS 域号'}
            return request(domain(args[1]), domain(args[2]))
        if len(args) == 2 and args[0] == 'apply' and re.fullmatch('[a-f0-9]{32}', args[1]):
            fcntl.flock(lock, fcntl.LOCK_EX)
            apply(args[1])
            return {'code': 200}
    raise ValueError('无效的域号操作')


if __name__ == '__main__':
    print(json.dumps(main(sys.argv[1:]), ensure_ascii=False))
