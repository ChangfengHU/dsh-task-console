/** Version-fenced native menu fix: arrival order must not determine default focus. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const highlight = 'const highlight = validHighlight(state.highlight, groups) ?? firstHighlight(groups);'
const chosen = 'const highlight = (state.dtcMenuFocusMoved ? validHighlight(state.highlight, groups) : null) ?? firstHighlight(groups);'
const unchanged = 'if (hl && next.source === hl.source && next.index === hl.index) return state;'
const moved = 'if (state.dtcMenuFocusMoved && hl && next.source === hl.source && next.index === hl.index) return state;'
const selected = 'highlight: next\n'
const selectedMoved = 'highlight: next, dtcMenuFocusMoved: true\n'
export function patchInputMenu(source) {
  const changes = [[highlight, chosen, 2], [unchanged, moved, 1], [selected, selectedMoved, 1]]
  if (source.includes('dtcMenuFocusMoved')) {
    if (!changes.every(([, after, count]) => source.split(after).length - 1 === count)) throw Error('Incomplete native menu focus patch')
    return source
  }
  for (const [before, after, count] of changes) {
    if (source.split(before).length - 1 !== count) throw Error('Unsupported native input menu implementation')
    source = source.split(before).join(after)
  }
  return source
}

export function patchActionSubmit(source) {
  const before = 'if (trimmed.startsWith("/")) {'
  const after = 'if (trimmed.startsWith("/") || (trimmed.startsWith("@") && typeof document !== "undefined" && document.documentElement.hasAttribute("data-dsh-task-entry"))) { // dtcActionAdjudication'
  if (source.includes('dtcActionAdjudication')) {
    if (source.split(after).length !== 2) throw Error('Incomplete native Action submit patch')
    return source
  }
  if (source.split(before).length !== 2) throw Error('Unsupported native Action submit implementation')
  return source.replace(before, after)
}

export async function installInputMenuPatch(dshRoot, check = false) {
  const { version } = JSON.parse(await readFile(join(dshRoot, 'package.json'), 'utf8'))
  if (version !== '0.1.1-rc.2') throw Error('Unsupported DSH version for menu focus patch: ' + version)
  const patches = []
  for (const [module, patch, backup] of [
    ['dsh-client-ui-input-trigger', patchInputMenu, '.dtc-menu-focus-backup'],
    ['dsh-client-ui-conversation', patchActionSubmit, '.dtc-action-submit-backup'],
  ]) {
    const file = join(dshRoot, `node_modules/@deepseek-ai/${module}/lib/client.js`)
    const before = await readFile(file, 'utf8'), after = patch(before)
    if (before !== after) patches.push({ file, before, after, backup })
  }
  // Validate every anchor before changing either supported native module.
  if (check) return { changed: false, needed: !!patches.length }
  for (const { file, before, after, backup } of patches) {
    try { await writeFile(file + backup, before, { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }
    await writeFile(file + '.dtc-next', after)
    await rename(file + '.dtc-next', file)
  }
  return { changed: !!patches.length, needed: false }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DSH_INSTALL_ROOT) throw Error('Set DSH_INSTALL_ROOT to the verified running host package')
  if (!['--check', '--apply'].includes(process.argv[2])) throw Error('Specify --check or --apply')
  console.log(JSON.stringify(await installInputMenuPatch(process.env.DSH_INSTALL_ROOT, process.argv[2] === '--check')))
}
