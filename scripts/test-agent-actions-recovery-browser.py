"""Draft-only acceptance: never sends a prompt or changes a role/preset/Task."""
import json
import os
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
RPC = os.environ.get('DSH_ACTION_RPC', 'http://127.0.0.1:3080')
SESSION = 'agent-browser-manager-mty0qfi0'
OTHER = 'agent-task-create-agent-mtwlf6hg'


def read(method, query):
    name = 'taskConsole/' + method
    body = {'type': 'client-request', 'rpcId': 'action-recovery-' + method, 'method': name,
            'payload': {'args': {'payload': json.dumps(query)}}}
    req = urllib.request.Request(RPC + '/api/' + name, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=30))['result']
    assert result['ok']
    return json.loads(result['value'])


before = read('sessionTurns', {'sessionId': SESSION})['totals']
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, blocked, expected_prompts = [], [], []
    expect_prompt = False
    page.on('pageerror', lambda e: errors.append(str(e)))

    def guard(route):
        if any(s in route.request.url for s in ['session.prompt', 'session.create', 'startAgentSession', 'launchWorkflow', 'saveAgent', 'agentPreset.select']):
            if expect_prompt and '/api/session.prompt' in route.request.url:
                expected_prompts.append(route.request.post_data_json)
            else:
                blocked.append(route.request.url.split('/api/')[-1])
            route.abort()
        else:
            route.continue_()

    page.route('**/api/**', guard)
    c = page.locator('textarea[data-phase]').first
    create = page.get_by_role('option').filter(has=page.get_by_text('新增浏览器', exact=True))

    def selected(text):
        page.wait_for_function('(text)=>{const e=document.querySelector("textarea[data-phase]");return e&&e.value.slice(e.selectionStart,e.selectionEnd)===text}', arg=text, timeout=15000)

    def pick():
        c.fill('@新增浏览器'); create.click(timeout=30000); selected('【机器 IP】')

    def reload():
        page.reload(wait_until='domcontentloaded'); expect(c).to_be_visible(timeout=60000)

    def switch(sid):
        page.evaluate('(sid)=>{const u=new URL(location.href);u.searchParams.set("session",sid);history.pushState(null,"",u);dispatchEvent(new PopStateEvent("popstate"));}', sid)
        page.wait_for_timeout(500)

    try:
        page.goto(BASE + '/?v=0.30.15&session=' + SESSION, wait_until='domcontentloaded')
        expect(c).to_be_visible(timeout=60000)
        pick(); c.press_sequentially('192.0.2.1'); c.press('Enter'); selected('【新增数量】')
        c.press_sequentially('2')
        draft = c.input_value()
        metadata = page.evaluate('(sid)=>sessionStorage.getItem("dtc:action-draft:"+sid)', SESSION)
        assert metadata and '192.0.2.1' not in metadata, 'UI metadata must not duplicate parameter values'
        reload(); expect(c).to_have_value(draft); selected('2')
        c.press('Enter'); selected('【自动分配 Gemini 登录】')
        c.press('Shift+Tab'); selected('2'); c.press('Tab'); selected('【自动分配 Gemini 登录】')
        c.press_sequentially('否'); c.press('Enter')
        assert '自动分配 Gemini 登录：否' in c.input_value() and not blocked
        print('PASS: refreshed partial draft, exact edited ranges, Enter/Tab/back, last field no send', flush=True)

        # Missing-parameter Send after refresh must stay in editing, never fall through.
        pick(); reload(); page.get_by_role('button', name='Send message', exact=True).click()
        page.wait_for_timeout(500); selected('【机器 IP】'); assert not blocked
        c.press_sequentially('192.0.2.1')
        partial = c.input_value()
        switch(OTHER); c.fill('@'); page.wait_for_timeout(2000); expect(create).to_have_count(0)
        c.fill(''); switch(SESSION); expect(c).to_have_value(partial)
        c.press('Enter'); selected('【新增数量】')
        print('PASS: missing-field Send guard and session switch/back without role leakage', flush=True)

        c.fill(''); page.get_by_role('button', name='New session', exact=True).first.click()
        expect(c).to_be_visible(); c.fill('@'); page.wait_for_timeout(2500); expect(create).to_have_count(0)
        c.fill('@browser-manager')
        page.get_by_role('option').filter(has=page.get_by_text('浏览器管理员', exact=True)).click(timeout=30000)
        expect(c).to_have_value('@browser-manager/')
        create.click(timeout=30000); selected('【机器 IP】')
        assert c.input_value().startswith('@浏览器管理员/新增浏览器 ')
        c.press_sequentially('192.0.2.1'); reload(); selected('192.0.2.1')
        c.press('Enter'); selected('【新增数量】'); c.press('Enter'); selected('【自动分配 Gemini 登录】')
        c.press('Enter'); assert not blocked
        c.fill('@'); page.wait_for_timeout(2000); expect(create).to_have_count(0)
        page.screenshot(path='/tmp/dtc-action-recovery-role-1440.png')
        print('PASS: reused inherited blank hides Actions, explicit Agent selection and refresh recover correctly; clearing hides again', flush=True)
        c.fill(''); switch(SESSION); pick(); c.press_sequentially('192.0.2.1')
        # A prior-version draft without metadata must still recover real markers.
        page.evaluate('(sid)=>sessionStorage.removeItem("dtc:action-draft:"+sid)', SESSION)
        reload(); selected('【新增数量】')
        c.press('Enter'); selected('【自动分配 Gemini 登录】'); c.press('Enter')
        assert not expected_prompts and not blocked
        # One extra explicit Enter reaches the same native session, intercepted
        # before HTTP delivery. This tests dispatch, not business execution.
        expect_prompt = True
        c.press('Enter')
        page.wait_for_timeout(1500)
        assert len(expected_prompts) == 1, 'Completed Action did not reach the native prompt path exactly once'
        payload = json.dumps(expected_prompts[0], ensure_ascii=False)
        assert SESSION in payload and '[Action: 新增浏览器' in payload and '192.0.2.1' in payload and '【' not in payload
        print('PASS: legacy draft recovery and one explicitly requested same-session dispatch intercepted before delivery', flush=True)
        assert not errors and not blocked, (errors, blocked)
    except Exception:
        if c.count() and c.is_visible():
            print('diagnostic', c.evaluate('(e)=>({phase:e.dataset.phase,selected:e.value.slice(e.selectionStart,e.selectionEnd),length:e.value.length})'), errors, blocked, flush=True)
        raise
    finally:
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
assert read('sessionTurns', {'sessionId': SESSION})['totals'] == before
print('PASS: no model/Agent/Task/host operation; native turn totals unchanged')
