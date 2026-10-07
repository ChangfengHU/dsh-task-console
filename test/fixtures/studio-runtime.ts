/** Deterministic technical contract fixtures, never live calibration or film approval. */
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex')

export async function executionAssetProof(cwd:string,proofPath:string){
 const paths=['assets/vendor/gsap.min.js','assets/Chinese.ttf','assets/licenses/GSAP-LICENSE.txt','assets/licenses/DROID-NOTICE.txt','assets/licenses/GSAP-STANDARD-LICENSE.html','assets/licenses/SOURCES.json','assets/licenses/runtime-assets-manifest.json']
 const files=[]
 for(const path of paths){
  const absolutePath=join(cwd,path);await mkdir(dirname(absolutePath),{recursive:true});await writeFile(absolutePath,'fixture')
  const bytes=await readFile(absolutePath);files.push({path,absolutePath,bytes:bytes.length,sha256:sha(bytes)})
 }
 const bundleManifestSha256=files.at(-1)!.sha256
 return {execution_assets:{ok:true,schema:'studio-execution-assets-v1',proofPath,files,bundleManifestSha256},hyperframes:{timeline_verified:true,font_loaded_verified:true,runtimeAssetsManifestSha256:bundleManifestSha256}}
}

export async function speechCalibrationFixture(cwd:string,audioSha256:string,model='qwen3.8-omni-flash'){
 const row=(sample:string,content_gate:string,code?:string)=>({sample,ok:true,audio_sha256:audioSha256,content_gate,issues:code?[{code}]:[],observation:{input_modality:'input_audio',finish_reason:'stop',audio_sha256:audioSha256,requested_model:model}})
 const calibration={schema:'studio-speech-calibration-v1',speech_calibration_pass:true,results:[row('clean','pass'),row('missing','blocked','no_audible_signal')]}
 const regression={results:[row('silence','blocked','speech_delete'),row('noise','blocked')]}
 const calibrationPath=join(cwd,'speech-calibration-fixture.json'),calibrationRegressionPath=join(cwd,'speech-regression-fixture.json')
 await writeFile(calibrationPath,JSON.stringify(calibration));await writeFile(calibrationRegressionPath,JSON.stringify(regression))
 return {calibrationPath,calibrationRegressionPath,audioObserverModel:model}
}
