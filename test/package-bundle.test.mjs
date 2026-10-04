import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,cp,symlink,readFile,writeFile,appendFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {verifyPackageBundle} from '../scripts/prepare-package.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}
const pack=(cwd,dest)=>JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',dest],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0]
test('pack rebuilds changed source and discards stale lib; installed repack verifies without build dependencies',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-bundle-pack-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const checkout=join(temp,'checkout');await mkdir(join(checkout,'scripts'),{recursive:true})
 for(const p of ['src','studio','lib','presets','docs'])await cp(join(root,p),join(checkout,p),{recursive:true})
 for(const name of ['build.mjs','package-studio.mjs','prepare-package.mjs','configure-studio.mjs'])await cp(join(root,'scripts',name),join(checkout,'scripts',name))
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
 pkg.scripts.prepack='node scripts/prepare-package.mjs'
 if(!pkg.files.includes('scripts/prepare-package.mjs'))pkg.files.push('scripts/prepare-package.mjs')
 await writeFile(join(checkout,'package.json'),JSON.stringify(pkg,null,2)+'\n')
 await symlink(join(root,'node_modules'),join(checkout,'node_modules'),'dir')
 const sentinel='package_source_sentinel_20260924'
 const oldBundle=await readFile(join(checkout,'lib/index.js'),'utf8');assert.ok(!oldBundle.includes(sentinel))
 await writeFile(join(checkout,'lib/obsolete-plugin.js'),'stale code')
 await appendFile(join(checkout,'src/index.ts'),`\nexport const ${sentinel} = true;\n`)
 const packed=pack(checkout,temp)
 assert.ok(!packed.files.some(f=>f.path==='lib/obsolete-plugin.js'))
 assert.ok(packed.files.some(f=>f.path==='lib/PACKAGE_MANIFEST.json'))
 execFileSync('tar',['-xzf',join(temp,packed.filename),'-C',temp])
 const installed=join(temp,'package')
 assert.ok((await readFile(join(installed,'lib/index.js'),'utf8')).includes(sentinel))
 const manifest=await verifyPackageBundle(installed)
 assert.ok(manifest.files['client.js']);assert.ok(manifest.files['workflows/release-audit.mjs'])
 // No node_modules, build script or parent helper checkout exists here.
 pack(installed,temp)
 await appendFile(join(installed,'src/index.ts'),'\n// changed after packing\n')
 assert.throws(()=>pack(installed,temp),/package-source-mismatch/)
 await cp(join(checkout,'src/index.ts'),join(installed,'src/index.ts'))
 await appendFile(join(installed,'lib/index.js'),'\n// stale or tampered\n')
 assert.throws(()=>pack(installed,temp),/package-bundle-mismatch/)
})
