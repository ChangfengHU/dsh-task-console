/**
 * One scoped stylesheet. Every rule is under `dtc-` so nothing leaks into
 * the app. dsh marks dark with `body[data-ds-dark-theme]`; both palettes are
 * defined here and every surface sets background and color together.
 */

const STYLE_ID = 'dsh-task-console-styles'

const CSS = `
.dtc-root {
  --dtc-ground:#f2f4f6; --dtc-surface:#fff; --dtc-surface-2:#e9edf1; --dtc-line:#cfd6dd; --dtc-line-soft:#e1e6eb;
  --dtc-ink:#171d24; --dtc-muted:#586472; --dtc-faint:#8a95a1;
  --dtc-accent:#2a5d86; --dtc-accent-ink:#fff; --dtc-accent-bg:#e3edf6;
  --dtc-ok:#2a6b49; --dtc-ok-bg:#e1efe7; --dtc-warn:#8a5a0a; --dtc-warn-bg:#f6ecd8; --dtc-bad:#a32c30; --dtc-bad-bg:#f7e2e3;
  --dtc-code-bg:#1d2530; --dtc-code-ink:#dfe6ee;
  color:var(--dtc-ink); background:var(--dtc-ground);
  font: 14px/1.6 "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;
}
body[data-ds-dark-theme] .dtc-root {
  --dtc-ground:#0f1317; --dtc-surface:#161b21; --dtc-surface-2:#1d242c; --dtc-line:#2c353f; --dtc-line-soft:#242c35;
  --dtc-ink:#e4e9ee; --dtc-muted:#9aa5b1; --dtc-faint:#6f7a86;
  --dtc-accent:#7db3dc; --dtc-accent-ink:#0f1317; --dtc-accent-bg:#1a2c3b;
  --dtc-ok:#63b88d; --dtc-ok-bg:#15301f; --dtc-warn:#e2b25d; --dtc-warn-bg:#352a14; --dtc-bad:#e08b8e; --dtc-bad-bg:#3a1e1f;
  --dtc-code-bg:#0b0f14; --dtc-code-ink:#d7dfe7;
}
.dtc-root *, .dtc-root *::before, .dtc-root *::after { box-sizing:border-box }
.dtc-root button { font:inherit; color:inherit; background:none; border:0; cursor:pointer }
.dtc-root input, .dtc-root textarea, .dtc-root select { font:inherit; color:var(--dtc-ink); background:var(--dtc-surface); border:1px solid var(--dtc-line); border-radius:5px; padding:7px 10px; width:100% }
.dtc-root textarea { resize:vertical; min-height:96px; line-height:1.55 }
.dtc-root :focus-visible { outline:2px solid var(--dtc-accent); outline-offset:2px }
.dtc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace }
.dtc-muted { color:var(--dtc-muted) } .dtc-faint { color:var(--dtc-faint) }

.dtc-overlay { position:fixed; inset:0; z-index:60; display:flex; flex-direction:column }
.dtc-head { display:flex; align-items:center; gap:16px; padding:0 20px; height:52px; background:var(--dtc-surface); border-bottom:1px solid var(--dtc-line); flex:0 0 auto }
.dtc-head .dtc-ttl { font-weight:600; font-size:15px; display:flex; align-items:center; gap:8px }
.dtc-head .dtc-ttl i { width:14px; height:14px; border-radius:3px; background:var(--dtc-accent); display:inline-block }
.dtc-tabs { display:flex; gap:2px }
.dtc-tab { padding:6px 12px; border-radius:5px; font-size:13.5px; color:var(--dtc-muted) }
.dtc-tab.on { background:var(--dtc-accent-bg); color:var(--dtc-accent); font-weight:500 }
.dtc-tab .n { font-size:11.5px; margin-left:4px; color:var(--dtc-faint) }
.dtc-url { margin-left:auto; font-size:12px; color:var(--dtc-faint); background:var(--dtc-surface-2); padding:3px 10px; border-radius:4px }
.dtc-close { width:32px; height:32px; border-radius:6px; display:grid; place-items:center; font-size:18px; color:var(--dtc-muted) }
.dtc-close:hover { background:var(--dtc-surface-2) }
.dtc-body { flex:1; overflow:auto; padding:20px }
.dtc-crumb { font-size:13px; color:var(--dtc-muted); margin-bottom:12px; display:flex; gap:6px }
.dtc-crumb a { color:var(--dtc-accent); text-decoration:none; cursor:pointer }
.dtc-h1 { font-size:20px; font-weight:600; margin:0 0 14px; display:flex; align-items:center; gap:10px; flex-wrap:wrap }
.dtc-h1 .dtc-acts { margin-left:auto; display:flex; gap:6px }

.dtc-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:5px; border:1px solid var(--dtc-line); background:var(--dtc-surface); color:var(--dtc-ink); font-size:13px; white-space:nowrap }
.dtc-btn:hover { border-color:var(--dtc-accent) }
.dtc-btn.pri { background:var(--dtc-accent); color:var(--dtc-accent-ink); border-color:var(--dtc-accent) }
.dtc-btn.danger { color:var(--dtc-bad) }
.dtc-btn[disabled] { opacity:.45; cursor:not-allowed }
.dtc-btn.sm { padding:3px 9px; font-size:12px }
.dtc-pill { display:inline-block; font-size:11.5px; padding:1px 8px; border-radius:999px; font-weight:500; white-space:nowrap }
.dtc-p-ok { background:var(--dtc-ok-bg); color:var(--dtc-ok) } .dtc-p-warn { background:var(--dtc-warn-bg); color:var(--dtc-warn) }
.dtc-p-bad { background:var(--dtc-bad-bg); color:var(--dtc-bad) } .dtc-p-grey { background:var(--dtc-surface-2); color:var(--dtc-muted) } .dtc-p-acc { background:var(--dtc-accent-bg); color:var(--dtc-accent) }

.dtc-bar { display:flex; align-items:center; gap:12px; margin-bottom:14px; font-size:13px; color:var(--dtc-muted) }
.dtc-bar .sp { flex:1 }
.dtc-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px }
.dtc-card { background:var(--dtc-surface); border:1px solid var(--dtc-line); border-radius:8px; padding:14px 16px; cursor:pointer; display:flex; flex-direction:column; gap:6px; color:var(--dtc-ink); text-align:left }
.dtc-card:hover { border-color:var(--dtc-accent) }
.dtc-card .n { display:flex; align-items:center; gap:8px; font-weight:600 }
.dtc-card .n .id { font-weight:400; color:var(--dtc-faint); font-size:11.5px }
.dtc-card .n .dtc-pill:last-child { margin-left:auto }
.dtc-card .d { font-size:12.5px; color:var(--dtc-muted); min-height:1.6em }
.dtc-card .m { font-size:12px; color:var(--dtc-muted); display:flex; gap:12px; flex-wrap:wrap }
.dtc-card.new { border-style:dashed; align-items:center; justify-content:center; color:var(--dtc-muted); min-height:120px }
.dtc-card.broken { border-color:var(--dtc-bad) }

.dtc-two { display:grid; grid-template-columns:minmax(0,1fr) 380px; gap:14px; align-items:start }
@media (max-width:1000px) { .dtc-two { grid-template-columns:1fr } }
.dtc-panel { background:var(--dtc-surface); border:1px solid var(--dtc-line); border-radius:8px; padding:16px 18px; margin-bottom:14px }
.dtc-panel h3 { margin:0 0 10px; font-size:14px; font-weight:600; display:flex; align-items:center; gap:10px }
.dtc-panel h3 .sp { flex:1 }
.dtc-fields { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px }
.dtc-fields label { display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--dtc-muted) }
.dtc-fields label.wide { grid-column:1 / -1 }
.dtc-tgroup { font-size:12px; color:var(--dtc-faint); text-transform:uppercase; letter-spacing:.06em; margin:10px 0 6px }
.dtc-tools { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:6px }
.dtc-tl { display:flex; gap:8px; align-items:flex-start; border:1px solid var(--dtc-line-soft); border-radius:5px; padding:6px 9px; font-size:12.5px; cursor:pointer; background:var(--dtc-surface); color:var(--dtc-ink) }
.dtc-tl.on { border-color:var(--dtc-accent); background:var(--dtc-accent-bg) }
.dtc-tl input { width:auto; margin-top:3px }
.dtc-tl .tn { font-weight:500 } .dtc-tl .td { color:var(--dtc-muted); font-size:11.5px }
.dtc-tl .w { font-size:10.5px; color:var(--dtc-warn); margin-left:4px }
.dtc-chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center }
.dtc-chip { border:1px solid var(--dtc-line); border-radius:999px; padding:2px 10px; font-size:12px; cursor:pointer; color:var(--dtc-ink); background:var(--dtc-surface) }
.dtc-chip.on { background:var(--dtc-accent); color:var(--dtc-accent-ink); border-color:var(--dtc-accent) }
.dtc-chip.on::after { content:" ×"; opacity:.7 }
.dtc-chips select { width:auto; font-size:12px; padding:3px 6px }
.dtc-note { font-size:12.5px; color:var(--dtc-muted); margin-top:8px }
.dtc-warn { border-left:3px solid var(--dtc-warn); background:var(--dtc-warn-bg); color:var(--dtc-ink); padding:6px 10px; border-radius:4px; font-size:12.5px; margin-top:10px }
.dtc-err { border-left:3px solid var(--dtc-bad); background:var(--dtc-bad-bg); color:var(--dtc-ink); padding:6px 10px; border-radius:4px; font-size:12.5px; margin:10px 0 }
.dtc-yml { background:var(--dtc-code-bg); color:var(--dtc-code-ink); padding:12px 14px; border-radius:6px; font-size:12px; line-height:1.55; overflow:auto; max-height:520px; white-space:pre; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace }
.dtc-sticky { position:sticky; top:0 }

.dtc-modal { position:fixed; inset:0; background:rgba(10,14,18,.45); display:grid; place-items:center; z-index:70 }
.dtc-mbox { background:var(--dtc-surface); color:var(--dtc-ink); border:1px solid var(--dtc-line); border-radius:8px; width:680px; max-width:94vw; max-height:88vh; display:flex; flex-direction:column }
.dtc-mbox .mh { padding:14px 18px; border-bottom:1px solid var(--dtc-line-soft); font-weight:600; display:flex; align-items:center; gap:10px }
.dtc-mbox .mh .dtc-close { margin-left:auto }
.dtc-mbox .mb { padding:16px 18px; font-size:13px; overflow:auto }
.dtc-kv { display:grid; grid-template-columns:90px 1fr; gap:6px 14px; font-size:13px }
.dtc-kv .k { color:var(--dtc-muted) }
.dtc-list { columns:2; column-gap:18px; font-size:12px; line-height:1.7; margin:8px 0 }
.dtc-list div { break-inside:avoid }
.dtc-answer { white-space:pre-wrap; background:var(--dtc-surface-2); border-radius:5px; padding:8px 10px; font-size:12.5px; line-height:1.55; max-height:220px; overflow:auto }
.dtc-spin { display:inline-block; width:12px; height:12px; border:2px solid var(--dtc-line); border-top-color:var(--dtc-accent); border-radius:50%; animation:dtc-spin 1s linear infinite; vertical-align:-2px }
@keyframes dtc-spin { to { transform:rotate(360deg) } }
.dtc-toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); background:var(--dtc-ink); color:var(--dtc-ground); padding:8px 16px; border-radius:6px; font-size:13px; z-index:80 }
.dtc-empty { color:var(--dtc-faint); font-size:13px; text-align:center; padding:40px 20px }
.dtc-empty b { color:var(--dtc-ink) }

/* ── tasks ── */
.dtc-cols { display:grid; grid-template-columns:repeat(5, minmax(200px, 1fr)); gap:12px; min-width:1020px }
.dtc-col { background:var(--dtc-surface-2); border-radius:8px; padding:10px; min-height:360px; display:flex; flex-direction:column; gap:8px }
.dtc-colh { display:flex; justify-content:space-between; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dtc-muted); padding:2px 4px 6px }
.dtc-tcard { background:var(--dtc-surface); border:1px solid var(--dtc-line); border-left:3px solid var(--dtc-faint); border-radius:6px; padding:10px 12px; cursor:pointer; display:flex; flex-direction:column; gap:3px; font-size:13px; color:var(--dtc-ink) }
.dtc-tcard:hover { border-color:var(--dtc-accent) }
.dtc-tcard.s-run { border-left-color:var(--dtc-accent) } .dtc-tcard.s-park { border-left-color:#5b46a0 } .dtc-tcard.s-done { border-left-color:var(--dtc-ok) } .dtc-tcard.s-bad { border-left-color:var(--dtc-bad) } .dtc-tcard.s-cron { border-left-color:var(--dtc-warn) }
.dtc-tcard .t { font-weight:600; display:flex; justify-content:space-between; gap:8px }
.dtc-tcard .t .id { font-weight:400; color:var(--dtc-faint); font-size:11.5px }
.dtc-tcard .l { color:var(--dtc-muted); font-size:12.5px; display:flex; gap:6px; align-items:center; flex-wrap:wrap }
.dtc-tcard .q { color:#5b46a0; font-size:12.5px }
body[data-ds-dark-theme] .dtc-tcard .q { color:#a794e0 }
.dtc-tcard .act { display:flex; gap:6px; margin-top:4px }
.dtc-live { width:7px; height:7px; border-radius:50%; background:var(--dtc-accent); display:inline-block; animation:dtc-blink 1.2s infinite }
@keyframes dtc-blink { 50% { opacity:.25 } }
@media (prefers-reduced-motion:reduce) { .dtc-live { animation:none } }
.dtc-tog { width:30px; height:16px; border-radius:999px; background:var(--dtc-line); position:relative; display:inline-block; vertical-align:middle; cursor:pointer; flex:0 0 auto }
.dtc-tog::after { content:""; position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%; background:var(--dtc-surface); transition:left .15s }
.dtc-tog.on { background:var(--dtc-ok) } .dtc-tog.on::after { left:16px }
.dtc-pipe { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap }
.dtc-pipe .ag { border:1px solid var(--dtc-line); border-radius:5px; padding:1px 8px; font-size:12px; background:var(--dtc-surface-2) }
.dtc-pipe .ar { color:var(--dtc-faint); margin-right:6px }
.dtc-runs { width:100%; border-collapse:collapse; font-size:13px; font-variant-numeric:tabular-nums }
.dtc-runs th, .dtc-runs td { padding:8px 10px; border-bottom:1px solid var(--dtc-line-soft); text-align:left; vertical-align:top }
.dtc-runs th { font-size:12px; color:var(--dtc-muted); font-weight:500 }
.dtc-runs tr.row { cursor:pointer } .dtc-runs tr.row:hover td { background:var(--dtc-surface-2) } .dtc-runs tr.sel td { background:var(--dtc-accent-bg) }
.dtc-dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--dtc-faint) }
.dtc-dot-running { background:var(--dtc-accent) } .dtc-dot-blocked { background:#5b46a0 } .dtc-dot-done { background:var(--dtc-ok) } .dtc-dot-failed, .dtc-dot-timed_out, .dtc-dot-lost { background:var(--dtc-bad) }
.dtc-legs { display:flex; flex-direction:column; gap:10px }
.dtc-leg { border:1px solid var(--dtc-line); border-radius:6px; padding:10px 12px; font-size:13px }
.dtc-leg .lh { display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap } .dtc-leg .lh .sp { flex:1 }
.dtc-hand { white-space:pre-wrap; background:var(--dtc-surface-2); border-radius:5px; padding:8px 10px; font-size:12.5px; line-height:1.55; max-height:320px; overflow:auto }
.dtc-ask { border-left:3px solid #5b46a0; background:rgba(91,70,160,.12); border-radius:5px; padding:8px 12px; margin-top:6px }
.dtc-evlog { font-size:12px; line-height:1.7; max-height:300px; overflow:auto }
.dtc-evlog > div { display:grid; grid-template-columns:62px 1fr; gap:10px } .dtc-evlog .ts { color:var(--dtc-faint) }
.dtc-wiz { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:14px; align-items:start }
@media (max-width:900px) { .dtc-wiz { grid-template-columns:1fr } }
.dtc-step { background:var(--dtc-surface); border:1px solid var(--dtc-line); border-radius:8px; padding:16px 18px; margin-bottom:12px }
.dtc-step h3 { margin:0 0 4px; font-size:14px; display:flex; gap:10px; align-items:baseline } .dtc-step h3 .no { color:var(--dtc-accent); font-weight:600 }
.dtc-step .sub { font-size:12.5px; color:var(--dtc-muted); margin-bottom:10px }
.dtc-pick { display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:8px }
.dtc-pk { border:1px solid var(--dtc-line); border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px; display:flex; gap:8px; align-items:flex-start }
.dtc-pk.on { border-color:var(--dtc-accent); background:var(--dtc-accent-bg) }
.dtc-pk .pn { font-weight:600 } .dtc-pk .pd { color:var(--dtc-muted); font-size:12px }
.dtc-pk .ord, .dtc-oi .ord { width:20px; height:20px; border-radius:50%; background:var(--dtc-accent); color:var(--dtc-accent-ink); display:grid; place-items:center; font-size:11.5px; flex:0 0 auto }
.dtc-pk .ord.off { background:var(--dtc-surface-2); color:var(--dtc-faint) }
.dtc-order { display:flex; flex-direction:column; gap:6px; margin-top:10px }
.dtc-oi { display:flex; align-items:center; gap:8px; border:1px solid var(--dtc-line-soft); border-radius:5px; padding:6px 10px; font-size:13px }
.dtc-oi input { flex:1; width:auto; font-size:12.5px; padding:4px 8px }
.dtc-radio { display:flex; gap:10px; flex-wrap:wrap }
.dtc-rd { border:1px solid var(--dtc-line); border-radius:6px; padding:8px 12px; cursor:pointer; font-size:13px }
.dtc-rd.on { border-color:var(--dtc-accent); background:var(--dtc-accent-bg) }
.dtc-p-park { background:rgba(91,70,160,.14); color:#5b46a0 }
body[data-ds-dark-theme] .dtc-p-park { color:#a794e0 }

/* sidebar footer entry */
.dtc-foot { display:flex; align-items:center; gap:10px; width:100%; padding:8px 10px; border-radius:6px; font-size:13.5px; text-align:left; color:inherit }
.dtc-foot:hover { background:rgba(127,127,127,.12) }
.dtc-foot .ic { width:20px; height:20px; border-radius:5px; display:inline-grid; place-items:center; font-size:12px; background:#2a5d86; color:#fff; flex:0 0 auto }
.dtc-foot.narrow { justify-content:center; padding:8px 0 }
`

export function installStyles(): () => void {
  if (document.getElementById(STYLE_ID)) return () => undefined
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
  return () => { el.remove() }
}
