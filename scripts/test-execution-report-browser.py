"""Separate report route/back state and layered Escape, using read-only production data."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_LAYOUT_BASE', 'https://dsh-152-32-214-95.vyibc.com')
ASSETS = os.environ.get('DTC_LAYOUT_ASSETS')
TASK = 'T-chat-b4c6fcb369f0c20a9739'
BATCH = 'b-chat-c1cfcc3f3d6db787c30e'
SESSION = 'agent-task-create-agent-mu11mkww'
RUN = '/tc/tasks/' + TASK + '/runs/' + BATCH
URL = BASE + '/?ui=report-escape&session=' + SESSION + '#' + RUN

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    page.set_default_timeout(15000)
    errors, writes = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    allowed = {'taskGraph','taskArtifacts','taskSnapshot','taskEvents','workflowCatalog','agents','catalog',
               'taskActions','sessionTurns','tasks','agentActions','agentHistory','agentActivity',
               'taskSchedule','executionHistory','artifactContent'}
    def guard(route):
        url = route.request.url
        method = url.split('/taskConsole/')[-1].split('?')[0]
        if ('/api/taskConsole/' in url and method not in allowed) or any(x in url for x in ['session.prompt','session.create','session.delete','agentPreset.select']):
            writes.append(url.split('/api/')[-1].split('?')[0]); route.abort()
        else: route.continue_()
    page.route('**/api/**', guard)
    if ASSETS:
        page.route('**/dsh-task-console/client-heavy.js*', lambda r: r.fulfill(path=str(Path(ASSETS)/'client-heavy.js'), content_type='text/javascript'))
    def report_screen(label):
        expect(page.locator('.dtc-execution-report')).to_be_visible()
        expect(page.locator('.dtc-compact')).to_be_hidden()
        assert page.locator('.dtc-body').evaluate('(e)=>e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1')
        assert page.locator('.dtc-report-body').evaluate('(e)=>e.getBoundingClientRect().bottom<=innerHeight+1')
        page.screenshot(path='/tmp/dtc-report-' + label + '.png', animations='disabled')
    try:
        # Start at the short Task URL too; navigating to /runs/:id/report must not remount its DAG.
        page.goto(BASE + '/?ui=report-escape&session=' + SESSION + '#/tc/tasks/' + TASK, wait_until='domcontentloaded', timeout=60000)
        page.locator('.dtc-compact').wait_for(timeout=60000)
        # Use the known ended Batch for deterministic replay.
        page.evaluate('(r)=>location.hash=r', RUN)
        expect(page.locator('.dtc-compact')).to_be_visible()
        range_input = page.locator('.dtc-replay-range input')
        range_input.press('Home')
        for _ in range(5): range_input.press('ArrowRight')
        expect(page.locator('.dtc-replay-range output')).to_have_text('5')
        for _ in range(5): page.get_by_role('button', name='放大 DAG', exact=True).click()
        page.locator('.dtc-dbdag-viewport').evaluate('(e)=>{e.scrollLeft=120;e.scrollTop=30}')
        state = page.evaluate('''()=>{window.__reportCanvas=document.querySelector('.dtc-dbdag-viewport');return {left:__reportCanvas.scrollLeft,top:__reportCanvas.scrollTop,zoom:document.querySelector('.dtc-dbdag-tools b').textContent,selected:document.querySelector('.dtc-dbnode.selected')?.textContent}}''')
        page.get_by_role('button', name='查看执行报告', exact=True).click()
        expect(page).to_have_url(URL + '/report')
        expect(page.locator('.dtc-report-snapshot')).to_contain_text('第 5 步')
        report_screen('historical')
        page.get_by_role('button', name='← 返回工作流', exact=True).click()
        expect(page.locator('.dtc-replay-range output')).to_have_text('5')
        assert page.evaluate('window.__reportCanvas===document.querySelector(".dtc-dbdag-viewport")')
        after = page.evaluate('''()=>({left:__reportCanvas.scrollLeft,top:__reportCanvas.scrollTop,zoom:document.querySelector('.dtc-dbdag-tools b').textContent,selected:document.querySelector('.dtc-dbnode.selected')?.textContent})''')
        assert state == after, (state, after)
        page.locator('.dtc-replaybar').get_by_role('button', name='● 回到实时', exact=True).click()
        page.get_by_role('navigation', name='Task 导航').get_by_role('button', name='执行报告', exact=True).click()
        assert page.locator('.dtc-report-body .dtc-hand').first.evaluate('(e)=>e.scrollHeight<=e.clientHeight+1'), 'Report text uses the report page scroll, not a small nested box'
        report_screen('desktop')
        for w,h in [(390,844),(390,667),(844,390)]:
            page.set_viewport_size({'width':w,'height':h}); report_screen(f'{w}x{h}')
        page.reload(wait_until='domcontentloaded')
        page.locator('.dtc-execution-report').wait_for(timeout=60000)
        report_screen('direct-reload')
        page.get_by_role('button', name='← 返回工作流', exact=True).click()
        page.set_viewport_size({'width':1440,'height':1000})
        # Picker -> fullscreen -> drawer each consumes only its own Escape.
        page.get_by_role('button', name='选择执行记录', exact=True).click()
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-execution-popover')).to_have_count(0)
        expect(page.locator('.dtc-overlay')).to_be_visible()
        page.get_by_role('button', name='全屏 DAG', exact=True).click()
        page.locator('.dtc-dag-head-actions').get_by_role('button', name='Sessions').click()
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-session-drawer')).to_have_count(0)
        expect(page.locator('.dtc-dag-fullscreen')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-dag-fullscreen')).to_have_count(0)
        expect(page.locator('.dtc-overlay')).to_be_visible()
        page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,isComposing:true}))')
        expect(page.locator('.dtc-overlay')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-overlay')).to_have_count(0)
        assert 'session=' + SESSION in page.url and '#/tc' not in page.url
        # Agent and Board close even with an input focused; no config is saved.
        for path in ['/tc/agents', '/tc/tasks']:
            page.evaluate('(r)=>location.hash=r', path)
            page.locator('.dtc-overlay').wait_for(timeout=60000)
            if path.endswith('agents'):
                page.locator('.dtc-agents input').first.wait_for(timeout=60000)
                page.locator('.dtc-agents input').first.focus()
            else:
                page.get_by_role('button', name='管理任务', exact=True).wait_for(timeout=60000)
                page.get_by_role('button', name='管理任务', exact=True).click()
                expect(page.get_by_role('dialog')).to_be_visible()
                page.keyboard.press('Escape')
                expect(page.get_by_role('dialog')).to_have_count(0)
                expect(page.locator('.dtc-overlay')).to_be_visible()
            page.keyboard.press('Escape')
            expect(page.locator('.dtc-overlay')).to_have_count(0)
        # Artifact Escape closes preview, not the independent report page.
        page.evaluate('location.hash="/tc/tasks/T-mtj1xwah/runs/b-mtj1xwasjuv/report"')
        page.locator('.dtc-artifact-group').first.wait_for(timeout=60000)
        page.locator('.dtc-artifact-group').first.get_by_role('button',name='预览',exact=True).click()
        expect(page.locator('.dtc-art-modal')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-art-modal')).to_have_count(0)
        expect(page.locator('.dtc-execution-report')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('.dtc-overlay')).to_have_count(0)
        assert not errors and not writes, (errors,writes)
        print('PASS: independent/deep-link report, back preserves DAG/zoom/pan/cursor, responsive report, layered Escape, Agent/Board dismissal, no mutation calls.', flush=True)
    finally:
        browser.close()
