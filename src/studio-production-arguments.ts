/** Diagnose invalid model calls without parsing, repairing or executing their text. */
export function productionArgumentError(name:string,args:unknown):string|undefined {
 if(!['write','edit','bash','run_code'].includes(name))return
 if(args!==null&&typeof args==='object'&&!Array.isArray(args))return
 const size=typeof args==='string'?args.length:0
 return `studio-production-arguments-object-required: ${name} requires a structured JSON object, not an encoded string, array or null (receivedTextCharacters=${size}). This tool body was not invoked. Inspect actual files before retrying; do not assume content was saved. A large call may have been truncated, but this error alone does not prove the provider finish reason. Preserve the complete design by writing smaller HTML/CSS/JS/data modules or bounded patches and checking each saved part, rather than resending the same full file. Do not shorten the story, drop scenes, remove sound, or replace animation with placeholders to work around transport limits.`
}
