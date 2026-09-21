/** Only removes history suggestions while task-console is active; keeps file references/codecs. */
export function patchTaskMentions(text) {
  if (text.includes('data-dsh-task-entry')) return text
  const before = 'const sessions = quoted === true ? Promise.resolve([]) : ctx.remote.sessionReferenceResolver.candidates'
  if (text.split(before).length !== 2) throw new Error('Unsupported ui-reference session suggestion implementation')
  return text.replace(before, 'const sessions = quoted === true || document.documentElement.hasAttribute("data-dsh-task-entry") ? Promise.resolve([]) : ctx.remote.sessionReferenceResolver.candidates')
}
