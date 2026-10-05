/** Owner's existing private package only; no upload, model turn or Task creation. */
import {openPluginCreator,PACKAGE_ID} from '../src/plugin-publisher.ts'
const platform=await openPluginCreator()
try {
 const data=await platform.read(['plugin.json','.codex-plugin/plugin.json','.app.json','mcp.json','.mcp.json','skills/personal-content/SKILL.md'],['assets/icon.png'])
 if(data.plugin.plugin_id!==PACKAGE_ID||data.plugin.scope!=='USER'||data.plugin.discoverability!=='PRIVATE'||!data.binaryContents?.['assets/icon.png'])throw Error('verification_failed')
 console.log(JSON.stringify({ok:true,pluginId:PACKAGE_ID,version:data.plugin.version,releaseId:data.plugin.current_release_id,scope:data.plugin.scope,files:data.files.length,iconBytes:Buffer.from(data.binaryContents['assets/icon.png'],'base64').length,uploadAttempted:false}))
}finally{await platform.close()}
