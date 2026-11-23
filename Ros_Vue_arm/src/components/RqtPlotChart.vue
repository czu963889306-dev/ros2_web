<template>
  <canvas ref="surface" class="rqt-scope" role="img" aria-label="所选字段的实时曲线"></canvas>
</template>

<script setup>
import {onMounted,onBeforeUnmount,ref,watch} from 'vue'

const props=defineProps({
  rows:Array, colors:Array, span:Number, fps:Number, clock:Object,
  paused:Boolean, folded:Boolean
})
const emit=defineEmits(['rate'])
const surface=ref(null)
let context,observer,frame=0,deadline=0,meterStart=0,paintCount=0
let width=0,height=0,ratio=1,dirty=true,paths=[],low=0,high=1,base=0,cursor=0
const left=58,right=14,top=12,bottom=28
const innerWidth=()=>Math.max(1,width-left-right)
const innerHeight=()=>Math.max(1,height-top-bottom)
const y=value=>top+(high-value)/(high-low)*innerHeight()
const x=t=>left+innerWidth()*(1+(t-base)/props.span)

function firstAfter(row,time){
  let a=0,b=row.length
  while(a<b){
    const m=(a+b)>>>1
    if(row[m][0]<=time)a=m+1
    else b=m
  }
  return a
}

// Keep the first, last and extreme samples of each pixel column, in time order.
function trace(row,start){
  const path=new Path2D()
  let index=start
  while(index<row.length){
    const first=index, column=Math.floor(x(row[index][0]))
    let min=index,max=index
    for(index++;index<row.length&&Math.floor(x(row[index][0]))===column;index++){
      if(row[index][1]<row[min][1])min=index
      if(row[index][1]>row[max][1])max=index
    }
    const indices=[first,Math.min(min,max),Math.max(min,max),index-1]
    let previous=-1
    for(const i of indices){
      if(i===previous)continue
      const [t,value]=row[i]
      if(i===start)path.moveTo(x(t),y(value))
      else path.lineTo(x(t),y(value))
      previous=i
    }
  }
  return path
}

function rebuild(){
  base=props.clock.server
  let min=Infinity,max=-Infinity
  const starts=props.rows.map(row=>Math.max(0,firstAfter(row,base-props.span-0.2)-1))
  props.rows.forEach((row,i)=>{
    for(let j=starts[i];j<row.length;j++){
      min=Math.min(min,row[j][1]);max=Math.max(max,row[j][1])
    }
  })
  if(min===Infinity){low=0;high=1}
  else{
    const pad=min===max?Math.max(.01,Math.abs(min)*.05):(max-min)*.05
    low=min-pad;high=max+pad
  }
  paths=props.rows.map((row,i)=>trace(row,starts[i]))
  dirty=false
}

function grid(){
  const c=context, w=innerWidth(),h=innerHeight()
  c.font='12px ui-monospace, monospace'
  c.fillStyle='#40546a';c.strokeStyle='#dce4ed';c.lineWidth=1
  c.beginPath();c.textAlign='right'
  for(let i=0;i<=4;i++){
    const yy=top+h*i/4, value=high-(high-low)*i/4
    c.moveTo(left,yy);c.lineTo(width-right,yy)
    const label=Number(value.toPrecision(4)).toString()
    c.fillText(label,left-5,yy+4,left-7)
  }
  c.textAlign='center'
  for(let i=0;i<=5;i++){
    const xx=left+w*i/5
    c.moveTo(xx,top);c.lineTo(xx,height-bottom)
    c.fillText((i-5)*props.span/5+' s',xx,height-8)
  }
  c.stroke()
}

function draw(t){
  if(dirty)rebuild()
  // Allow a batch to arrive before its actual samples scroll into view.
  const anchor=props.clock
  if(!anchor.server)cursor=0
  else if(!props.paused||!cursor)cursor=Math.max(cursor,anchor.server+(t-anchor.local)/1000-0.12)
  const shift=(base-cursor)*innerWidth()/props.span
  const c=context
  c.setTransform(ratio,0,0,ratio,0,0)
  c.clearRect(0,0,width,height)
  grid()
  c.save()
  c.beginPath();c.rect(left,top,innerWidth(),innerHeight());c.clip()
  c.translate(shift,0)
  for(let i=0;i<paths.length;i++){
    const row=props.rows[i], end=firstAfter(row,cursor)-1
    if(end<0||row[end][0]<cursor-props.span)continue
    const [time,value]=row[end],xx=x(time),yy=y(value)
    c.strokeStyle=props.colors[i];c.fillStyle=props.colors[i];c.lineWidth=1.8
    c.save()
    c.beginPath();c.rect(left-shift,top,Math.max(0,xx-left+shift),innerHeight());c.clip()
    c.stroke(paths[i]);c.restore()
    c.beginPath();c.arc(xx,yy,2.6,0,Math.PI*2);c.fill()
  }
  c.restore()
}

function drawable(){
  return context&&!props.folded&&!document.hidden&&width>0&&height>0
}
function live(){return !props.paused&&props.clock.server>0&&props.rows.some(row=>row.length)}
function tick(t){
  frame=0
  if(!drawable())return
  if(!live()){draw(t);return}
  const interval=1000/props.fps
  if(!deadline)deadline=t
  if(t+0.8>=deadline){
    draw(t)
    deadline+=interval*(1+Math.floor(Math.max(0,t-deadline)/interval))
    if(!meterStart){meterStart=t;paintCount=0}
    else paintCount++
    if(t-meterStart>=1000){
      emit('rate',Math.round(paintCount*1000/(t-meterStart)))
      meterStart=t;paintCount=0
    }
  }
  frame=requestAnimationFrame(tick)
}
function schedule(){
  if(!frame&&drawable())frame=requestAnimationFrame(tick)
}
function resetLoop(){
  cancelAnimationFrame(frame);frame=0;deadline=0;meterStart=0;paintCount=0
  emit('rate',0);schedule()
}
function resize(){
  const el=surface.value
  width=el.clientWidth;height=el.clientHeight
  if(!width||!height){resetLoop();return}
  ratio=Math.min(2,window.devicePixelRatio||1)
  el.width=Math.round(width*ratio);el.height=Math.round(height*ratio)
  dirty=true;schedule()
}
watch(()=>[props.rows,props.span],()=>{dirty=true;schedule()})
watch(()=>[props.fps,props.paused,props.folded],resetLoop)
onMounted(()=>{
  context=surface.value.getContext('2d')
  observer=new ResizeObserver(resize);observer.observe(surface.value)
  document.addEventListener('visibilitychange',resetLoop)
  resize()
})
onBeforeUnmount(()=>{
  cancelAnimationFrame(frame);observer?.disconnect()
  document.removeEventListener('visibilitychange',resetLoop)
})
</script>
<style scoped>
.rqt-scope{display:block;box-sizing:border-box;width:100%;height:auto;aspect-ratio:2.8;min-height:165px;max-height:360px;background:#fbfcfe;border:1px solid #ccd8e5;border-radius:5px;margin:12px 0}
</style>