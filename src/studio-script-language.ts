/** Conservative structural guard for new freezes, not a stage-direction classifier.
 * A leading text-bearing bracket block is ambiguous in a spoken-only field.
 * Do not strip it or guess whether it is spoken. Inline/quoted parentheses and
 * ordinary speech punctuation remain intact; notes belong in the storyboard.
 * Existing persisted scripts and completed voice operations are never rewritten.
 */
export function assertSpokenDialogue(lines:{id:string;text:string}[]) {
  for(const [index,line] of lines.entries()){
    const match=/^\s*(?:（([^（）\r\n]+)）|\(([^()\r\n]+)\)|\[([^\[\]\r\n]+)\]|【([^【】\r\n]+)】)/u.exec(line.text)
    const annotation=match?.slice(1).find(value=>value!==undefined)
    // Numeric parenthetical expressions are not performance annotations.
    if(annotation===undefined||!/[\p{L}]/u.test(annotation))continue
    throw Error('studio-script-spoken-text-required: '+JSON.stringify({
      error_code:'studio-script-spoken-text-required',field:`lines[${index}].text`,lineId:line.id,
      reason:'ambiguous-leading-annotation',recorded:false,retryAfterRepair:true,requiresHuman:false,
      action:'Return to the director/planner. lines[].text is spoken dialogue only. Move non-spoken action, sound and delivery directions to storyboard/performance notes linked by line id, not into TTS text. If the bracketed words are intended to be spoken, the director must explicitly phrase them as normal dialogue and resubmit studio_freeze_script under the existing revision rules. Do not silently strip words, change an existing frozen script downstream, or invent provider emotion parameters. Actual audio review is still required.',
    }))
  }
}

/** Detect obvious English-dominant drift; not a language classifier or creative QA. */
export function assertScriptLanguage(policy:any,lines:{id:string;text:string}[]) {
  assertSpokenDialogue(lines)
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
