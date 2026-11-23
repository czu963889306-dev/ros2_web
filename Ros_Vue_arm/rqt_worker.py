"""One on-demand ROS session for the web toolbox. JSON lines are exchanged with server.js."""
import array
import json
import math
import os
import queue
import re
import sys
import threading
import time
from collections import deque

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from rclpy.serialization import deserialize_message
from rclpy.validate_full_topic_name import validate_full_topic_name
from rosidl_runtime_py import get_message_interfaces
from rosidl_runtime_py.set_message import set_message_fields
from rosidl_runtime_py.utilities import get_message, get_service
from tf2_msgs.msg import TFMessage


def reply(seq, data=None, error=None):
    print(json.dumps({'id': seq, 'data': data, 'error': error}, ensure_ascii=False, allow_nan=False), flush=True)


def name(value):
    if not isinstance(value, str) or len(value) > 255:
        raise ValueError('ROS 名称无效')
    validate_full_topic_name(value)
    return value


def interface(value, kind):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_]*/' + kind + r'/[A-Z][A-Za-z0-9_]*', value):
        raise ValueError('接口类型无效')
    return (get_message if kind == 'msg' else get_service)(value)


def plain(value, budget=None):
    if budget is not None:
        budget[0] -= 1
        if budget[0] < 0:
            return '…'
    if hasattr(value, 'get_fields_and_field_types'):
        return {k: plain(getattr(value,k), budget) for k in value.get_fields_and_field_types()}
    if isinstance(value, (tuple,list,array.array,np.ndarray,bytes,bytearray,memoryview)):
        limit = len(value) if budget is None else min(len(value), 64, max(0,budget[0]))
        out = [plain(v,budget) for v in value[:limit]]
        if limit < len(value): out.append('… 共 %d 项' % len(value))
        return out
    if isinstance(value,np.generic): value=value.item()
    if isinstance(value,float) and not math.isfinite(value): return str(value)
    if isinstance(value,str) and budget is not None and len(value)>2048: return value[:2048]+'…'
    return value


def validate_fields(message, values):
    if not isinstance(values,dict):
        raise ValueError('消息必须是 JSON 对象')
    fields=message.get_fields_and_field_types()
    for key,value in values.items():
        if key not in fields: raise ValueError('未知字段 '+key)
        current=getattr(message,key)
        if hasattr(current,'get_fields_and_field_types') and isinstance(value,dict):
            validate_fields(current,value)
        if isinstance(value,list):
            match=re.search(r'([a-z][a-z0-9_]*)/(?:msg/)?([A-Z]\w*)',fields[key])
            if match:
                element=interface(match[1]+'/msg/'+match[2],'msg')()
                for item in value: validate_fields(element,item)


def body(message,text):
    if not isinstance(text,str) or len(text)>65000: raise ValueError('消息内容过长或无效')
    data=json.loads(text)
    validate_fields(message,data)
    stamps=set_message_fields(message,data,expand_header_auto=True,expand_time_now=True)
    return stamps


PLOT_HZ = 60
PLOT_HISTORY = 60

def recent_points(samples, since, now):
    cutoff = max(since, now - PLOT_HISTORY)
    tail = []
    for point in reversed(samples):
        if point[0] <= cutoff:
            break
        tail.append(point)
    tail.reverse()
    return tail


def fields_path(s):
    if not isinstance(s,str) or len(s)>256 or not re.fullmatch(r'[a-zA-Z]\w*(?:(?:[./][a-zA-Z]\w*)|(?:\[\d{1,6}\]))*',s):
        raise ValueError('字段示例：pose.pose.position.x 或 ranges[0]')
    return [int(i) if i else k for k,i in re.findall(r'([a-zA-Z]\w*)|\[(\d+)\]',s)]


def numeric(msg,parts):
    for key in parts:
        if isinstance(key,int): msg=msg[key]
        else:
            if key not in msg.get_fields_and_field_types(): raise ValueError()
            msg=getattr(msg,key)
    if not isinstance(msg,(int,float,np.number)) or not math.isfinite(msg): raise ValueError()
    return float(msg)


class Toolbox(Node):
    def __init__(self):
        super().__init__('web_rqt_'+str(os.getpid()),start_parameter_services=False,enable_rosout=False)
        self.mode=''; self.epoch=0
        self.subs=[]; self.publisher=None; self.pub_timer=None
        self.once=None; self.service=None
        self.curves=[]; self.tf={}; self.watch=None; self.sent=0
        self.inbox=queue.SimpleQueue()
        self.guard=self.create_guard_condition(self.read_requests)
        self.create_timer(.1,self.tick)

    def reset(self):
        if self.once:
            reply(self.once['id'],error='已取消发布')
            self.once=None
        self.stop_publisher()
        if self.service: self.end_service('请求窗口已关闭')
        for sub in self.subs: self.destroy_subscription(sub)
        self.subs.clear(); self.curves=[]; self.watch=None; self.tf={}; self.sent=0

    def stop_publisher(self):
        if self.pub_timer:
            self.destroy_timer(self.pub_timer); self.pub_timer=None
        if self.publisher:
            self.destroy_publisher(self.publisher); self.publisher=None

    def end_service(self,error=None):
        item=self.service
        self.service=None
        try:
            if error: reply(item['id'],error=error)
            else:
                result=item['future'].result()
                reply(item['id'],{'response':json.dumps(plain(result,[2400]),ensure_ascii=False,indent=2)})
        except Exception as exc: reply(item['id'],error=str(exc))
        finally:
            if not item['future'].done():item['future'].cancel()
            self.destroy_client(item['client'])

    def tick(self):
        if self.once and (self.publisher.get_subscription_count() or time.monotonic()>=self.once['at']):
            once=self.once; self.once=None
            try:
                once['send']()
                reply(once['id'],{'sent':self.sent,'matched':self.publisher.get_subscription_count()})
            except Exception as exc:reply(once['id'],error=str(exc))
        if self.service:
            if self.service['future'].done(): self.end_service()
            elif time.monotonic()>self.service['until']: self.end_service('服务响应超时，请先核实执行结果')

    def qos(self,topic):
        pubs=self.get_publishers_info_by_topic(topic)
        latched=bool(pubs) and all(x.qos_profile.durability==DurabilityPolicy.TRANSIENT_LOCAL for x in pubs)
        return QoSProfile(depth=5,reliability=ReliabilityPolicy.BEST_EFFORT,
                          durability=DurabilityPolicy.TRANSIENT_LOCAL if latched else DurabilityPolicy.VOLATILE)

    def catalog(self):
        return {'topics':sorted(self.get_topic_names_and_types()),'services':sorted(self.get_service_names_and_types()),
                'domain':self.context.get_domain_id()}

    def graph(self):
        nodes=[]
        for short,ns in sorted(set(self.get_node_names_and_namespaces())):
            try:
                pub=[x[0] for x in self.get_publisher_names_and_types_by_node(short,ns)]
                sub=[x[0] for x in self.get_subscriber_names_and_types_by_node(short,ns)]
            except RuntimeError: continue
            nodes.append({'name':ns.rstrip('/')+'/'+short,'pub':pub,'sub':sub})
        return nodes

    def tf_writers(self):
        return tuple(tuple(sorted(bytes(p.endpoint_gid) for p in self.get_publishers_info_by_topic(topic)))
                     for topic in ('/tf_static', '/tf'))

    def start_tf(self):
        self.tf_sources = self.tf_writers()
        def update(msg,static):
            for t in msg.transforms:
                p=t.transform.translation; q=t.transform.rotation
                self.tf[t.child_frame_id]={'parent':t.header.frame_id,'child':t.child_frame_id,'static':static,
                    'xyz':[p.x,p.y,p.z],'quat':[q.x,q.y,q.z,q.w],
                    'stamp':t.header.stamp.sec+t.header.stamp.nanosec/1e9,'seen':time.monotonic()}
        for topic,static in [('/tf',False),('/tf_static',True)]:
            qos=QoSProfile(depth=50,reliability=ReliabilityPolicy.RELIABLE if static else ReliabilityPolicy.BEST_EFFORT,
                durability=DurabilityPolicy.TRANSIENT_LOCAL if static else DurabilityPolicy.VOLATILE)
            self.subs.append(self.create_subscription(TFMessage,topic,lambda m,s=static:update(m,s),qos))

    def set_watch(self,a):
        topic=name(a['topic']); typ=interface(a['type'],'msg')
        for sub in self.subs:self.destroy_subscription(sub)
        self.subs=[]
        w={'topic':topic,'type':typ,'last':None,'samples':deque(maxlen=512),'count':0}
        def update(raw):
            w['last']=raw;w['count']+=1;w['samples'].append((time.monotonic(),len(raw)))
        self.watch=w
        self.subs.append(self.create_subscription(typ,topic,update,self.qos(topic),raw=True))

    def inspect(self):
        if not self.watch:return {}
        w=self.watch; now=time.monotonic();samples=[s for s in w['samples'] if now-s[0]<5]
        span=samples[-1][0]-samples[0][0] if len(samples)>1 else 0
        data=None if w['last'] is None else json.dumps(plain(deserialize_message(w['last'],w['type']),[1200]),ensure_ascii=False,indent=2)
        return {'message':data,'count':w['count'],'hz':(len(samples)-1)/span if span else 0,
                'bytes':len(w['last']) if w['last'] else 0,'bps':sum(x[1] for x in samples[1:])/span if span else 0,
                'publishers':self.count_publishers(w['topic']),'subscribers':self.count_subscribers(w['topic'])}

    def set_curves(self,items):
        if not isinstance(items,list) or len(items)>8: raise ValueError('最多同时绘制 8 条曲线')
        curves=[];groups={}
        for item in items:
            topic=name(item['topic']);typ=interface(item['type'],'msg')
            c={'path':fields_path(item['field']),'samples':deque(maxlen=PLOT_HZ * PLOT_HISTORY + 2),'error':''}
            groups.setdefault((topic,typ),[]).append(c);curves.append(c)
        for sub in self.subs:self.destroy_subscription(sub)
        self.subs=[];self.curves=curves
        def callback(group,typ):
            # DDS may deliver several samples together. Preserve bursts within
            # the subscription's queue depth while bounding the average rate.
            capacity=5
            tokens=float(capacity)
            previous=time.monotonic()
            def update(raw):
                nonlocal tokens,previous
                now=time.monotonic()
                tokens=min(capacity, tokens + (now - previous) * PLOT_HZ)
                previous=now
                if tokens < 1:
                    return
                tokens-=1
                msg=deserialize_message(raw,typ)
                for c in group:
                    try:c['samples'].append((now,numeric(msg,c['path'])));c['error']=''
                    except (AttributeError,ValueError,IndexError,TypeError): c['error']='字段不存在或不是有限数值'
            return update
        for (topic,typ),group in groups.items():
            self.subs.append(self.create_subscription(typ,topic,callback(group,typ),self.qos(topic),raw=True))

    def publish_request(self,a,seq):
        topic=name(a['topic']);typ=interface(a['type'],'msg')
        if self.once or self.pub_timer:raise ValueError('请先停止当前发布')
        msg=typ(); stamps=body(msg,a['text'])
        rate=a.get('hz',0)
        if type(rate) not in (int,float) or not math.isfinite(rate) or not (rate==0 or .1<=rate<=50):raise ValueError('频率范围为 0.1–50 Hz')
        self.stop_publisher();self.sent=0
        qos=QoSProfile(depth=5,reliability=ReliabilityPolicy.BEST_EFFORT if a.get('bestEffort') else ReliabilityPolicy.RELIABLE,
                       durability=DurabilityPolicy.TRANSIENT_LOCAL if a.get('latched') else DurabilityPolicy.VOLATILE)
        self.publisher=self.create_publisher(typ,topic,qos)
        def send():
            for set_stamp in stamps:set_stamp(self.get_clock().now().to_msg())
            self.publisher.publish(msg);self.sent+=1
        if rate:
            self.pub_timer=self.create_timer(1/rate,send)
            return {'running':True}
        self.once={'id':seq,'send':send,'at':time.monotonic()+.9}

    def dispatch(self,seq,a):
        op=a['op'];epoch=a.get('epoch',0)
        if op=='mode':
            if not isinstance(epoch,int) or epoch<=self.epoch:raise ValueError('窗口已切换')
            mode=a['tool']
            if mode not in ('graph','topic','publisher','service_caller','plot','tf_tree'):raise ValueError('未知工具')
            self.reset();self.epoch=epoch;self.mode=mode
            if mode=='tf_tree':self.start_tf()
            result=self.catalog()
            if mode=='publisher':
                result['types']=sorted(pkg+'/'+t for pkg,ts in get_message_interfaces().items() for t in ts)
            return result
        if epoch!=self.epoch:raise ValueError('窗口已切换')
        if op=='catalog':return self.catalog()
        if op=='schema' and self.mode in ('publisher','service_caller','plot','topic'):
            is_srv=self.mode=='service_caller';typ=interface(a['type'],'srv' if is_srv else 'msg')
            obj=typ.Request() if is_srv else typ()
            return {'template':json.dumps(plain(obj),ensure_ascii=False,indent=2),'fields':obj.get_fields_and_field_types()}
        if op=='graph' and self.mode=='graph': return {'nodes':self.graph()}
        if op=='tf' and self.mode=='tf_tree':
            if self.tf_sources != self.tf_writers():
                for sub in self.subs:self.destroy_subscription(sub)
                self.subs.clear()
                self.tf.clear()
                self.start_tf()
            return {'edges':list(self.tf.values()),'now':time.monotonic()}
        if op=='unwatch' and self.mode=='topic':
            for sub in self.subs:self.destroy_subscription(sub)
            self.subs.clear();self.watch=None
            return {}
        if op=='watch' and self.mode=='topic': self.set_watch(a);return {}
        if op=='sample' and self.mode=='topic':return self.inspect()
        if op=='curves' and self.mode=='plot':self.set_curves(a['items']);return {}
        if op=='points' and self.mode=='plot':
            now=time.monotonic();since=float(a.get('since',0))
            return {'now':now,'series':[{'points':recent_points(c['samples'],since,now),
                                         'error':c['error']} for c in self.curves]}
        if op=='publish' and self.mode=='publisher':return self.publish_request(a,seq)
        if op=='stop' and self.mode=='publisher':
            if self.once:reply(self.once['id'],error='发布已取消');self.once=None
            self.stop_publisher();return {}
        if op=='publisher_status' and self.mode=='publisher':
            return {'running':bool(self.pub_timer),'sent':self.sent,'matched':self.publisher.get_subscription_count() if self.publisher else 0}
        if op=='call' and self.mode=='service_caller':
            if self.service:raise ValueError('等待上一次服务调用完成')
            srv=name(a['service']);typ=interface(a['type'],'srv')
            if a['type'] not in dict(self.get_service_names_and_types()).get(srv,[]):raise ValueError('服务未发现或类型已更改')
            req=typ.Request();stamps=body(req,a['text'])
            for set_stamp in stamps:set_stamp(self.get_clock().now().to_msg())
            client=self.create_client(typ,srv)
            try:future=client.call_async(req)
            except Exception:self.destroy_client(client);raise
            self.service={'client':client,'id':seq,'future':future,'until':time.monotonic()+12};return None
        raise ValueError('当前工具不支持此操作')

    def read_requests(self):
        while not self.inbox.empty():
            line=self.inbox.get()
            if line is None:rclpy.shutdown();return
            seq=None
            try:
                req=json.loads(line);seq=req['id']
                result=self.dispatch(seq,req['args'])
                if result is not None:reply(seq,result)
            except Exception as exc:reply(seq,error=str(exc)[:500] or '字段或请求无效')


def main():
    rclpy.init();node=Toolbox()
    def reader():
        for line in sys.stdin:
            node.inbox.put(line);node.guard.trigger()
        node.inbox.put(None)
        try:node.guard.trigger()
        except Exception:pass
    threading.Thread(target=reader,daemon=True).start()
    try:rclpy.spin(node)
    finally:
        node.destroy_node()
        if rclpy.ok():rclpy.shutdown()

if __name__=='__main__':main()
