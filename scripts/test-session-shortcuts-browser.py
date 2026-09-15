"""Public sidebar acceptance. Candidate mode mocks ONLY shortcut writes.

DTC_SESSION_ASSETS=/tmp/<owned-build> python3 scripts/test-session-shortcuts-browser.py
DSH_SESSION_LIVE=1 python3 scripts/test-session-shortcuts-browser.py
Live mode temporarily marks one initially unmarked existing session, then restores
both flags. No session creation, prompt, deletion, archive or Task mutation.
"""
import json
import os
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_SESSION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
ASSETS = os.environ.get('DTC_SESSION_ASSETS')
LIVE = os.environ.get('DSH_SESSION_LIVE') == '1'
assert bool(ASSETS) != LIVE, 'Select candidate assets OR explicit live marker test'
marks, writes, blocked, errors, heavy = [], [], [], [], []
fail_next = False

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(15000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: heavy.append(r.url) if '/client-heavy.js' in r.url else None)
    if ASSETS:
        page.route('**/plugins/dsh-task-console/client.js*', lambda r: r.fulfill(path=str(Path(ASSETS)/'client.js'), content_type='text/javascript'))
        page.route('**/plugins/@deepseek-ai/dsh-client-ui-workspace/client.js*', lambda r: r.fulfill(path=str(Path(ASSETS)/'workspace-client.js'), content_type='text/javascript'))
    def guard(route):
        global marks, fail_next
        request = route.request
        method = request.url.split('/api/')[-1].split('?')[0]
        if method in ['taskConsole/sessionShortcuts', 'taskConsole/setSessionShortcut']:
            if method.endswith('/setSessionShortcut'):
                q = json.loads(request.post_data_json['payload']['args']['payload'])
                writes.append(q)
                if not LIVE:
                    if fail_next:
                        fail_next = False
                        route.fulfill(status=503, body='temporary test failure'); return
                    row = next((m for m in marks if m['sessionId'] == q['sessionId']), None)
                    if row is None:
                        row = {'sessionId': q['sessionId'], 'pinned': False, 'favorite': False, 'pinnedAt': 0, 'favoriteAt': 0}; marks.append(row)
                    row[q['kind']] = q['value']
                    row['pinnedAt' if q['kind'] == 'pinned' else 'favoriteAt'] = int(time.time()*1000) if q['value'] else 0
                    marks = [m for m in marks if m['pinned'] or m['favorite']]
            if LIVE: route.continue_()
            else: route.fulfill(json={'result': {'ok': True, 'value': json.dumps(marks)}})
        elif any(x in method for x in ['session.prompt', 'session.create', 'session.delete', 'session.archive', 'workspace.delete']) or (method.startswith('taskConsole/') and method.split('/')[-1] not in ['catalog', 'agents', 'tasks', 'sessionTurns']):
            blocked.append(method); route.abort()
        else: route.continue_()
    page.route('**/api/**', guard)
    target = None
    def show_sidebar():
        page.wait_for_timeout(400)
        toggle = page.get_by_role('button', name='Open sidebar', exact=True)
        if toggle.is_visible(): toggle.click()
        expect(page.locator('.dtc-session-shortcuts')).to_be_visible()
    try:
        t = time.time()
        page.goto(BASE + '/?ui=session-shortcuts', wait_until='domcontentloaded')
        expect(page.locator('.dtc-session-shortcuts')).to_be_visible(timeout=90000)
        page.wait_for_function('window.__DSHSessionShortcuts__?.getSnapshot().ready', timeout=30000)
        print('ready_seconds', round(time.time()-t, 2), flush=True)
        assert not heavy, 'Session module must not load Board/Trace heavy bundle'
        assert page.locator('.dtc-session-error').count() == 0
        # Use the native menu on an existing, initially unmarked row.
        buttons = page.locator('button[aria-label^="Session actions for "]')
        expect(buttons.first).to_be_attached()
        selected = None
        for i in range(buttons.count()):
            candidate = buttons.nth(i)
            candidate.locator('xpath=ancestor::*[@role="treeitem"][1]').hover()
            candidate.click()
            if page.get_by_text('Pin session', exact=True).count() and page.get_by_text('Add to Favorites', exact=True).count():
                selected = i; break
            page.keyboard.press('Escape')
        assert selected is not None, 'No initially unmarked visible test session'
        page.get_by_text('Pin session', exact=True).click()
        page.wait_for_function('window.__DSHSessionShortcuts__.getSnapshot().pending.size===0')
        target = writes[-1]['sessionId']
        expect(page.locator(f'.dtc-session-pinned [data-session-shortcut="{target}"]')).to_be_visible()
        candidate = buttons.nth(selected)
        candidate.locator('xpath=ancestor::*[@role="treeitem"][1]').hover(); candidate.click()
        expect(page.get_by_text('Unpin session', exact=True)).to_be_visible()
        page.get_by_text('Add to Favorites', exact=True).click()
        expect(page.locator(f'[data-session-shortcut="{target}"]')).to_have_count(2)
        assert page.locator(f'[data-session-shortcut="{target}"] .dtc-session-open').first.inner_text() != target, 'Use native display title'
        page.screenshot(path='/tmp/session-shortcuts-' + ('live' if LIVE else 'candidate') + '-1440.png')
        # Reload must restore both groups from backend metadata, not tab storage.
        page.reload(wait_until='domcontentloaded')
        expect(page.locator(f'[data-session-shortcut="{target}"]')).to_have_count(2, timeout=90000)
        assert not heavy
        section = page.locator('.dtc-session-shortcuts')
        folder = section.get_by_role('button', name='Favorites', exact=False)
        folder.click(); expect(folder).to_have_attribute('aria-expanded', 'false')
        expect(page.locator(f'.dtc-session-pinned [data-session-shortcut="{target}"]')).to_be_visible()
        folder.click()
        for width in [390, 1440]:
            page.set_viewport_size({'width': width, 'height': 844 if width == 390 else 1000})
            show_sidebar()
            page.wait_for_timeout(350)  # Native sidebar width transition, not network readiness.
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'horizontal overflow'
            page.screenshot(path=f'/tmp/session-shortcuts-{"live" if LIVE else "candidate"}-{width}.png')
        page.emulate_media(color_scheme='dark')
        page.wait_for_timeout(250)
        show_sidebar()
        page.screenshot(path='/tmp/session-shortcuts-dark.png')
        page.emulate_media(color_scheme='light')
        show_sidebar()
        # Open only the existing session; never send a prompt.
        page.locator(f'.dtc-session-pinned [data-session-shortcut="{target}"] .dtc-session-open').click()
        expect(page).to_have_url(__import__('re').compile(r'[?&]session=' + target))
        if not LIVE:
            fail_next = True
            page.locator(f'.dtc-session-pinned [data-session-shortcut="{target}"] .dtc-session-remove').click()
            expect(page.locator('.dtc-session-error')).to_be_visible()
            expect(page.locator(f'[data-session-shortcut="{target}"]')).to_have_count(2)
            page.locator('.dtc-session-error button').click()
            expect(page.locator('.dtc-session-error')).to_have_count(0)
        page.locator(f'.dtc-session-pinned [data-session-shortcut="{target}"]').hover()
        page.locator(f'.dtc-session-pinned [data-session-shortcut="{target}"] .dtc-session-remove').click()
        expect(page.locator(f'[data-session-shortcut="{target}"]')).to_have_count(1)
        page.locator(f'[data-session-shortcut="{target}"] .dtc-session-remove').click()
        expect(page.locator(f'[data-session-shortcut="{target}"]')).to_have_count(0)
        assert not errors, errors
        assert not blocked, blocked
        print(json.dumps({'passed': True, 'mode': 'live' if LIVE else 'candidate', 'target': target, 'markerWrites': len(writes), 'businessWrites': len(blocked), 'errors': errors}), flush=True)
    finally:
        # Exact initially-unmarked session only; no histories or native folders touched.
        if LIVE and target:
            page.evaluate('''async id=>{const s=window.__DSHSessionShortcuts__;if(!s)return;await s.set(id,'pinned',false);await s.set(id,'favorite',false)}''', target)
        browser.close()
