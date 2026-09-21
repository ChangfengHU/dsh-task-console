import { useCallback, useEffect, useState } from 'react'
import type { TasksApi, TaskPage } from './TasksView.tsx'
import type { TaskListQuery } from '../task-list.ts'
import { QueryCache } from './query-cache.ts'
const caches=new WeakMap<TasksApi,QueryCache<TaskPage>>()
export function useTaskPage(api:TasksApi, query:TaskListQuery) {
  let cache=caches.get(api);if(!cache){cache=new QueryCache();caches.set(api,cache)}
  const key=JSON.stringify(query), [revision,setRevision]=useState(0)
  const [state,setState]=useState<{key:string;data?:TaskPage;error?:string}>({key,data:cache.peek(key)})
  const reload=useCallback(async()=>{cache!.clear();setRevision(n=>n+1)},[cache])
  useEffect(()=>{
    let live=true,timer:ReturnType<typeof setTimeout>
    setState({key,data:cache!.peek(key)})
    const refresh=async()=>{
      if(!live)return
      if(document.hidden){timer=setTimeout(refresh,10000);return}
      try{const data=await cache!.load(key,()=>api.taskPage(JSON.parse(key)));if(live)setState({key,data})}
      catch(e){if(live)setState(old=>({...old,key,error:String((e as Error).message??e)}))}
      if(live)timer=setTimeout(refresh,10000)
    }
    void refresh()
    return()=>{live=false;clearTimeout(timer)}
  },[api,key,revision,cache])
  return {data:state.key===key?state.data:cache.peek(key),error:state.key===key?state.error:undefined,reload}
}
