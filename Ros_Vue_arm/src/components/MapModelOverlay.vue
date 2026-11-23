<template>
  <div class="model-overlay" ref="host" :aria-label="model ? '机器人模型 ' + model.name : undefined">
    <span v-if="error" role="status">{{ error }}</span>
  </div>
</template>
<script setup>
import { onMounted,onUnmounted,ref,watch } from 'vue'
import * as THREE from 'three'
import { addModelLights } from '../composables/robotModel.js'
const props=defineProps({model:Object, frames:Object, frameRevision:Number, armPositions:Object})
const emit=defineEmits(['ready'])
const host=ref(null),error=ref('')
const scene=new THREE.Scene(), camera=new THREE.OrthographicCamera()
let renderer, instance, lastView
function sync() {
  if (instance) {
    scene.remove(instance)
    instance=null
    renderer.renderLists.dispose()
  }
  if (!props.model) {
    renderer?.clear()
    return
  }
  if (!renderer && !createRenderer()) return
  instance=props.model.root.clone(true)
  scene.add(instance)
  props.frames.applyJoints(instance,props.armPositions)
  if (lastView) renderView(lastView)
}
watch(()=>props.frameRevision, () => {
  if (instance) props.frames.applyJoints(instance,props.armPositions)
})
watch(()=>props.model,sync)
watch(()=>props.armPositions, () => {
  if (!instance) return
  props.frames.applyJoints(instance,props.armPositions)
  if (lastView) renderView(lastView)
})
function renderView(view) {
  lastView=view
  if (!renderer || !instance) return
  const {width,height,metres,heading,tilt,center,frame}=view
  const matrix=props.frames.lookup(frame,props.model.frame)
  instance.visible=!!matrix
  if (matrix) matrix.decompose(instance.position,instance.quaternion,instance.scale)
  if (renderer.domElement.width!==width || renderer.domElement.height!==height) renderer.setSize(width,height,false)
  const c=Math.cos(heading), s=Math.sin(heading), p=Math.sin(tilt), h=Math.cos(tilt)
  const distance=Math.max(width*metres,height*metres,props.model.size,1)*3
  camera.left=-width*metres/2; camera.right=-camera.left
  camera.top=height*metres/2; camera.bottom=-camera.top
  camera.near=.001; camera.far=distance*3
  camera.up.set(-s*h,c*h,p)
  camera.position.set(center.x+s*p*distance,center.y-c*p*distance,h*distance)
  camera.lookAt(center.x,center.y,0)
  camera.updateProjectionMatrix()
  renderer.render(scene,camera)
}
function createRenderer(){
  try { renderer=new THREE.WebGLRenderer({alpha:true,antialias:true}) }
  catch { error.value='机器人模型需要 WebGL'; return false }
  renderer.setClearColor(0,0)
  host.value.prepend(renderer.domElement)
  addModelLights(scene)
  emit('ready')
  return true
}
onMounted(sync)
onUnmounted(()=>{
  if(instance)scene.remove(instance)
  instance=null
  renderer?.dispose()
  renderer?.forceContextLoss()
})
defineExpose({renderView})
</script>
<style scoped>
.model-overlay { position:absolute; inset:0; pointer-events:none; }
.model-overlay :deep(canvas) { display:block; width:100%; height:100%; }
.model-overlay span { position:absolute; bottom:3px; left:6px; color:white; }
</style>
