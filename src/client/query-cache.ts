/** Memory-only, scoped to one mounted API/session. No credentials or disk cache. */
export class QueryCache<T> {
  private values = new Map<string,{at:number;value:T}>()
  private pending = new Map<string,Promise<T>>()
  private generation = 0
  constructor(private ttl = 15000, private limit = 40) {}
  peek(key:string):T|undefined { const row=this.values.get(key);return row&&Date.now()-row.at<this.ttl?row.value:undefined }
  clear() { this.generation++;this.values.clear();this.pending.clear() }
  put(key:string,value:T) { if(this.values.size>=this.limit&&!this.values.has(key))this.values.delete(this.values.keys().next().value!);this.values.set(key,{at:Date.now(),value}) }
  load(key:string,fetcher:()=>Promise<T>):Promise<T> {
    const pending=this.pending.get(key);if(pending)return pending
    const generation=this.generation
    const promise=Promise.resolve().then(fetcher).then(value=>{
      if(generation===this.generation)this.put(key,value)
      return value
    }).finally(()=>{if(this.pending.get(key)===promise)this.pending.delete(key)})
    this.pending.set(key,promise);return promise
  }
}
