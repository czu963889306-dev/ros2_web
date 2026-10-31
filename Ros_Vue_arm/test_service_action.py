import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import service_action

class ActionTests(unittest.TestCase):
 def execute(self, unit='voice-assistant.service', fail=False):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=Path(tmp.name);jobid='11111111-1111-1111-1111-111111111111';file=root/(jobid+'.json');file.write_text(json.dumps(dict(id=jobid,unit=unit,action='restart',state='running')))
  calls=[]
  def run(args,**kwargs):
   calls.append(args)
   if args[-1]=='services':return subprocess.CompletedProcess(args,0,stdout='voice-assistant.service\nros2-web.service\n')
   if args[0]=='/bin/bash':
    if fail:raise subprocess.TimeoutExpired(args,90)
    return subprocess.CompletedProcess(args,0)
   return subprocess.CompletedProcess(args,0,stdout='active\n')
  with patch.object(service_action,'ROOT',root),patch('sys.argv',['service_action.py',jobid]),patch('service_action.subprocess.run',side_effect=run),patch('service_action.time.sleep'):
   service_action.main()
  return json.loads(file.read_text()),calls
 def test_success(self):
  job,calls=self.execute();self.assertEqual(job['state'],'succeeded');self.assertIn(['/bin/bash','/root/ros_service_ctl.sh','restart','voice-assistant.service'],calls)
 def test_invalid_target_never_operated(self):
  job,calls=self.execute('qwen.service');self.assertEqual(job['state'],'failed');self.assertEqual(len(calls),1)
 def test_timeout_finishes_job(self):
  job,calls=self.execute(fail=True);self.assertEqual(job['state'],'failed');self.assertIn('超时',job['message'])
if __name__=='__main__':unittest.main()
