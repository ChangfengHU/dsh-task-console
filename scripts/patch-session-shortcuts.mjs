/** Version-fenced bridge only: the plugin owns state, labels and persistence. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const MARKER = 'dtc:session-shortcuts-v1'
export function patchSessionShortcuts(source) {
  if (source.includes(MARKER)) {
    if (!source.includes('...dshSessionShortcuts?.menu(node.id) ?? []') || !source.includes('renderSlot("sidebar.workspaces.shortcuts")')) throw Error('Incomplete Session shortcuts host patch')
    return source
  }
  let out = source
  const replace = (before, after) => {
    if (out.split(before).length !== 2) throw Error('Session shortcuts host anchor mismatch')
    out = out.replace(before, after)
  }
  replace('function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {', `function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, drag, flat = false, t }) {
            // ${MARKER}: additive native menu bridge; no native session state writes.
            const [, dshShortcutChange] = (0, react.useState)(0);
            (0, react.useEffect)(() => {
              const change = () => dshShortcutChange(n => n + 1);
              window.addEventListener("dtc:session-shortcuts", change);
              return () => window.removeEventListener("dtc:session-shortcuts", change);
            }, []);
            const dshSessionShortcuts = window.__DSHSessionShortcuts__;`)
  replace('const sessionMenuItems = [', 'const sessionMenuItems = [\n                ...dshSessionShortcuts?.menu(node.id) ?? [],')
  replace('if (id === "archive") onArchive(node.id);', 'if (id === "archive") onArchive(node.id);\n                                    dshSessionShortcuts?.select(node.id, id);')
  replace('children: { "sidebar.workspaces.directoryFlow": {', 'children: { "sidebar.workspaces.shortcuts": {kind: "single", scope: "root"}, "sidebar.workspaces.directoryFlow": {')
  const start = '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.listArea,\n\t\t\t\t\t\tchildren: wide && ('
  replace(start, '\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\t\tclassName: WorkspaceBrowser_module_css_default.listArea,\n\t\t\t\t\t\tchildren: [wide && normalizedQuery === "" && renderSlot("sidebar.workspaces.shortcuts"), wide && (')
  replace('\t\t\t\t\t\t}))\n\t\t\t\t\t}),\n\t\t\t\t\t(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {\n\t\t\t\t\t\topen: renameTarget !== null,', '\t\t\t\t\t\t}))]\n\t\t\t\t\t}),\n\t\t\t\t\t(0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {\n\t\t\t\t\t\topen: renameTarget !== null,')
  return out
}

export async function installSessionShortcutPatch(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.version !== '0.1.1-rc.2') throw Error('Session shortcuts: unsupported DSH version')
  const path = join(root, 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js')
  const before = await readFile(path, 'utf8'), after = patchSessionShortcuts(before)
  if (after === before) return { changed: false }
  try { await writeFile(`${path}.dtc-session-shortcuts-backup`, before, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await writeFile(`${path}.dtc-next`, after)
  await rename(`${path}.dtc-next`, path)
  return { changed: true }
}
