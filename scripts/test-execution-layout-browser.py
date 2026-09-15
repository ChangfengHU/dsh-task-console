"""Read-only real execution UI regression; optional staged assets, never fires a Task."""
import json
import os
import sqlite3
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_LAYOUT_BASE', 'https://dsh-152-32-214-95.vyibc.com')
ASSETS = os.environ.get('DTC_LAYOUT_ASSETS')
TASK = 'T-chat-b4c6fcb369f0c20a9739'
BATCH = 'b-chat-c1cfcc3f3d6db787c30e'
URL = BASE + '/?ui=execution-compact-v2#/tc/tasks/' + TASK + '/runs/' + BATCH

def read_graph():
    method = 'taskConsole/taskGraph'
    payload = dict(type='client-request', rpcId='layout-readonly', method=method,
                   payload=dict(args=dict(payload=json.dumps(dict(id=TASK, batchId=BATCH)))))
    req = urllib.request.Request('http://127.0.0.1:3080/api/' + method,
                                 data=json.dumps(payload).encode(), headers={'content-type': 'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=60))['result']
    assert result['ok']
    return json.loads(result['value'])

before = read_graph()
assert before['batch']['outcome'], 'Use an ended execution for deterministic read-only comparison'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(15000)
    errors, writes = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    reads = {'taskGraph', 'taskArtifacts', 'taskSnapshot', 'taskEvents', 'workflowCatalog', 'agents',
             'catalog', 'taskActions', 'sessionTurns', 'executionHistory', 'tasks', 'agentActions',
             'agentHistory', 'taskSchedule', 'agentActivity', 'taskPlan', 'taskPlans', 'artifactContent'}
    def guard(route):
        url = route.request.url
        method = url.split('/taskConsole/')[-1].split('?')[0]
        forbidden = '/api/taskConsole/' in url and method not in reads
        forbidden |= any(x in url for x in ['session.prompt', 'session.create', 'session.delete', 'agentPreset.select'])
        if forbidden:
            writes.append(url.split('/api/')[-1].split('?')[0]); route.abort()
        else:
            route.continue_()
    page.route('**/api/**', guard)
    if ASSETS:
        page.route('**/dsh-task-console/client-heavy.js*', lambda r: r.fulfill(
            path=str(Path(ASSETS) / 'client-heavy.js'), content_type='text/javascript'))

    def screen(label, min_canvas=60):
        geometry = page.evaluate('''() => {
          const q=s=>document.querySelector(s), box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom}};
          return {body:box(q('.dtc-body')), panel:box(q('.dtc-dag-cockpit')), canvas:box(q('.dtc-dbdag-viewport')||q('.dtc-dag-panel > .dtc-empty')), footer:box(q('.dtc-execution-evidence')),
            overflow:q('.dtc-body').scrollWidth>q('.dtc-body').clientWidth+1||q('.dtc-body').scrollHeight>q('.dtc-body').clientHeight+1,
            documentOverflow:document.documentElement.scrollHeight>innerHeight+1, width:innerWidth,height:innerHeight};
        }''')
        assert not geometry['overflow'] and not geometry['documentOverflow'], (label, geometry)
        assert geometry['footer']['b'] <= geometry['height'] + 1, (label, geometry)
        assert geometry['canvas']['h'] >= min_canvas, (label, geometry)
        assert geometry['panel']['x'] >= 0 and geometry['panel']['w'] <= geometry['width'], (label, geometry)
        page.screenshot(path='/tmp/dtc-layout-' + label + '.png', animations='disabled')
        print('PASS viewport', label, 'canvas height', round(geometry['canvas']['h']), flush=True)

    try:
        start = time.monotonic()
        page.goto(URL, wait_until='domcontentloaded', timeout=60000)
        page.locator('.dtc-compact').wait_for(timeout=60000)
        print('Real public execution ready after', round(time.monotonic()-start, 2), 'seconds', flush=True)
        expect(page.locator('.dtc-dbnode')).to_have_count(len(before['live']['tasks']))
        screen('desktop', 400)
        # Preserve the original in-place plan, all three tabs and frozen input.
        plan = page.locator('.dtc-workflow')
        plan.get_by_role('button', name='查看协作计划', exact=True).click()
        expect(plan.locator('.dtc-workflow-roles')).to_be_visible()
        screen('plan', 160)
        for name in ['本次输入', '计划 JSON', '协作计划']:
            plan.get_by_role('tab', name=name, exact=True).click()
            expect(plan.get_by_role('tab', name=name, exact=True)).to_have_attribute('aria-selected', 'true')
        # Mutually exclusive lower regions, no lost evidence components.
        nav = page.get_by_role('navigation', name='执行资料', exact=True)
        for name, selector in [('任务书与运行边界', '#dtc-evidence-brief'), ('Canonical task_events', '#dtc-evidence-events')]:
            nav.get_by_role('button', name=name).click()
            expect(page.locator(selector)).to_be_visible()
            expect(plan.locator('.dtc-workflow-body')).to_have_count(0)
            screen('evidence-' + selector.split('-')[-1], 160)
        expect(page.locator('.dtc-activity-row')).to_have_count(len(before['events']))
        page.locator('.dtc-activity-row').last.click()
        expect(page.locator('.dtc-replay-range output')).to_have_text('1')
        expect(page.locator('.dtc-dbnode')).to_have_count(1)
        nav.get_by_role('button', name='Canonical task_events').click()
        replay = page.locator('.dtc-replaybar')
        replay.get_by_role('button', name='从头', exact=True).click()
        expect(page.locator('.dtc-dbnode')).to_have_count(0)
        replay.get_by_role('button', name='→', exact=True).click()
        expect(page.locator('.dtc-dbnode')).to_have_count(1)
        page.locator('.dtc-compact-event summary').click()
        expect(page.locator('.dtc-compact-event > div')).to_be_visible()
        replay.get_by_role('button', name='▶ 播放', exact=True).click()
        expect(page.locator('.dtc-replay-range output')).not_to_have_text('1')
        replay.get_by_role('button', name='Ⅱ 暂停', exact=True).click()
        replay.get_by_role('button', name='● 回到实时', exact=True).click()
        expect(page.locator('.dtc-dbnode')).to_have_count(len(before['live']['tasks']))
        # Same right drawer, actual Creator session and role sessions, real Trace.
        page.locator('.dtc-session-trigger').click()
        drawer = page.locator('.dtc-session-drawer')
        expect(drawer.get_by_text('创建 / 编排 · 不计入执行节点', exact=True)).to_be_visible()
        drawer.get_by_role('button', name='Trace', exact=True).first.click()
        expect(drawer.locator('.dtc-ledger')).to_be_visible(timeout=60000)
        assert '?session=' in page.url
        screen('sessions-trace', 400)
        drawer.locator('.dtc-session-back').click()
        expect(drawer.locator('.dtc-session-round').first).to_be_visible()
        page.keyboard.press('Escape')
        expect(drawer).to_have_count(0)
        assert '?session=' not in page.url
        # Drawer must sit above fullscreen, and Escape closes only the top layer.
        page.get_by_role('button', name='全屏 DAG', exact=True).click()
        page.locator('.dtc-dag-head-actions').get_by_role('button', name='Sessions').click()
        assert drawer.evaluate('(e)=>{let r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+20,r.y+20))}')
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-dag-fullscreen')).to_have_count(1)
        page.locator('.dtc-dbnode').first.click()
        expect(page.locator('.dtc-dag-inspector')).to_be_visible()
        page.screenshot(path='/tmp/dtc-layout-fullscreen.png', animations='disabled')
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-dag-fullscreen')).to_have_count(0)
        # Popover remains accessible, without archiving/deleting/re-executing.
        page.get_by_role('button', name='选择执行记录', exact=True).click()
        expect(page.get_by_role('dialog', name='执行记录选择')).to_be_visible()
        page.keyboard.press('Escape')
        for w, h in [(1366,768), (1920,1080), (390,844), (390,667), (844,390)]:
            page.set_viewport_size({'width': w, 'height': h})
            screen(f'{w}x{h}', 85 if h < 500 else 150)
            plan.get_by_role('button', name='查看协作计划', exact=True).click()
            screen(f'{w}x{h}-plan', 45 if h < 500 else 60)
            plan.get_by_role('button', name='收起计划', exact=True).click()
            if w <= 800 or h < 500:
                page.get_by_role('button', name='行检查器', exact=True).click()
                expect(page.locator('.dtc-dag-inspector')).to_be_visible()
                page.get_by_role('button', name='收起行检查器', exact=True).click()
                expect(page.locator('.dtc-dag-inspector')).to_be_hidden()
            page.locator('.dtc-session-trigger').click()
            expect(drawer).to_be_visible()
            page.keyboard.press('Escape')
        page.set_viewport_size({'width':1440,'height':1000})
        page.evaluate('document.body.setAttribute("data-ds-dark-theme", "")')
        screen('dark', 400)
        page.evaluate('document.body.removeAttribute("data-ds-dark-theme")')
        # Original Open Session still uses the native session view, not a new session.
        page.locator('.dtc-session-trigger').click()
        source_id = drawer.locator('.dtc-session-row code').first.inner_text()
        drawer.get_by_role('button', name='打开 ↗', exact=True).first.click()
        page.wait_for_function('(id)=>new URL(location.href).searchParams.get("session")===id', arg=source_id)
        expect(page.locator('.dtc-overlay')).to_have_count(0)
        expect(page.locator('textarea[data-phase]').first).to_be_visible(timeout=60000)
        # Read an ended dynamic execution; never schedule or fabricate a rework round.
        with sqlite3.connect('file:/home/claude/.dsh/task-console/task.db?mode=ro', uri=True) as db:
            patrol = db.execute("SELECT spec_id,id FROM dsh_batches WHERE spec_id='T-chat-bbb714b2ba8439b69178' AND settled_at IS NOT NULL ORDER BY fired_at DESC LIMIT 1").fetchone()
        if patrol:
            page.evaluate('(p)=>location.hash="/tc/tasks/"+p[0]+"/runs/"+p[1]', list(patrol))
            page.locator('.dtc-compact').wait_for(timeout=60000)
            expect(page.locator('.dtc-dbnode.k-gate').first).to_be_visible()
            screen('dynamic-gates', 300)
            page.get_by_role('button', name='查看执行报告', exact=True).click()
            expect(page.locator('.dtc-patrol').first).to_be_visible()
            expect(page.locator('.dtc-compact')).to_be_hidden()
            page.screenshot(path='/tmp/dtc-layout-dynamic-patrol-report.png', animations='disabled')
            page.get_by_role('button', name='← 返回工作流', exact=True).click()
        # Existing multi-version HTML delivery, unchanged sandbox preview and download.
        page.evaluate('location.hash="/tc/tasks/T-mtj1xwah/runs/b-mtj1xwasjuv"')
        page.locator('.dtc-compact').wait_for(timeout=60000)
        page.get_by_role('button', name='查看执行报告', exact=True).click()
        expect(page.locator('.dtc-artifact-group').first).to_be_visible()
        page.locator('.dtc-artifact-group').first.get_by_role('button', name='预览', exact=True).click()
        expect(page.get_by_role('dialog').locator('iframe')).to_have_attribute('sandbox', 'allow-scripts')
        expect(page.get_by_role('dialog').locator('iframe')).to_be_visible()
        page.get_by_role('dialog').get_by_role('button', name='×', exact=True).click()
        with page.expect_download() as download_info:
            page.locator('.dtc-artifact-group').first.get_by_role('button', name='下载', exact=True).click()
        download = download_info.value
        assert download.failure() is None
        download.delete()
        page.screenshot(path='/tmp/dtc-layout-artifact-report.png', animations='disabled')
        assert not errors and not writes, (errors, writes)
    finally:
        browser.close()
assert read_graph() == before, 'Execution changed during a read-only UI test'
print('PASS: real DB-faithful replay, original plan/drawer/Trace, report/boundaries/events, fullscreen, six viewports, theme, no task/config/session writes.')
