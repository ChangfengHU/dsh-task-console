import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, deniedToolGuidance } from '../src/agent-tool-fence.ts'

test('denied native image tool points to granted studio inspection without admitting it',()=>{
 let guard:any
 apply({tools:{schemas:()=>[{name:'read_image'}],restrict:()=>{},guard:(g:any)=>guard=g}} as any,{selected:['studio_character_image','studio_preview_image']})
 const denied=guard({name:'read_image'})
 assert.match(denied,/not been granted/);assert.match(denied,/studio_character_image/);assert.match(denied,/studio_preview_image/)
 assert.equal(guard({name:'studio_character_image'}),undefined)
 assert.equal(deniedToolGuidance('read_image',new Set()),'This Agent has not been granted that tool.')
 assert.equal(deniedToolGuidance('unrelated',new Set(['studio_character_image'])),'This Agent has not been granted that tool.')
})

test('selected-tool fence hides current inherited tools and guards later registrations', () => {
  let filter: { allow?: string[]; deny?: string[] } | undefined
  let guard: ((exec: { name: string }) => string | undefined) | undefined
  const local = new Set(['ask_user_question', 'todo_write', 'skill', 'fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report'])
  const inherited = new Set(['bash', 'mcp__vyibc-fleet__vyibc-fleet_node_detail', ...local])
  apply({ tools: {
    schemas: () => [...inherited].map(name => ({ name })),
    restrict: (candidate: typeof filter) => { filter = candidate },
    guard: (candidate: typeof guard) => { guard = candidate },
  } } as any, { selected: [...local] })
  const requestHeaderTools = () => [
    ...[...inherited].filter(name => !filter?.deny?.includes(name)),
  ].sort()

  assert.deepEqual(requestHeaderTools(), [...local].sort())
  inherited.add('schedule_create')
  inherited.add('mcp__vyibc-fleet__vyibc-fleet_node_audit')
  assert.equal(guard?.({ name: 'fleet_onboard_start' }), undefined)
  assert.match(guard?.({ name: 'schedule_create' }) ?? '', /not been granted/)
  assert.match(guard?.({ name: 'mcp__vyibc-fleet__vyibc-fleet_node_audit' }) ?? '', /not been granted/)
  assert.ok(!requestHeaderTools().includes('bash'))
})

test('legacy deny fences remain loadable until presets are explicitly regenerated', () => {
  let seen: unknown
  apply({ tools: { restrict: (candidate: unknown) => { seen = candidate } } } as any, { deny: ['bash', 'bash'] })
  assert.deepEqual(seen, { deny: ['bash'] })
})

test('workflow grants admit only exact live run names and are revoked independently',async()=>{
 const {grantWorkflowTool}=await import('../src/workflow-tool-grants.js')
 let guard:any,legacy:any,active=true
 const ctx=(save:(g:any)=>void)=>({tools:{schemas:()=>[],restrict:()=>{},guard:save}})
 apply(ctx(g=>guard=g) as any,{selected:['task_complete'],workflowRunTools:true})
 apply(ctx(g=>legacy=g) as any,{selected:['task_complete']})
 const exec=(name:string,sid='run-a')=>({name,agent:{session:{id:sid}}})
 assert.match(guard(exec('release_audit_verify')),/not been granted/)
 const revoke=grantWorkflowTool('run-a','release_audit_verify',()=>active)
 assert.equal(guard(exec('release_audit_verify')),undefined)
 assert.match(guard(exec('release_audit_report')),/not been granted/)
 assert.match(guard(exec('release_audit_verify','run-b')),/not been granted/)
 assert.match(legacy(exec('release_audit_verify')),/not been granted/)
 active=false;assert.match(guard(exec('release_audit_verify')),/not been granted/)
 active=true;revoke();assert.match(guard(exec('release_audit_verify')),/not been granted/)
})
