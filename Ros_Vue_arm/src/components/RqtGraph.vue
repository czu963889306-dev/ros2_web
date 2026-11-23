<template>
  <div class="rqt-row"><input v-model="filter" type="search" aria-label="筛选关系图" placeholder="按名称筛选" /><label v-if="!tf"><input v-model="hide" type="checkbox">隐藏系统话题</label><label v-if="!tf"><input v-model="nodesOnly" type="checkbox">仅节点</label>
    <label><input type="checkbox" v-model="auto">自动刷新</label><button @click="load" :disabled="busy">刷新</button></div>
  <div class="rqt-row"><button @click="fitWindow">适应窗口</button><button aria-label="缩小关系图" @click="zoomBy(1/1.35)">−</button><button aria-label="放大关系图" @click="zoomBy(1.35)">＋</button><button @click="zoomTo(1)">原始大小</button>
    <span class="rqt-muted">{{ tf?'坐标系':'图中节点和话题' }} {{ count }} <template v-if="!tf"> · 已发现 {{ nodeCount }} 个 ROS 节点</template></span></div>
  <p v-if="error" class="rqt-error" role="alert">{{ error }}</p>
  <div ref="viewport" class="rqt-graph-area" :class="{ fitted:fit }" title="滚轮缩放，放大后可拖动平移"
    @wheel="onWheel" @pointerdown="startPan" @pointermove="pan" @pointerup="drag=null" @pointercancel="drag=null">
    <div v-if="image" class="rqt-graph-sheet" :style="sheetStyle">
      <img ref="picture" :src="image" :alt="tf?'TF 坐标树':'ROS 节点及话题关系图'" draggable="false"
        :style="imageStyle" @load="measureImage">
    </div>
    <p v-else class="rqt-muted">{{ tf?'等待匹配的 TF 变换…':'等待匹配的节点或话题…' }}</p>
  </div>
  <div v-if="tf && filtered.length" class="rqt-scroll"><table><thead><tr><th>父坐标系 → 子坐标系</th><th>类型</th><th>平移 x, y, z（m）</th><th>四元数 x, y, z, w</th><th>距接收</th></tr></thead><tbody><tr v-for="edge in filtered" :key="edge.child"><td>{{ edge.parent }} → {{ edge.child }}</td><td>{{ edge.static?'静态':'动态' }}</td><td>{{ fmt(edge.xyz) }}</td><td>{{ fmt(edge.quat) }}</td><td>{{ edge.static?'—':(Math.max(0,now-edge.seen)).toFixed(1)+' s' }}</td></tr></tbody></table></div>
</template>
<script setup>
import {ref,computed,watch,nextTick,onMounted,onBeforeUnmount} from 'vue'
const props=defineProps({mode:String,call:Function})
const tf=props.mode==='tf_tree',filter=ref(''),hide=ref(true),nodesOnly=ref(false),auto=ref(true),error=ref(''),busy=ref(false)
const count=ref(0),nodeCount=ref(0),edges=ref([]),now=ref(0),image=ref(''),viewport=ref()
const picture=ref(),natural=ref({width:1,height:1}),fit=ref(true),zoom=ref(1)
const imageStyle=computed(()=>fit.value
  ? {width:'100%',height:'100%',objectFit:'contain'}
  : {width:natural.value.width*zoom.value+'px',height:natural.value.height*zoom.value+'px'})
// Leave a viewport of panning room on each side to keep the cursor's point
// anchored even when the whole image fits along one axis.
const sheetStyle=computed(()=>fit.value ? {} : {
  width:'calc(200% + '+imageStyle.value.width+')',
  height:'calc(200% + '+imageStyle.value.height+')'
})
const filtered=computed(()=>edges.value.filter(e=>(e.parent+' '+e.child).toLowerCase().includes(filter.value.trim().toLowerCase())).sort((a,b)=>a.child.localeCompare(b.child)))
const fmt=values=>values.map(v=>v.toFixed(3)).join(', ')
let alive=true,timer,key='',drag=null,version=0
function startPan(e){if(e.button!==0||fit.value)return;const el=viewport.value;drag={x:e.clientX,y:e.clientY,left:el.scrollLeft,top:el.scrollTop};el.setPointerCapture(e.pointerId)}
function pan(e){if(drag){viewport.value.scrollLeft=drag.left+drag.x-e.clientX;viewport.value.scrollTop=drag.top+drag.y-e.clientY}}
let zoomChange=0
function measureImage({target}){
  natural.value={width:target.naturalWidth,height:target.naturalHeight}
}
function fitWindow(){
  zoomChange++
  fit.value=true
  viewport.value?.scrollTo(0,0)
}
function imageBounds(){
  const img=picture.value
  if(!img?.complete || !img.naturalWidth || !img.naturalHeight)return null
  const rect=img.getBoundingClientRect()
  const scale=Math.min(rect.width/img.naturalWidth,rect.height/img.naturalHeight)
  if(!scale)return null
  return {
    scale,
    left:rect.left+(rect.width-img.naturalWidth*scale)/2,
    top:rect.top+(rect.height-img.naturalHeight*scale)/2
  }
}
async function zoomTo(target,anchor,before=imageBounds()){
  const el=viewport.value
  if(!el||!before)return
  const rect=el.getBoundingClientRect()
  const x=anchor?.clientX ?? rect.left+el.clientLeft+el.clientWidth/2
  const y=anchor?.clientY ?? rect.top+el.clientTop+el.clientHeight/2
  const u=(x-before.left)/before.scale,v=(y-before.top)/before.scale
  const fitScale=Math.min(el.clientWidth/picture.value.naturalWidth,el.clientHeight/picture.value.naturalHeight)
  const scale=Math.min(Math.max(5,fitScale*2),Math.max(Math.min(.04,fitScale/2),target))
  if(Math.abs(scale-before.scale)<1e-7)return
  const change=++zoomChange
  fit.value=false
  zoom.value=scale
  await nextTick()
  const after=imageBounds()
  if(change!==zoomChange||!after)return
  el.scrollLeft+=after.left+u*after.scale-x
  el.scrollTop+=after.top+v*after.scale-y
}
function zoomBy(factor,anchor){
  const before=imageBounds()
  if(before)zoomTo(before.scale*factor,anchor,before)
}
function onWheel(event){
  if(!event.deltaY||!picture.value?.naturalWidth)return
  event.preventDefault()
  event.stopPropagation()
  const unit=event.deltaMode===1 ? 16 : event.deltaMode===2 ? viewport.value.clientHeight : 1
  const pixels=Math.max(-240,Math.min(240,event.deltaY*unit))
  zoomBy(Math.exp(-pixels*0.002),event)
}
async function load(){
  clearTimeout(timer);if(!alive||busy.value)return
  const v=version;busy.value=true
  try{
    const d=await props.call(tf?'tf':'graph',{known:key,filter:filter.value,hide:hide.value,nodesOnly:nodesOnly.value})
    if(!alive||v!==version)return
    error.value='';key=d.key;count.value=d.count;nodeCount.value=d.nodeCount||0;edges.value=d.edges||[];now.value=d.now||0
    if(d.svg!==undefined){const old=image.value;image.value=d.svg?URL.createObjectURL(new Blob([d.svg],{type:'image/svg+xml'})):'';if(old)URL.revokeObjectURL(old)}
  }catch(ex){if(alive)error.value=ex.message}
  finally{busy.value=false;if(alive&&(auto.value||v!==version))timer=setTimeout(load,v!==version?50:2200)}
}
watch([filter,hide,nodesOnly],()=>{version++;clearTimeout(timer);timer=setTimeout(load,180)})
watch(auto,on=>{clearTimeout(timer);if(on)load()})
onMounted(load)
onBeforeUnmount(()=>{alive=false;clearTimeout(timer);if(image.value)URL.revokeObjectURL(image.value)})
</script>
<style scoped>
.rqt-graph-area{height:clamp(245px,45vh,480px);background:#fbfcfe;border:1px solid #ccd8e5;border-radius:5px;margin:10px 0;overflow:auto;overflow-anchor:none;touch-action:pan-x pan-y}
.rqt-graph-area.fitted{overflow:hidden}
.rqt-graph-sheet{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.rqt-graph-sheet img{display:block;flex:none;max-width:none;user-select:none}
.rqt-graph-area:not(.fitted) .rqt-graph-sheet{cursor:grab}
.rqt-graph-area:not(.fitted):active .rqt-graph-sheet{cursor:grabbing}
.rqt-graph-area p{padding:15px}
</style>