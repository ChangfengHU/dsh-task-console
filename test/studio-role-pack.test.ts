import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {loadStudioRolePack,inspectStudioRoleDependencies,STUDIO_ROLE_IDS} from '../src/studio-role-pack.ts'
import {readSpec,renderComposition} from '../src/presets.ts'
const root=fileURLToPath(new URL('../studio/roles',import.meta.url))
async function copy(t:any){const target=await mkdtemp(join(tmpdir(),'studio-role-pack-'));t.after(()=>rm(target,{recursive:true,force:true}));await cp(root,target,{recursive:true});return target}
async function rewrite(target:string,role:string,edit:(spec:any)=>void){const path=join(target,role,'task-console.json'),spec=JSON.parse(await readFile(path,'utf8'));edit(spec);const bytes=JSON.stringify(spec);await writeFile(path,bytes);const m=JSON.parse(await readFile(join(target,'manifest.json'),'utf8'));m.roles.find((r:any)=>r.role===role).sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(join(target,'manifest.json'),JSON.stringify(m))}
test('six canonical authored roles are portable, distinct and inherit private host model choice',async()=>{
 const pack=await loadStudioRolePack();assert.equal(pack.roles.length,6);assert.deepEqual(pack.roles.map(r=>r.role),STUDIO_ROLE_IDS);assert.equal(new Set(pack.roles.map(r=>r.spec.id)).size,6)
 assert.deepEqual(pack.roles.map(r=>r.taskRole),['planner','studio-stage','studio-stage','studio-stage','executor','reviewer'])
 for(const role of pack.roles){assert.deepEqual(role.spec,await readSpec(join(root,role.role)));assert.equal(role.spec.model,'');assert.equal(role.spec.effort,'');assert.equal(role.spec.permissionPreset,'workspace-write');assert.ok(role.requiredHostTools.includes('studio_character_profile'));assert.ok(role.spec.tools.includes('studio-runtime'))
  assert.doesNotMatch(JSON.stringify(role.spec),/\/home\/|https?:\/\/|xuman-campus|qwen-plus|Codex App Server|甜美桃子|Authorization|Bearer|0\.8\.51/)
  assert.ok(!Object.keys(role.spec.mcpTools).some(s=>/vault|douyin|wecom/.test(s)));assert.ok(!Object.values(role.spec.mcpTools).flat().some(t=>/publish|asset_register|asset_revise|\*/.test(t)))
 }
 assert.equal(pack.installed,false);assert.equal(pack.runtimeVerified,false);assert.equal(pack.publishingGranted,false)
})
test('paid generation is stage-specific and independent review has no production tool grants',async()=>{
 const pack=await loadStudioRolePack(),by=Object.fromEntries(pack.roles.map(r=>[r.role,r.spec]))
 for(const [role,spec] of Object.entries(by)){const names=Object.values(spec.mcpTools).flat();if(role!=='visual')assert.ok(!names.some(n=>/generate_image/.test(n)));if(role!=='sound')assert.ok(!names.some(n=>/synthesize|retry_segments/.test(n)))}
 assert.deepEqual(by.quality.tools,['studio-runtime']);assert.deepEqual(by.quality.mcpTools,{});assert.deepEqual(by.quality.skills,['studio-quality']);assert.deepEqual(by.editor.mcpTools,{})
 const contract=renderComposition(by.quality,[]).capabilities!;assert.ok(!contract.allowedTools.includes('bash'));assert.ok(!contract.allowedTools.includes('write'));assert.ok(contract.allowedTools.includes('studio_character_profile'));assert.match(by.quality.persona,/不改片、改台词/)
})
test('dependency discovery distinguishes missing and unverified without pretending to probe live services',async()=>{
 const pack=await loadStudioRolePack(),unknown=inspectStudioRoleDependencies(pack)
 assert.equal(unknown.missing.length,0);assert.ok(unknown.unverified.length>0);assert.equal(unknown.inventoryComplete,false)
 const none=inspectStudioRoleDependencies(pack,{skills:[],mcpTools:{},hostTools:[],hostCapabilities:[],defaultModelAvailable:false});assert.equal(none.unverified.length,0);assert.ok(none.missing.some(c=>c.id==='vyibc-image/vyibc-image_generate_image'));assert.ok(none.missing.some(c=>c.id==='public-preview-upload'))
 const inventory={skills:pack.requiredSkills,mcpTools:pack.requiredMcp,hostTools:pack.roles.flatMap(r=>r.requiredHostTools),hostCapabilities:pack.requiredHostCapabilities,defaultModelAvailable:true}
 const full=inspectStudioRoleDependencies(pack,inventory);assert.equal(full.inventoryComplete,true);assert.equal(full.runtimeVerified,false);assert.equal(full.installed,false);assert.equal(full.qualityApproved,false)
 const missing=inspectStudioRoleDependencies(pack,{...inventory,mcpTools:{...pack.requiredMcp,'vyibc-voice':[]}});assert.ok(missing.missing.some(c=>c.id.endsWith('/vyibc-voice_synthesize')))
})
test('loader refuses changed bytes, escalated reviewer grants, private model defaults and missing gate skills',async t=>{
 const changed=await copy(t);await writeFile(join(changed,'quality/task-console.json'),'{}');await assert.rejects(loadStudioRolePack(changed),/template-integrity/)
 for(const [role,edit,reason] of [
  ['quality',(s:any)=>s.tools.push('bash'),/public-grants/],
  ['sound',(s:any)=>s.model='private/provider-account',/public-grants/],
  ['visual',(s:any)=>s.skills=s.skills.filter((v:string)=>v!=='vyibc-character-design'),/required-contract/],
  ['quality',(s:any)=>s.mcpTools={'vyibc-image':['vyibc-image_generate_image']},/mcp-grants/],
  ['visual',(s:any)=>s.mcpTools['vyibc-image']=[],/mcp-grants|authored-spec/],
 ] as const){const target=await copy(t);await rewrite(target,role,edit);await assert.rejects(loadStudioRolePack(target),reason)}
})
test('manifest cannot redirect a role outside the pack or drop required dependency declarations',async t=>{
 const target=await copy(t),path=join(target,'manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'))
 manifest.roles[0].path='../task-console.json';await writeFile(path,JSON.stringify(manifest));await assert.rejects(loadStudioRolePack(target),/role-entry/)
 manifest.roles[0].path='director/task-console.json';manifest.requiredSkills=[];await writeFile(path,JSON.stringify(manifest));await assert.rejects(loadStudioRolePack(target),/dependency-manifest/)
})

test('director and sound roles separate spoken text from performance notes without claiming emotion controls',async()=>{
 const pack=await loadStudioRolePack(),by=Object.fromEntries(pack.roles.map(row=>[row.role,row.spec]))
 assert.match(by.director.persona,/lines.*text/);assert.match(by.director.persona,/按lineId关联的分镜/)
 assert.match(by.sound.persona,/不擅自去括号、删词/);assert.match(by.sound.persona,/emotion_api=false/)
 assert.match(by.sound.persona,/真实试听/)
})
