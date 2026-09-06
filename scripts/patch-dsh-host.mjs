import { constants } from 'node:fs'
import { access, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { patchHistoryIds } from './patch-history-ids.mjs'

const SUPPORTED_DSH_VERSION = '0.1.1-rc.2'

async function findDshRoot() {
  if (process.env.DSH_INSTALL_ROOT) return process.env.DSH_INSTALL_ROOT
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const executable = join(dir, 'dsh')
    try {
      await access(executable, constants.X_OK)
      return dirname(dirname(realpathSync(executable)))
    } catch { /* this PATH entry does not contain dsh */ }
  }
  throw new Error('找不到 dsh；请设置 DSH_INSTALL_ROOT 指向 @deepseek-ai/dsh 包目录')
}

function occurrences(text, needle) {
  let count = 0
  for (let offset = 0; (offset = text.indexOf(needle, offset)) >= 0; offset += needle.length) count += 1
  return count
}

function replaceExact(text, before, after, label, expected = 1) {
  const found = occurrences(text, before)
  if (found !== expected) throw new Error(`${label}: 预期 ${expected} 处 0.1.1-rc.2 代码片段，实际 ${found} 处`)
  return text.split(before).join(after)
}

async function patchFile(path, transforms, completionMarkers) {
  const original = await readFile(path, 'utf8')
  if (completionMarkers.every((marker) => original.includes(marker))) return false
  let next = original
  for (const [before, after, label, expected] of transforms) next = replaceExact(next, before, after, label, expected)
  if (next === original) return false
  const temporary = `${path}.dtc-next`
  await writeFile(temporary, next)
  await rename(temporary, path)
  return true
}

const dshRoot = await findDshRoot()
const manifest = JSON.parse(await readFile(join(dshRoot, 'package.json'), 'utf8'))
if (manifest.version !== SUPPORTED_DSH_VERSION) {
  throw new Error(`不支持的 DSH 版本 ${manifest.version}；当前补丁只验证过 ${SUPPORTED_DSH_VERSION}`)
}

const packages = join(dshRoot, 'node_modules', '@deepseek-ai')
const workspace = join(packages, 'dsh-workspace', 'lib', 'index.js')
const host = join(packages, 'dsh-host-apiproxy', 'lib', 'index.js')
const connection = join(packages, 'dsh-client-connection', 'lib', 'client.js')
const runtime = join(packages, 'dsh-client-runtime', 'lib', 'client.js')
const ui = join(packages, 'dsh-client-ui-workspace', 'lib', 'client.js')

const changed = []
if (await patchFile(workspace, [
  [
    '\tarchivedSessionIds: z.array(z.string().transform(SessionId)).default([]),\n\tpendingMutation:',
    '\tarchivedSessionIds: z.array(z.string().transform(SessionId)).default([]),\n\tinternalSessionIds: z.array(z.string().transform(SessionId)).default([]),\n\tpendingMutation:',
    'workspace schema',
  ],
  [
    '\t\t\tworkspaceIds: [],\n\t\t\tarchivedSessionIds: []',
    '\t\t\tworkspaceIds: [],\n\t\t\tarchivedSessionIds: [],\n\t\t\tinternalSessionIds: []',
    'workspace initial state',
  ],
  [
    '\tget archivedSessionIds() {\n\t\treturn this.requireState().archivedSessionIds;\n\t}\n\t/**\n\t* Archive one session durably.',
    `\tget archivedSessionIds() {
\t\treturn this.requireState().archivedSessionIds;
\t}
\tget internalSessionIds() {
\t\treturn this.requireState().internalSessionIds;
\t}
\tmarkSessionInternal(sessionId) {
\t\treturn this.enqueueOperation(async () => {
\t\t\tconst current = this.requireState();
\t\t\tif (current.internalSessionIds.includes(sessionId) && !current.archivedSessionIds.includes(sessionId)) return;
\t\t\tif (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId);
\t\t\tconst state = this.requireState();
\t\t\tawait this.setState({
\t\t\t\t...state,
\t\t\t\tarchivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
\t\t\t\tinternalSessionIds: state.internalSessionIds.includes(sessionId) ? state.internalSessionIds : [...state.internalSessionIds, sessionId]
\t\t\t});
\t\t});
\t}
\t/**
\t* Archive one session durably.`,
    'workspace internal capability',
  ],
  ['workspaceIds: [id, ...state.workspaceIds],\n\t\t\t\tarchivedSessionIds: state.archivedSessionIds', 'workspaceIds: [id, ...state.workspaceIds],\n\t\t\t\tarchivedSessionIds: state.archivedSessionIds,\n\t\t\t\tinternalSessionIds: state.internalSessionIds', 'workspace create'],
  ['workspaceIds: state.workspaceIds.filter((workspaceId) => workspaceId !== id),\n\t\t\tarchivedSessionIds: state.archivedSessionIds', 'workspaceIds: state.workspaceIds.filter((workspaceId) => workspaceId !== id),\n\t\t\tarchivedSessionIds: state.archivedSessionIds,\n\t\t\tinternalSessionIds: state.internalSessionIds', 'workspace delete'],
  ['workspaceIds: state.workspaceIds,\n\t\t\tarchivedSessionIds: state.archivedSessionIds', 'workspaceIds: state.workspaceIds,\n\t\t\tarchivedSessionIds: state.archivedSessionIds,\n\t\t\tinternalSessionIds: state.internalSessionIds', 'workspace recovery'],
  [
    '\t\t\tinitialized: false,\n\t\t\tworkspaceIds,\n\t\t\tarchivedSessionIds: state.archivedSessionIds\n\t\t});',
    '\t\t\tinitialized: false,\n\t\t\tworkspaceIds,\n\t\t\tarchivedSessionIds: state.archivedSessionIds,\n\t\t\tinternalSessionIds: state.internalSessionIds\n\t\t});',
    'workspace bootstrap interim',
  ],
  [
    '\t\t\tinitialized: true,\n\t\t\tworkspaceIds,\n\t\t\tarchivedSessionIds: state.archivedSessionIds\n\t\t});',
    '\t\t\tinitialized: true,\n\t\t\tworkspaceIds,\n\t\t\tarchivedSessionIds: state.archivedSessionIds,\n\t\t\tinternalSessionIds: state.internalSessionIds\n\t\t});',
    'workspace bootstrap final',
  ],
], ['internalSessionIds: z.array', 'markSessionInternal(sessionId)', 'internalSessionIds: state.internalSessionIds'])) changed.push('workspace')

if (await patchFile(host, [
  [
    'function projectionsFor(ctx, session) {\n\tconst registry = ctx.get("sessionProjections");\n\tif (registry === void 0) return void 0;\n\treturn registry.snapshot(session);\n}\n/**\n* The projection baseline',
    `function projectionsFor(ctx, session) {
\tconst registry = ctx.get("sessionProjections");
\tif (registry === void 0) return void 0;
\treturn registry.snapshot(session);
}
const SESSION_LIST_PROJECTION_KEYS = new Set(["sessionListMetadata", "title", "tokenUsage", "subagentTiming"]);
function listProjectionSubset(block) {
\tif (block === void 0) return void 0;
\tconst values = Object.fromEntries(Object.entries(block.values).filter(([key]) => SESSION_LIST_PROJECTION_KEYS.has(key)));
\treturn Object.keys(values).length === 0 ? void 0 : { asOfSeq: block.asOfSeq, values };
}
/**
* The projection baseline`,
    'session list projection subset',
  ],
  [
    'return block !== void 0 && Object.keys(block.values).length > 0 ? block : void 0;',
    'return listProjectionSubset(block);',
    'session list projection use',
  ],
  [
    'const visible = await listVisibleSessionSummaries(signal);\n\t\t\t\t\tif (isAborted(signal))',
    'const internal = new Set(ctx.get("workspaceRegistry")?.internalSessionIds ?? []);\n\t\t\t\t\tconst visible = (await listVisibleSessionSummaries(signal)).filter((item) => !internal.has(item.sessionId));\n\t\t\t\t\tif (isAborted(signal))',
    'session search visibility',
  ],
  [
    'archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds]\n\t\t\t\t}));',
    'archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds],\n\t\t\t\t\tinternalSessionIds: [...(ctx.workspaceRegistry.internalSessionIds ?? [])]\n\t\t\t\t}));',
    'workspace list internal ids',
  ],
  [
    'let archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds;\n\t\t\t\tconst disposers',
    'let archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds;\n\t\t\t\tlet internalSessionIds = ctx.workspaceRegistry.internalSessionIds ?? [];\n\t\t\t\tconst disposers',
    'host internal stream baseline',
  ],
  [
    '\t\t\t\t\t\t\treturn;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tif (change.table !== "workspaces") return;',
    `\t\t\t\t\t\t\tif (state.internalSessionIds.length !== internalSessionIds.length || state.internalSessionIds.some((id, index) => id !== internalSessionIds[index])) {
\t\t\t\t\t\t\t\tinternalSessionIds = state.internalSessionIds;
\t\t\t\t\t\t\t\tqueue.push(frame({ type: "host/internal-sessions-changed", internalSessionIds: [...state.internalSessionIds] }));
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tif (change.table !== "workspaces") return;`,
    'host internal stream event',
  ],
  [
    'items: z$1.array(workspaceViewSchema),\n\tarchivedSessionIds: z$1.array(sessionIdSchema)\n});',
    'items: z$1.array(workspaceViewSchema),\n\tarchivedSessionIds: z$1.array(sessionIdSchema),\n\tinternalSessionIds: z$1.array(sessionIdSchema)\n});',
    'host workspace schema',
  ],
  [
    '\t\ttype: z$1.literal("host/archived-sessions-changed"),\n\t\tarchivedSessionIds: z$1.array(sessionIdSchema)\n\t}),\n\tz$1.object({\n\t\ttype: z$1.literal("host/remote-event")',
    '\t\ttype: z$1.literal("host/archived-sessions-changed"),\n\t\tarchivedSessionIds: z$1.array(sessionIdSchema)\n\t}),\n\tz$1.object({\n\t\ttype: z$1.literal("host/internal-sessions-changed"),\n\t\tinternalSessionIds: z$1.array(sessionIdSchema)\n\t}),\n\tz$1.object({\n\t\ttype: z$1.literal("host/remote-event")',
    'host frame schema',
  ],
], ['SESSION_LIST_PROJECTION_KEYS', 'host/internal-sessions-changed', 'internalSessionIds: [...(ctx.workspaceRegistry.internalSessionIds ?? [])]'])) changed.push('host')

// Sessions created by another Host plugin already carry AgentOptions. The Web
// gateway used to replace those options with its global default while the
// session was still blank, so an authored Agent visibly said Terra/high but
// its first request ran on Luna. Preserve the direct creator's selection; a
// later explicit Web model switch still wins through `picked` above it.
if (await patchFile(host, [[
  '\t\t\t\tconst logged = agent.session.requestHeader()?.config;\n\t\t\t\tif (logged === void 0) return defaults.defaultModelSelection();',
  `\t\t\t\tconst logged = agent.session.requestHeader()?.config;
\t\t\t\tif (logged === void 0) {
\t\t\t\t\tconst configured = agent.options;
\t\t\t\t\tconst fallback = defaults.defaultModelSelection();
\t\t\t\t\tconst provider = configured.provider ?? fallback.provider;
\t\t\t\t\tconst model = configured.model ?? fallback.model;
\t\t\t\t\tconst inheritsDefaultEffort = provider === fallback.provider && model === fallback.model;
\t\t\t\t\tconst reasoningEffort = configured.reasoningEffort ?? (inheritsDefaultEffort ? fallback.reasoningEffort : void 0);
\t\t\t\t\treturn { provider, model, ...reasoningEffort === void 0 ? {} : { reasoningEffort } };
\t\t\t\t}`,
  'plugin-created Agent model selection',
]], ['const inheritsDefaultEffort = provider === fallback.provider && model === fallback.model;'])) changed.push('host-agent-model')

if (await patchFile(connection, [
  ['items: array(workspaceViewSchema),\n\t\t\tarchivedSessionIds: array(sessionIdSchema)\n\t\t});', 'items: array(workspaceViewSchema),\n\t\t\tarchivedSessionIds: array(sessionIdSchema),\n\t\t\tinternalSessionIds: array(sessionIdSchema)\n\t\t});', 'client workspace schema'],
  ['type: literal("host/archived-sessions-changed"),\n\t\t\t\tarchivedSessionIds: array(sessionIdSchema)\n\t\t\t}),\n\t\t\tobject({\n\t\t\t\ttype: literal("host/remote-event")', 'type: literal("host/archived-sessions-changed"),\n\t\t\t\tarchivedSessionIds: array(sessionIdSchema)\n\t\t\t}),\n\t\t\tobject({\n\t\t\t\ttype: literal("host/internal-sessions-changed"),\n\t\t\t\tinternalSessionIds: array(sessionIdSchema)\n\t\t\t}),\n\t\t\tobject({\n\t\t\t\ttype: literal("host/remote-event")', 'client host frame schema'],
], ['host/internal-sessions-changed', 'internalSessionIds: array(sessionIdSchema)'])) changed.push('connection')

if (await patchFile(runtime, [
  ['\t\t\tarchivedSessionIds = [];\n\t\t\tstate = "idle";', '\t\t\tarchivedSessionIds = [];\n\t\t\tinternalSessionIds = [];\n\t\t\tstate = "idle";', 'workspace runtime state'],
  ['this.installArchived(result.value.archivedSessionIds);\n\t\t\t\t\t\t\tthis.state', 'this.installArchived(result.value.archivedSessionIds);\n\t\t\t\t\t\t\tthis.installInternal(result.value.internalSessionIds ?? []);\n\t\t\t\t\t\t\tthis.state', 'workspace runtime baseline'],
  ['else if (envelope.payload.type === "host/archived-sessions-changed") this.installArchived(envelope.payload.archivedSessionIds);\n\t\t\t}', 'else if (envelope.payload.type === "host/archived-sessions-changed") this.installArchived(envelope.payload.archivedSessionIds);\n\t\t\t\telse if (envelope.payload.type === "host/internal-sessions-changed") this.installInternal(envelope.payload.internalSessionIds);\n\t\t\t}', 'workspace runtime event'],
  ['archivedSessionIds: this.archivedSessionIds,\n\t\t\t\t\tstate:', 'archivedSessionIds: this.archivedSessionIds,\n\t\t\t\t\tinternalSessionIds: this.internalSessionIds,\n\t\t\t\t\tstate:', 'workspace runtime snapshot'],
  ['\t\t\t/** Reorder known Workspace objects', '\t\t\tinstallInternal(internalSessionIds) {\n\t\t\t\tif (internalSessionIds.length === this.internalSessionIds.length && internalSessionIds.every((id, index) => id === this.internalSessionIds[index])) return;\n\t\t\t\tthis.internalSessionIds = [...internalSessionIds];\n\t\t\t\tthis.notifier.markDirty();\n\t\t\t}\n\t\t\t/** Reorder known Workspace objects', 'workspace runtime installer'],
  ['items: [],\n\t\t\t\t\tarchivedSessionIds: [],\n\t\t\t\t\tstate:', 'items: [],\n\t\t\t\t\tarchivedSessionIds: [],\n\t\t\t\t\tinternalSessionIds: [],\n\t\t\t\t\tstate:', 'workspace service initial'],
  ['archivedSessionIds: workspace.archivedSessionIds,\n\t\t\t\t\tstate:', 'archivedSessionIds: workspace.archivedSessionIds,\n\t\t\t\t\tinternalSessionIds: workspace.internalSessionIds ?? [],\n\t\t\t\t\tstate:', 'workspace service projection'],
], ['installInternal(internalSessionIds)', 'host/internal-sessions-changed', 'internalSessionIds: workspace.internalSessionIds ?? []'])) changed.push('runtime')

if (await patchFile(ui, [
  ['const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);\n\t\t\tconst directoryFlowAvailable', 'const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);\n\t\t\tconst internalSessionIds = useWorkspaces((state) => state.internalSessionIds ?? []);\n\t\t\tconst undiscoverableSessionIds = (0, react.useMemo)(() => [...new Set([...archivedSessionIds, ...internalSessionIds])], [archivedSessionIds, internalSessionIds]);\n\t\t\tconst directoryFlowAvailable', 'workspace UI hidden set'],
  ['\t\t\t\t\t\t\tarchivedSessionIds,', '\t\t\t\t\t\t\tarchivedSessionIds: undiscoverableSessionIds,', 'workspace UI consumers', 3],
], ['undiscoverableSessionIds', 'archivedSessionIds: undiscoverableSessionIds'])) changed.push('ui')

changed.push(...await patchHistoryIds(dshRoot))
console.log(changed.length ? `patched DSH ${SUPPORTED_DSH_VERSION}: ${changed.join(', ')}` : `DSH ${SUPPORTED_DSH_VERSION} compatibility patch already applied`)
