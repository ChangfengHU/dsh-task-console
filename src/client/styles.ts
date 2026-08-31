/**
 * One scoped stylesheet. Every rule is under `dtc-` so nothing leaks into
 * the app. dsh marks dark with `body[data-ds-dark-theme]`; both palettes are
 * defined here and every surface sets background and color together.
 */

const STYLE_ID = 'dsh-task-console-styles'

const CSS = `
.dtc-root {
  --dtc-ground:#f3f5f6; --dtc-surface:#fff; --dtc-surface-2:#eaeef0; --dtc-line:#d9dfe3; --dtc-line-soft:#e6ebee;
  --dtc-ink:#161b1e; --dtc-muted:#5f6b73; --dtc-faint:#8e99a1;
  --dtc-accent:#1f6f78; --dtc-accent-ink:#fff; --dtc-accent-bg:#e2f0f1;
  --dtc-ok:#1f7a4d; --dtc-ok-bg:#e2f1e8; --dtc-warn:#b26a00; --dtc-warn-bg:#f7ecd9; --dtc-bad:#b3362f; --dtc-bad-bg:#f8e3e1;
  --dtc-code-bg:#1b2126; --dtc-code-ink:#dbe3e8;
  color:var(--dtc-ink); background:var(--dtc-ground);
  font: 14px/1.55 "IBM Plex Sans","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;
}
body[data-ds-dark-theme] .dtc-root {
  --dtc-ground:#0f1317; --dtc-surface:#161b21; --dtc-surface-2:#1d242c; --dtc-line:#2c353f; --dtc-line-soft:#242c35;
  --dtc-ink:#e4e9ee; --dtc-muted:#9aa5b1; --dtc-faint:#6f7a86;
  --dtc-accent:#7cc3c9; --dtc-accent-ink:#0f1317; --dtc-accent-bg:#1a2c2e;
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

.dtc-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 13px; border-radius:7px; font-weight:500; border:1px solid var(--dtc-line); background:var(--dtc-surface); color:var(--dtc-ink); font-size:13px; white-space:nowrap }
.dtc-btn:hover { border-color:var(--dtc-accent) }
.dtc-btn.pri { background:var(--dtc-accent); color:var(--dtc-accent-ink); border-color:var(--dtc-accent) }
.dtc-btn.danger { color:var(--dtc-bad) }
.dtc-btn[disabled] { opacity:.45; cursor:not-allowed }
.dtc-btn.sm { padding:3px 9px; font-size:12px }
.dtc-pill { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; padding:2px 9px; border-radius:999px; font-weight:500; white-space:nowrap }
.dtc-pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor }
.dtc-pill.dtc-p-grey::before { display:none }
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
.dtc-panel { background:var(--dtc-surface); border:1px solid var(--dtc-line); border-radius:12px; padding:18px 20px; margin-bottom:14px }
.dtc-panel h3 { margin:0 0 12px; font-size:12.5px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; color:var(--dtc-muted); display:flex; align-items:center; gap:10px }
.dtc-panel h3 .dtc-faint { text-transform:none; letter-spacing:0 }
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

/* ── turn ledger ── */
.dtc-tab { padding:16px 20px; background:transparent; color:inherit }
.dtc-tab.dtc-root { background:transparent }
.dtc-totals { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px; margin-bottom:14px }
.dtc-tot { background:var(--dtc-surface); border:1px solid var(--dtc-line); border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:2px }
.dtc-tot b { font-size:18px; font-variant-numeric:tabular-nums } .dtc-tot span { font-size:11.5px; color:var(--dtc-muted) }
.dtc-tot.acc b { color:var(--dtc-accent) } .dtc-tot.warn b { color:var(--dtc-warn) } .dtc-tot.park b { color:#5b46a0 }
body[data-ds-dark-theme] .dtc-tot.park b { color:#a794e0 }
.dtc-tot.wide { grid-column:1 / -1; flex-direction:row; align-items:center; gap:10px }
.dtc-turn { border:1px solid var(--dtc-line); border-radius:8px; background:var(--dtc-surface); padding:10px 14px; margin-bottom:10px }
.dtc-turn-head { display:flex; align-items:center; gap:10px; font-size:13px; margin-bottom:6px } .dtc-turn-head .sp { flex:1 }
.dtc-user { font-size:12.5px; color:var(--dtc-muted); border-left:3px solid var(--dtc-line); padding:4px 10px; margin:4px 0 8px; white-space:pre-wrap }
.dtc-step-row { border-top:1px dashed var(--dtc-line-soft); padding:6px 0 }
.dtc-step-head { display:flex; align-items:center; gap:10px; font-size:12.5px; flex-wrap:wrap } .dtc-step-head .sp { flex:1 }
.dtc-toolrow { margin:4px 0 4px 12px; border:1px solid var(--dtc-line-soft); border-radius:5px; font-size:12.5px }
.dtc-toolrow.bad { border-color:var(--dtc-bad) }
.dtc-toolhead { display:flex; align-items:center; gap:8px; padding:5px 8px; cursor:pointer } .dtc-toolhead .sp { flex:1 }
.dtc-toolhead .name { font-weight:500; white-space:nowrap } .dtc-toolhead .args { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:46% }
.dtc-toolbody { padding:0 10px 8px } .dtc-toolbody pre { margin:2px 0 6px; background:var(--dtc-surface-2); border-radius:4px; padding:6px 8px; white-space:pre-wrap; word-break:break-all; font-size:11.5px; max-height:220px; overflow:auto }

/* ── replay ── */
.dtc-replay { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(300px,1fr); gap:14px; align-items:start }
@media (max-width:1000px) { .dtc-replay { grid-template-columns:1fr } }
.dtc-evlist { max-height:420px; overflow:auto; border:1px solid var(--dtc-line-soft); border-radius:6px }
.dtc-ev { display:grid; grid-template-columns:34px 66px 52px 110px 1fr; gap:8px; align-items:center; padding:5px 8px; font-size:12.5px; border-bottom:1px solid var(--dtc-line-soft); cursor:pointer }
.dtc-ev.off { opacity:.35 } .dtc-ev.cur { background:var(--dtc-accent-bg) } .dtc-ev:hover { background:var(--dtc-surface-2) }
.dtc-ev .n, .dtc-ev .ts { color:var(--dtc-faint) } .dtc-ev .d { overflow:hidden; text-overflow:ellipsis; white-space:nowrap } .dtc-ev .d small { color:var(--dtc-faint); font-family:ui-monospace,Menlo,monospace; font-size:11px; margin-left:8px; opacity:0; transition:opacity .15s } .dtc-ev:hover .d small { opacity:1 }
.dtc-scrub { display:flex; align-items:center; gap:6px; margin-top:10px; flex-wrap:wrap } .dtc-scrub input[type=range] { flex:1; min-width:160px; width:auto; padding:0 }
.dtc-legdetail { padding:8px 4px 4px }
.dtc-roles { display:flex; flex-direction:column; gap:8px }
.dtc-role { border:1px solid var(--dtc-line-soft); border-radius:6px; padding:8px 10px; font-size:12.5px }
.dtc-role .h { display:flex; align-items:center; gap:8px } .dtc-role .h .sp { flex:1 } .dtc-role .h a { color:var(--dtc-accent); cursor:pointer }
.dtc-role .ord { width:18px; height:18px; border-radius:50%; background:var(--dtc-accent); color:var(--dtc-accent-ink); display:grid; place-items:center; font-size:11px }
.dtc-role .b { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin-top:6px } .dtc-role .b > div { display:contents } .dtc-role .k { color:var(--dtc-muted) }

/* ── 0.5 task page: chain / ledger / drawer ── */
.dtc-sub { color:var(--dtc-muted); font-size:13px; margin:-6px 0 16px }
.dtc-chip { display:inline-block; background:var(--dtc-surface-2); border-radius:6px; padding:2px 8px; font-size:12px }
.dtc-chip.stale { background:var(--dtc-warn-bg); color:var(--dtc-warn); font-weight:500 }
.dtc-chain { display:flex; align-items:stretch; overflow-x:auto; padding:6px 2px 10px }
.dtc-node { flex:0 0 auto; width:220px; border:1px solid var(--dtc-line); border-radius:12px; padding:14px 16px; background:var(--dtc-surface); display:flex; flex-direction:column; gap:6px }
.dtc-node .role { display:flex; align-items:center; gap:10px }
.dtc-node .av { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; font-weight:600; font-size:14px; color:#fff; background:var(--dtc-faint) }
.dtc-node.s-running .av { background:var(--dtc-accent) } .dtc-node.s-blocked .av { background:#6b4fbb } .dtc-node.s-done .av, .dtc-node.s-review .av { background:var(--dtc-ok) } .dtc-node.s-failed .av { background:var(--dtc-bad) } .dtc-node.s-todo .av, .dtc-node.s-ready .av, .dtc-node.s-cancelled .av { background:var(--dtc-line); color:var(--dtc-muted) }
.dtc-node .nm { font-weight:600 } .dtc-node .id { font-size:11.5px; color:var(--dtc-faint) }
.dtc-node .st { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--dtc-muted) }
.dtc-node .dur { font-size:20px; font-weight:600; letter-spacing:-.01em; font-variant-numeric:tabular-nums } .dtc-node .dur small { font-size:11.5px; font-weight:400; color:var(--dtc-faint); margin-left:4px }
.dtc-node .q { font-size:12.5px; color:#6b4fbb; background:rgba(107,79,187,.12); border-radius:6px; padding:5px 8px } .dtc-node .q.bad { color:var(--dtc-bad); background:var(--dtc-bad-bg) }
body[data-ds-dark-theme] .dtc-node .q { color:#a794e0 }
.dtc-node.s-running { border-color:var(--dtc-accent); box-shadow:0 0 0 3px var(--dtc-accent-bg) } .dtc-node.s-blocked { border-color:#6b4fbb; box-shadow:0 0 0 3px rgba(107,79,187,.15) }
.dtc-link { flex:0 0 auto; width:54px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px }
.dtc-link .bar { height:3px; width:100%; background:#6b4fbb; border-radius:2px } .dtc-link.open .bar { background:var(--dtc-ok) }
.dtc-link .lbl { font-size:10.5px; color:var(--dtc-faint); white-space:nowrap } .dtc-link.open .lbl { color:var(--dtc-ok) }
.dtc-chain-cap { display:flex; align-items:center; gap:14px; font-size:12.5px; color:var(--dtc-muted); margin-top:6px; flex-wrap:wrap }
.dtc-ledger { display:flex; flex-direction:column; gap:10px }
.dtc-leg { border:1px solid var(--dtc-line); border-radius:10px; overflow:hidden; padding:0 }
.dtc-leg .head { display:grid; grid-template-columns:28px 130px 120px 90px 1fr auto; gap:12px; align-items:center; padding:10px 14px; background:var(--dtc-surface); cursor:pointer }
.dtc-leg .head:hover { background:var(--dtc-surface-2) }
.dtc-leg .no { width:22px; height:22px; border-radius:50%; background:var(--dtc-surface-2); display:grid; place-items:center; font-size:11.5px; font-weight:600; color:var(--dtc-muted) }
.dtc-leg .who { font-weight:600 } .dtc-leg .who small { display:block; font-weight:400; font-size:11px; color:var(--dtc-faint) }
.dtc-leg .io { display:grid; grid-template-columns:1fr 20px 1fr; gap:8px; align-items:center; font-size:12.5px; color:var(--dtc-muted); min-width:0 }
.dtc-leg .io .arr { color:var(--dtc-faint); text-align:center } .dtc-leg .io b { display:block; font-size:11px; color:var(--dtc-faint); font-weight:500; text-transform:uppercase; letter-spacing:.04em } .dtc-leg .io span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.dtc-leg .io > div { min-width:0 }
.dtc-leg .acts { display:flex; gap:6px; white-space:nowrap }
.dtc-leg .bodyx { border-top:1px solid var(--dtc-line-soft); background:var(--dtc-ground); padding:14px 16px }
@media (max-width:1100px) { .dtc-leg .head { grid-template-columns:28px 1fr 1fr; } .dtc-leg .io { grid-column:1 / -1 } }
.dtc-roles { display:flex; flex-direction:column; gap:8px }
.dtc-role { border:1px solid var(--dtc-line-soft); border-radius:8px; padding:8px 10px; font-size:12.5px }
.dtc-role .h { display:flex; align-items:center; gap:8px } .dtc-role .h .sp { flex:1 } .dtc-role .h a { color:var(--dtc-accent); cursor:pointer; font-size:12px }
.dtc-role .ord { width:18px; height:18px; border-radius:50%; background:var(--dtc-accent); color:var(--dtc-accent-ink); display:grid; place-items:center; font-size:11px }
.dtc-role .cap { color:var(--dtc-muted); font-size:12px; display:flex; gap:6px; flex-wrap:wrap; margin-top:4px } .dtc-role .cap em { font-style:normal; background:var(--dtc-surface-2); border-radius:4px; padding:0 6px }
.dtc-evbar { position:fixed; left:0; right:0; bottom:0; z-index:65; display:flex; align-items:center; gap:14px; padding:10px 26px; background:var(--dtc-surface); border-top:1px solid var(--dtc-line); font-size:13px; cursor:pointer; box-shadow:0 -6px 20px rgba(20,30,36,.06); color:var(--dtc-ink) }
.dtc-evbar .sp { flex:1 }
.dtc-drawer { position:fixed; left:0; right:0; bottom:0; z-index:66; background:var(--dtc-surface); border-top:1px solid var(--dtc-line); box-shadow:0 -18px 50px rgba(20,30,36,.16); height:42vh; display:flex; flex-direction:column; color:var(--dtc-ink) }
.dtc-drawer .dh { display:flex; align-items:center; gap:14px; padding:10px 26px; border-bottom:1px solid var(--dtc-line-soft); font-size:13px } .dtc-drawer .dh .sp { flex:1 }
.dtc-drawer .dbody { flex:1; overflow:auto }
.dtc-ev { display:grid; grid-template-columns:34px 66px 58px 1fr; gap:10px; align-items:center; padding:6px 26px; font-size:12.5px; border-bottom:1px solid var(--dtc-line-soft); cursor:pointer }
.dtc-ev:hover { background:var(--dtc-surface-2) } .dtc-ev.off { opacity:.32 } .dtc-ev.cur { background:var(--dtc-accent-bg) }
.dtc-ev .n, .dtc-ev .ts { color:var(--dtc-faint) } .dtc-ev .d { overflow:hidden; text-overflow:ellipsis; white-space:nowrap } .dtc-ev .d small { color:var(--dtc-faint); font-family:ui-monospace,Menlo,monospace; font-size:11px; margin-left:8px; opacity:0; transition:opacity .15s } .dtc-ev:hover .d small { opacity:1 }
.dtc-scrub { display:flex; align-items:center; gap:8px; padding:10px 26px; border-top:1px solid var(--dtc-line-soft); flex-wrap:wrap } .dtc-scrub input[type=range] { flex:1; min-width:200px; width:auto; padding:0 }
.dtc-ask { border-left:3px solid #6b4fbb; background:rgba(107,79,187,.12); border-radius:5px; padding:8px 12px; margin-top:6px }
.dtc-body { padding-bottom:80px }

/* ── sidebar: two stacked entries ── */
.dtc-footstack { display:flex; flex-direction:column; gap:2px; width:100% }
.dtc-foot .ic { background:var(--dtc-accent-bg, #e2f0f1); color:#1f6f78 }

/* ── agents master-detail ── */
.dtc-agents { display:grid; grid-template-columns:280px minmax(0,1fr); height:calc(100% - 52px); min-height:0 }
.dtc-alist { border-right:1px solid var(--dtc-line); background:var(--dtc-surface); display:flex; flex-direction:column; min-height:0 }
.dtc-alist .search { padding:12px 14px; border-bottom:1px solid var(--dtc-line-soft) }
.dtc-alist .items { overflow:auto; flex:1 }
.dtc-alist .newbtn { margin:12px 14px; justify-content:center }
.dtc-aitem { display:grid; grid-template-columns:34px 1fr auto; gap:10px; align-items:center; padding:10px 14px; cursor:pointer; border-left:3px solid transparent; min-width:0 }
.dtc-aitem:hover { background:var(--dtc-surface-2) } .dtc-aitem.on { background:var(--dtc-accent-bg); border-left-color:var(--dtc-accent) }
.dtc-aitem .av { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; color:#fff; font-weight:600 }
.dtc-aitem .nm { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis } .dtc-aitem .d { font-size:11.5px; color:var(--dtc-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.dtc-aitem .perm { width:8px; height:8px; border-radius:50% }
.perm.ro { background:var(--dtc-ok) } .perm.lw { background:var(--dtc-warn) } .perm.w { background:var(--dtc-bad) } .perm.sys { background:var(--dtc-faint) } .perm.bad { background:var(--dtc-bad); outline:2px solid var(--dtc-bad-bg) }
.dtc-adetail { overflow:auto; padding:24px 30px 60px; min-height:0 }
.dtc-ahead { display:flex; align-items:flex-start; gap:16px; margin-bottom:22px }
.dtc-ahead .av { width:56px; height:56px; border-radius:16px; display:grid; place-items:center; color:#fff; font-weight:600; font-size:22px; flex:0 0 auto }
.dtc-ahead .name { font-size:22px; font-weight:600; letter-spacing:-.01em; display:flex; align-items:center; gap:10px; flex-wrap:wrap }
.dtc-ahead .desc { color:var(--dtc-muted); margin-top:2px }
.dtc-ahead .acts { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end }
.dtc-agrid { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:16px; align-items:start }
@media (max-width:1100px) { .dtc-agrid { grid-template-columns:1fr } }
.dtc-rail { display:flex; flex-direction:column; gap:12px; position:sticky; top:0 }
.dtc-matrix { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:8px }
.dtc-cap { border:1px solid var(--dtc-line-soft); border-radius:8px; padding:8px 10px; font-size:12.5px; display:flex; gap:8px; align-items:flex-start; color:var(--dtc-faint); cursor:pointer; background:var(--dtc-surface) }
.dtc-cap.on { border-color:var(--dtc-accent); background:var(--dtc-accent-bg); color:var(--dtc-ink) }
.dtc-cap input { width:auto; margin-top:3px }
.dtc-cap .nm { font-weight:500 } .dtc-cap .w { font-size:10.5px; color:var(--dtc-bad); margin-left:4px } .dtc-cap .d { display:block; font-size:11px; color:var(--dtc-faint) }
.dtc-mcprow { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--dtc-line-soft); border-radius:8px; margin-bottom:8px; cursor:pointer; background:var(--dtc-surface) }
.dtc-mcprow.on { border-color:var(--dtc-accent) } .dtc-mcprow input { width:auto }
.dtc-mcprow .nm { font-weight:600 } .dtc-mcprow .url { font-size:11.5px; color:var(--dtc-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap } .dtc-mcprow .cnt { margin-left:auto; font-size:12px; color:var(--dtc-muted); white-space:nowrap }
.dtc-disc { border:1px solid var(--dtc-line); border-radius:10px; overflow:hidden; background:var(--dtc-surface) }
.dtc-disc .sum { width:100%; text-align:left; padding:10px 14px; font-size:13px; font-weight:500; display:flex; align-items:center; gap:8px }
.dtc-disc .dtc-yml { border-radius:0; max-height:420px }
.dtc-flow { display:inline-flex; align-items:center; gap:4px; flex-wrap:wrap; font-size:11.5px; color:var(--dtc-muted) }
.dtc-flow .dot { width:9px; height:9px; border-radius:50%; background:var(--dtc-line); display:inline-block; margin-right:4px }
.dtc-flow .dot.done { background:var(--dtc-ok) } .dtc-flow .dot.running { background:var(--dtc-accent); animation:dtc-blink 1.2s infinite } .dtc-flow .dot.blocked { background:#6b4fbb } .dtc-flow .dot.failed, .dtc-flow .dot.timed_out, .dtc-flow .dot.lost { background:var(--dtc-bad) }
.dtc-flow .ar { color:var(--dtc-faint); margin:0 4px }
.dtc-tcard { border-radius:10px; padding:12px 14px; border-left-width:1px }
.dtc-tcard .foot { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--dtc-faint) } .dtc-tcard .foot .dtc-btn { margin-left:auto }
.dtc-tcard .q { background:rgba(107,79,187,.12); border-radius:6px; padding:4px 8px }
.dtc-colh .cnt, .dtc-colh span:last-child { background:var(--dtc-surface); border-radius:999px; padding:0 8px; font-weight:600; color:var(--dtc-ink) }
.dtc-col { border-radius:12px }

.dtc-node .id { display:none }
.dtc-tcard .t .id { display:none }
.dtc-tcard .when { font-size:11.5px; color:var(--dtc-faint) }

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
