import {ref,shallowRef,watch,onUnmounted,nextTick} from 'vue'

export const modelDescriptionTopic='/web/map_inputs/_model_description'
export const modelStaticTopic='/web/map_inputs/_model_static_tf'
export function readModelSnapshot(message, revision){
  try{
    const packet=JSON.parse(message.data)
    return revision && packet.revision===revision ? packet : null
  }catch{return null}
}

const names={chuyun:'LEAP_ROS',leap_ros:'LEAP_ROS',leap_ros_max:'LEAP_ROS_MAX',leap_ros_pro:'LEAP_ROS_PRO'}
export const robotVariants=['LEAP_ROS','LEAP_ROS_MAX','LEAP_ROS_PRO']

export function useRobotDisplayModel(){
  const description=shallowRef(null),model=shallowRef(null),status=ref('')
  function receive(message){description.value=message?.data||null}
  function clear(){
    const old=model.value
    model.value=null
    if(old)nextTick(()=>old.dispose())
  }
  function bind(layerEnabled){
    watch([description,layerEnabled],async ([xml,enabled],_,cleanup)=>{
      const controller=new AbortController()
      cleanup(()=>controller.abort())
      clear()
      status.value=''
      if(!enabled||!xml)return
      status.value='正在加载 ROS 发布的模型…'
      try{
        const {loadRobotModel}=await import('./robotModel.js')
        const instance=await loadRobotModel(xml,controller.signal)
        if(controller.signal.aborted){instance.dispose();return}
        instance.name=names[instance.name]||instance.name
        model.value=instance
        status.value=instance.name+' · '+instance.visualCount+' 个可视部件'
      }catch(e){
        if(!controller.signal.aborted)status.value='模型加载失败 · '+e.message
      }
    },{immediate:true})
  }
  onUnmounted(clear)
  return {model,status,receive,bind}
}