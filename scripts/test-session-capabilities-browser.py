"""Read-only public UI acceptance, candidate assets optional. Never starts an Agent."""
import json
import os
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

SID = os.environ.get('DTC_CAPABILITY_SESSION', 'session-d50d2a71-bed9-4b2f-bf1c-10de47e8c14a')
ASSETS = os.environ.get('DTC_BUILD_OUT')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, blocked, reads = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    if ASSETS:
        page.route('**/plugins/dsh-task-console/client.js*', lambda r: r.fulfill(path=str(Path(ASSETS)/'client.js'), content_type='text/javascript'))
    def guard(route):
        method = route.request.url.split('/api/')[-1].split('?')[0]
        if method == 'taskConsole/sessionCapabilities':
            reads.append(method)
            if ASSETS:
                route.fulfill(json={'result': {'ok': True, 'value': json.dumps({'sessionId': SID, 'live': True, 'checkedAt': '2026-09-15T09:00:00Z', 'definition': {'role': 'standard', 'authored': False}, 'current': {'tools': [{'name': 'read_file', 'source': 'environment-inherited', 'state': 'registered'}, {'name': 'mcp__fleet-browser__browser_create', 'source': 'environment-inherited', 'state': 'restricted'}], 'skills': [{'name': 'example', 'source': 'environment-inherited', 'state': 'available-on-demand'}]}, 'lastModelRequest': {'checkedAt': '2026-09-15T09:00:00Z', 'provider': 'fixture', 'model': 'fixture', 'tools': ['read_file']}})}})
                return
        if any(x in method for x in ['session.prompt', 'session.create', 'session.cancel', 'session.archive', 'session.delete', 'setSession', 'saveAgent', 'fireTask', 'launchWorkflow']):
            blocked.append(method); route.abort(); return
        route.continue_()
    page.route('**/api/**', guard)
    start = time.time()
    page.goto('https://dsh-152-32-214-95.vyibc.com/?v=0.30.29&session='+SID, wait_until='domcontentloaded')
    tab = page.get_by_text('Capabilities', exact=True)
    expect(tab).to_be_visible(timeout=60000)
    tab.click()
    panel = page.get_by_role('region', name='Session capabilities')
    expect(panel).to_be_visible(timeout=15000)
    expect(panel.get_by_text('当前会话能力', exact=False).first).to_be_visible()
    expect(panel.get_by_text('实际工具与环境继承')).to_be_visible()
    if ASSETS:
        expect(panel.get_by_text('可用工具', exact=True)).to_be_visible()
        expect(panel.get_by_text('mcp__fleet-browser__browser_create', exact=True)).to_be_visible()
        expect(panel.get_by_text('环境继承 · 受限 · 不可调用', exact=True)).to_be_visible()
    elif os.environ.get('DTC_EXPECT_INHERITANCE'):
        panel.get_by_text('通用 Agent：默认继承 · 显式排除', exact=True).click()
        expect(panel.get_by_text('排除 Skill：无', exact=True)).to_be_visible()
        expect(panel.get_by_text('排除 MCP：无', exact=True)).to_be_visible()
        expect(panel.get_by_text('排除工具：无', exact=True)).to_be_visible()
    panel.get_by_role('button', name='刷新', exact=True).click()
    expect(panel.get_by_text('实际工具与环境继承')).to_be_visible()
    for width in [1440, 390]:
        if width == 390:
            close = page.get_by_role('button', name='Close sidebar', exact=True)
            if close.count() and close.is_visible(): close.click()
        page.set_viewport_size({'width': width, 'height': 1000})
        page.wait_for_timeout(400)
        if os.environ.get('DTC_CAPTURE'):
            page.screenshot(path='/tmp/dsh-capabilities-'+('candidate' if ASSETS else 'live')+'-'+str(width)+'.png')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'), 'horizontal overflow'
        if width == 390: assert panel.bounding_box()['width'] >= 280, 'close native sidebar before narrow-panel acceptance'
    # Native workspace initialization may request a blank session. It remains
    # aborted; the panel must work without it. Every other mutation is unexpected.
    assert reads and not errors and all(m == 'session.create' for m in blocked), {'reads': len(reads), 'errors': errors, 'blocked': blocked}
    print(json.dumps({'readySeconds': round(time.time()-start, 2), 'capabilityReads': len(reads), 'pageErrors': len(errors), 'businessWrites': 0, 'blockedNativeBlankCreates': len(blocked), 'mode': 'candidate' if ASSETS else 'live'}))
    browser.close()
