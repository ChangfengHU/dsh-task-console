"""Native hero role confirmation, draft only. All business writes are blocked."""
import json
import os
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
RPC = os.environ.get('DSH_ACTION_RPC', 'http://127.0.0.1:3080')
SESSION = 'agent-browser-manager-mtyjlqdd'  # Existing blank acceptance record.


def native_list():
    body = {'type': 'client-request', 'rpcId': 'action-native-role', 'method': 'session.list', 'payload': {}}
    req = urllib.request.Request(RPC + '/api/session.list', data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=30))['result']
    assert result['ok']
    return result['value']['items']


before = next(s for s in native_list() if s['sessionId'] == SESSION)
assert before['blank'] and not before['running'] and before['agentPreset'] == 'browser-manager'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, writes = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))

    def guard(route):
        if any(s in route.request.url for s in ['session.prompt', 'session.create', 'startAgentSession', 'launchWorkflow', 'saveAgent', 'agentPreset.select']):
            writes.append(route.request.url.split('/api/')[-1]); route.abort()
        else:
            route.continue_()

    page.route('**/api/**', guard)
    c = page.locator('textarea[data-phase]').first
    action = page.get_by_role('option').filter(has=page.get_by_text('新增浏览器', exact=True))

    def choose_role():
        page.get_by_role('button', name='浏览器管理员', exact=True).click(timeout=60000)
        page.get_by_role('menuitem').filter(has=page.get_by_text('浏览器管理员', exact=True)).click()

    try:
        page.goto(BASE + '/?v=0.30.17&session=' + SESSION, wait_until='domcontentloaded')
        expect(c).to_be_visible(timeout=60000)
        c.fill('@')
        expect(page.get_by_role('option').filter(has=page.get_by_text('浏览器管理员', exact=True))).to_be_visible(timeout=30000)
        expect(action).to_have_count(0)  # Inheritance alone still does not count.
        c.fill(''); choose_role()  # Same native role: real menu, no API write needed.
        c.fill('@'); expect(action).to_be_visible(timeout=30000)
        expect(action).to_have_attribute('aria-selected', 'true')
        page.screenshot(path='/tmp/dtc-action-native-role-1440.png')
        c.press('Enter')
        expect(c).to_have_value(__import__('re').compile(r'^@新增浏览器 '))
        meta = page.evaluate('(id)=>JSON.parse(sessionStorage.getItem("dtc:action-draft:"+id))', SESSION)
        assert meta and not meta['newSession'], 'Native role choice should use this same Session'
        c.fill('')
        page.reload(wait_until='domcontentloaded'); expect(c).to_be_visible(timeout=60000)
        c.fill('@'); expect(action).to_be_visible(timeout=30000)
        print('PASS: native explicit role and reload show Actions directly', flush=True)
        c.press('Escape'); c.fill(''); page.wait_for_timeout(300)
        # Native accessible label differs from its visible title-cased text.
        page.get_by_role('button', name='New session', exact=True).first.click()
        expect(c).to_be_visible(); c.fill('@')
        expect(page.get_by_role('option').filter(has=page.get_by_text('浏览器管理员', exact=True))).to_be_visible(timeout=30000)
        expect(action).to_have_count(0)
        c.fill('')
        # Return to the blank record; New Session must have cleared its UI intent.
        page.goto(BASE + '/?v=0.30.17&session=' + SESSION, wait_until='domcontentloaded')
        expect(c).to_be_visible(timeout=60000)
        page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(300)
        collapse = page.get_by_role('button', name='Collapse sidebar', exact=True)
        if collapse.count(): collapse.click()
        page.mouse.move(385, 200)
        choose_role(); c.fill('@'); expect(action).to_be_visible(timeout=30000)
        page.screenshot(path='/tmp/dtc-action-native-role-390.png')
        assert not writes and not errors, (writes, errors)
        print('PASS: real native role selection, direct Actions in same Session, refresh, New Session isolation, 1440/390px; no writes')
    except Exception:
        print('Role acceptance diagnostics:', page.url, page.get_by_role('button').all_text_contents(), flush=True)
        page.screenshot(path='/tmp/dtc-action-native-role-diagnostic.png')
        raise
    finally:
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
after = next(s for s in native_list() if s['sessionId'] == SESSION)
assert after['blank'] and not after['running'] and after['agentPreset'] == before['agentPreset']
