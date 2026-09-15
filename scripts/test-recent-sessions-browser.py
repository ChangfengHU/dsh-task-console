"""Read-only Recent and alias deep-link acceptance; never sends a prompt."""
import json
import time
from playwright.sync_api import sync_playwright, expect

SID = 'agent-task-create-agent-mu25ngup'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    for host in ['dsh-152-32-214-95.vyibc.com', 'dsh.vyibc.com']:
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors, blocked, sockets = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('websocket', lambda ws: sockets.append(ws.url))
        def guard(route):
            method = route.request.url.split('/api/')[-1].split('?')[0]
            if any(x in method for x in ['session.create', 'session.prompt', 'session.cancel', 'session.delete', 'session.archive', 'setSessionShortcut', 'fireTask', 'launchWorkflow']):
                blocked.append(method); route.abort()
            else:
                route.continue_()
        page.route('**/api/**', guard)
        started = time.time()
        page.goto('https://' + host + '/?v=0.30.30&session=' + SID, wait_until='domcontentloaded')
        recent = page.get_by_role('button', name='Recent sessions', exact=True)
        expect(recent).to_be_visible(timeout=90000)
        rows = page.locator('[data-session-recent]')
        expect(rows.first).to_be_visible(timeout=30000)
        assert rows.count() <= 10
        expect(page.get_by_text('Loading history…', exact=True)).not_to_be_visible(timeout=90000)
        assert 'session=' + SID in page.url
        assert not page.get_by_text('Failed to load history:', exact=False).count()
        recent.click(); expect(rows).to_have_count(0)
        recent.click(); expect(rows.first).to_be_visible()
        more = page.get_by_role('button', name='Show more', exact=True)
        if more.count():
            before = rows.count(); more.click(); assert rows.count() > before
            page.get_by_role('button', name='Show less', exact=True).click()
            assert rows.count() <= 10
        selected = rows.first.get_attribute('data-session-recent')
        rows.first.locator('.dtc-session-open').click()
        page.wait_for_function('(id) => new URL(location.href).searchParams.get("session") === id', arg=selected)
        expect(rows.first).to_have_class('dtc-session-row selected')
        # Deep links survive reload on each domain; no conversation copy is made.
        page.reload(wait_until='domcontentloaded')
        expect(page.get_by_role('button', name='Recent sessions', exact=True)).to_be_visible(timeout=90000)
        assert 'session=' + selected in page.url
        for width in [1440, 390]:
            page.set_viewport_size({'width': width, 'height': 1000})
            toggle = page.get_by_role('button', name='Open sidebar', exact=True)
            if toggle.count() and toggle.is_visible(): toggle.click()
            page.screenshot(path='/tmp/dsh-recent-' + host + '-' + str(width) + '.png')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2')
        assert not errors and all(m == 'session.create' for m in blocked), {'errors': errors, 'blocked': blocked}
        assert sockets, 'native event WebSocket must be attempted'
        print(json.dumps({'host': host, 'seconds': round(time.time()-started, 2), 'pageErrors': 0, 'businessWrites': 0, 'blockedNativeBlankCreates': len(blocked), 'webSockets': len(sockets), 'deepLink': True}), flush=True)
        page.close()
    browser.close()
