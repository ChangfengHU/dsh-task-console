/** Model presentation mirrors existing execution grants; it grants no new authority. */
const all = ['planner','executor','reviewer','studio-stage'] as const
export const STUDIO_TOOL_ROLES:Record<string,readonly string[]> = {
 studio_read_guide:all, studio_status:all, studio_character_profile:all,
 studio_character_image:all, studio_reference_overview:all, studio_reference_frames:all,
 studio_reference_audio:all, studio_probe_audio_sources:all,
 studio_read_text:['planner','reviewer'], studio_freeze_script:['planner'],
 studio_upload_preview:['executor'], studio_render_start:['executor'], studio_render_status:['executor'],
 studio_register_candidate:['executor'], studio_register_speech_plan:['executor'], studio_compile_storyboard:['executor'],
 studio_download_asset:['executor','studio-stage'], studio_preview_image:['executor','studio-stage'],
 studio_preview_frames:['executor','studio-stage'], studio_preview_audio:['executor','studio-stage'],
 studio_request_preparation_revision:['studio-stage'], studio_register_stage:['studio-stage'],
 studio_inspect_frames:['reviewer'], studio_inspect_probe:['reviewer'], studio_inspect_audio:['reviewer'],
 studio_submit_review:['reviewer'], studio_check_speech:['reviewer'],
}
export function studioToolAllowed(name:string,role:unknown):boolean {
 return typeof role==='string'&&STUDIO_TOOL_ROLES[name]?.includes(role)===true
}
export function assertStudioToolRole(name:string,role:unknown):void {
 if(!studioToolAllowed(name,role))throw Error('studio-role-denied')
}
export function studioRoleToolNames(role:unknown):string[] {
 return Object.keys(STUDIO_TOOL_ROLES).filter(name=>studioToolAllowed(name,role))
}
export function studioRoleGuidance(role:unknown):string {
 const shared='For a locked character use studio_status.characterReferences[].id with studio_character_image. Use studio_reference_overview/frames for the locked reference. Main-model images and producer observations are context/self-check only, never independent QA or approval.'
 if(role==='planner')return shared+' Planner currently has no arbitrary preparation-image read grant: do not call read_image or studio_preview_image on preparation files. Use registered stage summaries and text files to plan; if exact preparation-image inspection is required, request a host-authorized receipt-bound inspection capability instead of retrying denied tools.'
 if(role==='executor'||role==='studio-stage')return shared+' For actual project PNG/JPEG or a pilot MP4 use studio_preview_image/frames, not ungranted read_image. These tools enforce project paths and source SHA. Native images are delivered only when the exact current model route declares image input; text-only routes retain the host observer result.'
 if(role==='reviewer')return shared+' Independent candidate review uses studio_inspect_frames/audio/probe and studio_check_speech. Producer previews and main-model visual opinions do not replace host-bound review receipts.'
 return 'No Studio production or review tool grant is available for this role.'
}
