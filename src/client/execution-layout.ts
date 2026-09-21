/** V2: compact only the real database execution view; other pages keep scrolling. */
export const executionLayout = `
.dtc-overlay:has(.dtc-compact) { height:100dvh; overflow:hidden }
.dtc-overlay:has(.dtc-compact) > .dtc-head { height:44px; min-height:44px; padding:0 14px; flex-wrap:nowrap }
.dtc-overlay:has(.dtc-compact) .dtc-brand small,.dtc-overlay:has(.dtc-compact) .dtc-head-context { display:none }
.dtc-overlay:has(.dtc-compact) .dtc-brand { min-width:0 }
.dtc-overlay:has(.dtc-compact) .dtc-brand .ic { width:24px; height:24px; background:transparent; color:var(--dtc-muted) }
.dtc-overlay:has(.dtc-compact) .dtc-action-toolbar { margin:0; flex-wrap:nowrap; gap:4px }
.dtc-body:has(> .dtc-execution-view) { display:flex; flex-direction:column; min-height:0; padding:10px 14px; overflow:hidden }
.dtc-execution-view { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0 }
.dtc-compact[hidden] { display:none }
.dtc-execution-report { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; gap:10px }
.dtc-execution-report > header { display:flex; align-items:center; gap:16px; padding:12px; border:1px solid var(--dtc-line); border-radius:10px; background:var(--dtc-surface); flex-shrink:0 }
.dtc-execution-report > header > div { min-width:0 }
.dtc-execution-report h1 { font-size:16px; margin:2px 0; overflow-wrap:anywhere }
.dtc-execution-report header span,.dtc-execution-report header small { font-size:11px; color:var(--dtc-muted) }
.dtc-report-body { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain }
.dtc-report-body > .dtc-delivery { margin:0 0 12px }
.dtc-report-body .dtc-hand { max-height:none; overflow:visible }
.dtc-report-body .dtc-delivery-head > div > span { color:var(--dtc-accent) }
.dtc-report-snapshot { padding:10px 12px; margin:0 0 10px; border-radius:8px; color:var(--dtc-warn); background:var(--dtc-warn-bg); font-size:12px }
@media(max-width:700px) { .dtc-execution-report > header { align-items:flex-start; flex-direction:column; gap:8px }.dtc-execution-report h1 { font-size:14px } }
.dtc-compact { display:flex; flex:1; flex-direction:column; gap:8px; min-height:0; min-width:0; max-width:none; margin:0; padding:0 }
.dtc-compact > * { flex-shrink:0; min-width:0 }
.dtc-compact > .dtc-cartoon-head { min-height:0; padding:10px 12px; gap:8px; margin:0; border-radius:10px; box-shadow:none; flex-wrap:wrap }
.dtc-compact .dtc-cartoon-title { flex:1 1 320px; min-width:0 }
.dtc-compact .dtc-cartoon-title > span { display:none }
.dtc-compact .dtc-cartoon-title h1 { font-size:16px; line-height:1.4; margin:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
.dtc-compact .dtc-cartoon-title small { font-size:10px; margin-top:3px }
.dtc-compact .dtc-cartoon-back { flex:none; width:28px; height:28px; border-radius:7px }
.dtc-compact .dtc-cartoon-actions { width:auto; margin:0; gap:5px; flex-wrap:wrap; min-width:0 }
.dtc-compact .dtc-cartoon-actions .dtc-btn { flex:none }
.dtc-compact .dtc-btn { min-height:28px; padding:4px 9px; font-size:11px; white-space:nowrap }
.dtc-compact .dtc-cartoon-live { font-size:10px; padding:4px 7px; white-space:nowrap }
.dtc-compact > p[role=status],.dtc-compact > .dtc-err { margin:0; max-height:64px; overflow:auto; font-size:12px }
.dtc-compact .dtc-workflow { margin:0; border-radius:9px }
.dtc-compact .dtc-workflow > header { padding:6px 10px; gap:6px 12px; align-items:center }
.dtc-compact .dtc-workflow > header > div:first-child { display:flex; align-items:center; gap:12px; min-width:0 }
.dtc-compact .dtc-workflow > header b { white-space:nowrap; font-size:12px }
.dtc-compact .dtc-workflow > header small { font-size:11px }
.dtc-compact .dtc-workflow-actions { width:auto; margin-left:auto }
.dtc-compact .dtc-workflow-body { max-height:min(305px,30dvh); overflow:auto; overscroll-behavior:contain }
.dtc-compact .dtc-workflow-body > nav { position:sticky; top:0; z-index:1; background:var(--dtc-surface) }
.dtc-compact .dtc-workflow-body pre { max-height:none }
.dtc-compact > .dtc-dag-cockpit { flex:1 1 0; min-height:0; grid-template-columns:minmax(0,1fr) 310px; gap:8px; align-items:stretch; margin:0 }
.dtc-compact .dtc-cpanel { min-height:0; margin:0; border-radius:10px; box-shadow:none }
.dtc-compact .dtc-dag-panel { display:flex; flex-direction:column; min-height:0; overflow:hidden }
.dtc-compact .dtc-cpanel-head { min-height:48px; padding:7px 10px; flex-shrink:0 }
.dtc-compact .dtc-dag-panel > .dtc-cpanel-head > div:first-child { min-width:0 }
.dtc-compact .dtc-dag-panel > .dtc-cpanel-head b { font-size:14px }
.dtc-compact .dtc-cpanel-head small { font-size:10px; overflow-wrap:anywhere }
.dtc-compact .dtc-dag-head-actions { flex-shrink:0; gap:5px }
.dtc-compact .dtc-dbdag-scroll { flex:1; min-height:0 }
.dtc-compact .dtc-dbdag-viewport { min-height:0; padding:8px }
.dtc-compact .dtc-dbdag-tools { min-height:34px; padding:3px 10px; flex-direction:row; align-items:center }
.dtc-compact .dtc-dbdag-tools > div { width:auto }
.dtc-compact .dtc-dag-panel > .dtc-empty { flex:1; min-height:0; padding:12px; overflow:auto }
.dtc-compact .dtc-dag-inspector { position:relative; top:auto; height:auto; max-height:none; overflow:auto; overscroll-behavior:contain }
.dtc-compact .dtc-dag-inspector > .dtc-cpanel-head { position:sticky; top:0; background:var(--dtc-surface); z-index:1 }
.dtc-compact .dtc-dbinspect { padding:10px }
.dtc-compact .dtc-inspector-toggle,.dtc-compact .dtc-inspector-close { display:none }
.dtc-compact .dtc-compact-event { flex:none; border-bottom:1px solid var(--dtc-line-soft); background:var(--dtc-surface-2); font-size:11px }
.dtc-compact-event > summary { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; list-style:none; animation:dtc-event-in .28s ease-out }
.dtc-compact-event > summary::-webkit-details-marker { display:none }
.dtc-compact-event > summary > span { color:var(--dtc-accent); font-size:15px; line-height:1 }
.dtc-compact-event > summary b { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600 }
.dtc-compact-event > summary small { flex:none; font-size:10px; color:var(--dtc-muted) }
.dtc-compact-event > summary em { margin-left:auto; color:var(--dtc-muted); font-size:10px; font-style:normal; flex:none }
.dtc-compact-event > div { max-height:100px; overflow:auto; padding:0 10px 8px; overscroll-behavior:contain }
.dtc-compact-event p,.dtc-compact-event dl { margin:4px 0 }
.dtc-compact-event dl > div { display:flex; gap:8px }
.dtc-compact-event dt { flex:none; color:var(--dtc-muted) }
.dtc-compact-event dd { margin:0; overflow-wrap:anywhere }
.dtc-compact .dtc-replaybar { flex:none; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; padding:6px 10px; margin:0; border:0; border-top:1px solid var(--dtc-line); border-radius:0; box-shadow:none }
.dtc-compact .dtc-replay-now { grid-column:1; grid-template-columns:auto auto minmax(0,1fr); gap:5px }
.dtc-compact .dtc-replay-now small { grid-column:auto }
.dtc-compact .dtc-replay-actions { grid-column:2; display:flex }
.dtc-compact .dtc-replay-range { grid-column:1; grid-template-columns:auto minmax(0,1fr) 28px }
.dtc-compact .dtc-replay-range input { min-width:0; padding:0 }
.dtc-compact .dtc-replay-tail { grid-column:2 }
.dtc-compact .dtc-replaybar button { min-height:27px }
.dtc-compact .dtc-replay-tail select { min-height:27px }
.dtc-compact .dtc-execution-evidence { border:1px solid var(--dtc-line); border-radius:9px; background:var(--dtc-surface); overflow:hidden }
.dtc-execution-evidence > nav { display:flex; gap:4px; padding:3px 6px; overflow:auto }
.dtc-execution-evidence > nav button { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:6px; white-space:nowrap; font-size:11px; color:var(--dtc-muted) }
.dtc-execution-evidence > nav button[aria-expanded=true] { background:var(--dtc-accent-bg); color:var(--dtc-accent) }
.dtc-execution-evidence > nav small { font-size:10px; font-variant-numeric:tabular-nums }
.dtc-evidence-content { max-height:30dvh; padding:10px; overflow:auto; border-top:1px solid var(--dtc-line-soft); overscroll-behavior:contain }
.dtc-evidence-content[hidden] { display:none }
.dtc-compact .dtc-evidence-content .dtc-activity-list { max-height:none; overflow:visible }
.dtc-compact .dtc-evidence-content > .dtc-delivery { margin:0 }
.dtc-compact .dtc-evidence-content > .dtc-patrol { margin-top:8px }
.dtc-compact .dtc-evidence-content > p { font-size:11px; margin:0 0 6px }
.dtc-compact .dtc-dag-fullscreen { z-index:80; inset:8px; grid-template-columns:minmax(0,1fr) 310px }
@media (max-width:1100px) {
  .dtc-compact > .dtc-cartoon-head { gap:6px; padding:8px 10px }
  .dtc-compact .dtc-cartoon-actions { margin-left:auto }
  .dtc-compact .dtc-cartoon-title { flex-basis:calc(100% - 170px) }
  .dtc-compact .dtc-cartoon-title h1 { font-size:14px }
  .dtc-compact > .dtc-dag-cockpit { grid-template-columns:minmax(0,1fr) 280px }
}
@media (max-width:800px) {
  .dtc-body:has(> .dtc-execution-view) { padding:6px; gap:6px }
  .dtc-compact { gap:6px }
  .dtc-compact .dtc-cartoon-title { flex-basis:calc(100% - 40px) }
  .dtc-compact .dtc-cartoon-live { display:none }
  .dtc-compact .dtc-cartoon-actions { flex:1 0 100%; gap:4px; margin:0 }
  .dtc-compact .dtc-execution-picker { flex:1; min-width:0 }
  .dtc-compact .dtc-execution-select { min-width:0; flex:1 }
  .dtc-compact .dtc-execution-select > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .dtc-compact .dtc-cartoon-actions .dtc-btn { padding:4px 6px }
  .dtc-compact .dtc-workflow > header > div:first-child { gap:6px }
  .dtc-compact .dtc-workflow > header small { max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .dtc-compact .dtc-workflow-actions .dtc-btn { flex:none }
  .dtc-compact > .dtc-dag-cockpit { grid-template-columns:minmax(0,1fr) }
  .dtc-compact .dtc-dag-inspector { display:none }
  .dtc-compact .dtc-inspector-toggle { display:block }
  .dtc-compact .inspector-open .dtc-dag-inspector { display:block; position:fixed; inset:auto 6px 6px; height:65dvh; max-height:65dvh; z-index:85; border-color:var(--dtc-accent); box-shadow:0 -8px 32px #0003 }
  .dtc-compact .dtc-inspector-close { display:grid; position:sticky; top:7px; float:right; margin:7px; z-index:2; background:var(--dtc-surface) }
  .dtc-compact .dtc-replay-now { grid-column:1/-1 }
  .dtc-compact .dtc-replay-actions { grid-column:1; grid-row:2 }
  .dtc-compact .dtc-replay-tail { grid-column:2; grid-row:2; gap:4px }
  .dtc-compact .dtc-replay-range { grid-column:1/-1 }
  .dtc-compact .dtc-replaybar { padding:5px 7px; gap:3px }
  .dtc-compact .dtc-replaybar button { padding:0 5px }
  .dtc-compact .dtc-replaybar .play { min-width:65px }
  .dtc-compact .dtc-cpanel-head { padding:6px 8px; gap:4px }
  .dtc-compact .dtc-dag-head-actions { gap:3px }
  .dtc-compact .dtc-dag-head-actions .dtc-btn { padding:4px 5px }
  .dtc-compact .dtc-dbdag-tools > span { font-size:9px }
  .dtc-execution-evidence > nav { gap:0; padding:3px }
  .dtc-execution-evidence > nav button { padding:6px; gap:4px; font-size:10px }
  .dtc-execution-evidence > nav small { display:none }
  .dtc-compact .dtc-workflow-body,.dtc-evidence-content { max-height:min(23dvh,max(64px,calc(100dvh - 595px))) }
}
@media (max-height:500px) {
  .dtc-overlay:has(.dtc-compact) > .dtc-head { height:34px; min-height:34px }
  .dtc-body:has(> .dtc-execution-view) { padding:4px 6px }
  .dtc-compact { gap:4px }
  .dtc-compact > .dtc-cartoon-head { padding:3px 6px; height:38px; overflow:auto; flex-wrap:nowrap }
  .dtc-compact .dtc-cartoon-title { flex:1 0 150px }
  .dtc-compact .dtc-cartoon-title h1 { max-width:220px; font-size:12px }
  .dtc-compact .dtc-cartoon-title small { max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:8px; margin:0 }
  .dtc-compact .dtc-cartoon-actions { flex-wrap:nowrap; flex:none }
  .dtc-compact .dtc-delivery-wait { display:none }
  .dtc-compact .dtc-workflow > header { padding:3px 8px; flex-wrap:nowrap }
  .dtc-compact .dtc-workflow > header small { max-width:160px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
  .dtc-compact .dtc-workflow-actions { flex-wrap:nowrap }
  .dtc-compact .dtc-workflow-body,.dtc-evidence-content { max-height:18dvh }
  .dtc-compact .dtc-cpanel-head { min-height:32px; padding:3px 8px }
  .dtc-compact .dtc-dag-panel > .dtc-cpanel-head > div:first-child { display:flex; align-items:center; gap:8px }
  .dtc-compact .dtc-dag-panel > .dtc-cpanel-head b { font-size:12px; white-space:nowrap }
  .dtc-compact .dtc-dag-panel > .dtc-cpanel-head small { font-size:9px; margin:0 }
  .dtc-compact > .dtc-dag-cockpit { grid-template-columns:minmax(0,1fr) }
  .dtc-compact .dtc-dag-inspector { display:none }
  .dtc-compact .dtc-inspector-toggle { display:block }
  .dtc-compact .inspector-open .dtc-dag-inspector { display:block; position:fixed; inset:6px 6px 6px auto; width:min(330px,94vw); height:auto; max-height:none; z-index:85; box-shadow:0 0 32px #0003 }
  .dtc-compact .dtc-inspector-close { display:grid; position:sticky; top:7px; float:right; margin:7px; z-index:2; background:var(--dtc-surface) }
  .dtc-compact-event > summary { padding:3px 8px }
  .dtc-compact-event > div { max-height:50px }
  .dtc-compact .dtc-dbdag-scroll { position:relative }
  .dtc-compact .dtc-dbdag-tools { position:absolute; z-index:3; top:0; right:0; min-height:28px; padding:1px 8px; border-left:1px solid var(--dtc-line); border-radius:0 0 0 6px }
  .dtc-compact .dtc-dbdag-tools > span { display:none }
  .dtc-compact .dtc-replaybar { display:flex; flex-wrap:nowrap; align-items:center; padding:3px 8px; gap:8px }
  .dtc-compact .dtc-replay-range { flex:1 }
  .dtc-compact .dtc-replay-now small,.dtc-compact .dtc-replay-range > span { display:none }
  .dtc-compact .dtc-replay-range { grid-template-columns:minmax(0,1fr) 28px }
  .dtc-execution-evidence > nav button { padding:3px 8px }
}
`
