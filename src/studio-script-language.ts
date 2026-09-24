/** Detect obvious English-dominant drift; not a language classifier or creative QA. */
export function assertScriptLanguage(policy:any,lines:{id:string;text:string}[]) {
  if(policy.dialogueLanguage!=='zh-CN')return
  const text=lines.map(line=>line.text).join('\n')
  const han=(text.match(/\p{Script=Han}/gu)??[]).length
  const latinWords=(text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)??[]).length
  // Aggregate across dialogue so names, product names and short English replies
  // in an otherwise Chinese story remain possible. Do not rewrite user text.
  if(latinWords>=8&&latinWords>han)throw Error('studio-script-language-mismatch: '+JSON.stringify({
    error_code:'studio-script-language-mismatch',expected:'zh-CN',hanCharacters:han,latinWords,
    recorded:false,retryAfterRepair:true,requiresHuman:false,
    action:'Write the complete spoken dialogue primarily in natural Chinese for this task, then resubmit studio_freeze_script before synthesis. English direction notes are not spoken dialogue. Short names and occasional English replies are allowed. Do not add Chinese filler to satisfy counts; restore the requested story language.',
  }))
}
