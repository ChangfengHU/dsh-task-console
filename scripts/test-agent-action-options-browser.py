"""Public draft-only Actions acceptance. Read metadata; block every business send."""
import hashlib
import json
import os
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
RPC = os.environ.get('DSH_ACTION_RPC', 'http://127.0.0.1:3080')
EVIDENCE = os.environ.get('DSH_ACTION_EVIDENCE', '/tmp')
SESSION = 'agent-browser-manager-mty0qfi0'
OTHER = 'agent-task-create-agent-mtwlf6hg'


def read(method, query):
    name = 'taskConsole/' + method
    body = {'type': 'client-request', 'rpcId': 'action-options-' + method, 'method': name,
            'payload': {'args': {'payload': json.dumps(query)}}}
    req = urllib.request.Request(RPC + '/api/' + name, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=60))['result']
    assert result['ok'], result.get('error')
    return json.loads(result['value'])


catalog = read('agentActions', {'sessionId': SESSION})
before = read('sessionTurns', {'sessionId': SESSION})['totals']
before_hash = hashlib.sha256(json.dumps(catalog, sort_keys=True).encode()).hexdigest()
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    c = page.locator('textarea[data-phase]').first
    popup = page.get_by_role('region', name='Action 参数候选', exact=True)
    errors, writes, queries = [], [], []
    mode = 'real'
    held = []
    catalog_held = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    def guard(route):
        url = route.request.url
        if any(s in url for s in ['session.prompt', 'session.create', 'startAgentSession', 'launchWorkflow', 'saveAgent', 'agentPreset.select']):
            writes.append(url.split('/api/')[-1]); route.abort(); return
        if mode == 'catalog-hold' and url.endswith('/api/taskConsole/agentActions'):
            catalog_held.append((route, route.request.post_data_json)); return
        if '/taskConsole/agentActionOptions' in url:
            body = route.request.post_data_json
            q = json.loads(body['payload']['args']['payload'])
            queries.append(q)
            if mode == 'hold':
                held.append((route, body)); return
            if mode == 'error':
                route.fulfill(json={'type': 'server-response', 'rpcId': body['rpcId'], 'result': {'ok': False, 'error': {'code': 'internal', 'message': '只读候选查询失败（验收模拟）；没有执行任何目标操作', 'details': {}}}}); return
            if mode == 'pages':
                number = q.get('page', 1)
                items = [{'value': f'192.0.2.{i}', 'label': f'192.0.2.{i}', 'detail': '仅分页测试，不提交'} for i in range(1 if number == 1 else 21, 21 if number == 1 else 26)]
                value = {'items': items, 'page': number, 'pages': 2, 'total': 25, 'notice': '分页验收模拟数据'}
                route.fulfill(json={'type': 'server-response', 'rpcId': body['rpcId'], 'result': {'ok': True, 'value': json.dumps(value)}}); return
        route.continue_()

    page.route('**/api/**', guard)

    def selected(text):
        page.wait_for_function('(text)=>{const e=document.querySelector("textarea[data-phase]");return e&&e.value.slice(e.selectionStart,e.selectionEnd)===text}', arg=text, timeout=15000)

    def pick():
        c.fill('@新增浏览器')
        page.get_by_role('option').filter(has=page.get_by_text('新增浏览器', exact=True)).click(timeout=30000)
        selected('【机器 IP】')

    def focus_value(value):
        c.evaluate('''(e,value)=>{const i=e.value.indexOf(value); if(i<0)throw Error('test field missing'); e.focus();e.setSelectionRange(i,i+value.length);e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));}''', value)
        selected(value)

    def switch(sid):
        page.evaluate('(sid)=>{const u=new URL(location.href);u.searchParams.set("session",sid);history.pushState(null,"",u);dispatchEvent(new PopStateEvent("popstate"));}', sid)
        page.wait_for_timeout(500)

    try:
        page.goto(BASE + '/?v=0.30.20&session=' + SESSION, wait_until='domcontentloaded')
        expect(c).to_be_visible(timeout=60000)
        pick()
        nodes = popup.get_by_role('option')
        expect(nodes.first).to_be_visible(timeout=45000)
        assert nodes.count() >= 2
        ip1 = nodes.nth(0).locator('span').text_content()
        ip2 = nodes.nth(1).locator('span').text_content()
        page.screenshot(path=os.path.join(EVIDENCE, 'dtc-action-options-machines-1440.png'))
        c.press('Enter'); selected('【机器 IP】')  # No silent first-machine choice.
        c.press_sequentially(ip1)
        expect(nodes).to_have_count(1, timeout=45000)
        c.press('ArrowDown'); c.press('Enter'); selected('【新增数量】')
        c.press_sequentially('0'); c.press('Enter'); selected('0')
        c.press_sequentially('1.5'); c.press('Enter'); selected('1.5')
        c.press_sequentially('1'); c.press('Enter'); selected('【登录方式】')
        popup.get_by_role('option', name='指定账号', exact=True).click()
        selected('【指定账号来源】')
        accounts = popup.get_by_role('option').filter(has=page.locator('span'))
        expect(accounts.first).to_be_visible(timeout=45000)
        eligible = popup.locator('[role=option][aria-disabled=false]')
        expect(eligible.first).to_be_visible(timeout=45000)
        assert all('金库 v' in text for text in accounts.all_text_contents())
        assert not any('faker322424' in text for text in accounts.all_text_contents())
        page.screenshot(path=os.path.join(EVIDENCE, 'dtc-action-options-accounts-1440.png'))
        eligible.first.click()
        assert '【' not in c.input_value() and not writes
        assert 'accountId=gemini_' in c.input_value()
        draft = c.input_value()
        mode = 'catalog-hold'
        page.reload(wait_until='domcontentloaded'); expect(c).to_be_visible(timeout=60000); expect(c).to_have_value(draft)
        for _ in range(150):
            if catalog_held: break
            page.wait_for_timeout(200)
        assert catalog_held, 'Expected the Action catalog recovery to be in flight'
        focus_value(ip1); c.press_sequentially(ip2)
        pending_meta = page.evaluate('(sid)=>JSON.parse(sessionStorage.getItem("dtc:action-draft:"+sid)||"null")', SESSION)
        assert pending_meta['progress'].get('edited'), 'Editing during catalog fetch lost structural changes'
        mode = 'real'
        for route, body in catalog_held:
            route.fulfill(json={'type': 'server-response', 'rpcId': body['rpcId'], 'result': {'ok': True, 'value': json.dumps(catalog)}})
        catalog_held.clear()
        expect(c).to_have_value(__import__('re').compile('.*【指定账号来源】.*'), timeout=10000)
        selected(ip2)
        c.press('Enter'); selected('1'); c.press('Enter'); selected('指定账号')
        popup.get_by_role('option', name='按账号分配策略', exact=True).click()
        assert '账号来源：无需指定' in c.input_value() and '【指定账号来源】' not in c.input_value()
        assert not writes
        print('PASS: live machine search and account metadata, default count, integer validation, conditional account, reload, parent invalidation, no final-field send', flush=True)

        # Failure is visible and hand-entered machine intent remains possible.
        mode = 'error'; pick()
        expect(popup).to_contain_text('只读候选查询失败', timeout=10000)
        c.press_sequentially('192.0.2.1'); c.press('Enter'); selected('【新增数量】')
        c.press('Enter'); selected('【登录方式】'); c.press('Enter')
        assert '新增 1 个浏览器' in c.input_value() and not writes
        print('PASS: source error is visible; default automatic policy requires no account lookup', flush=True)

        mode = 'pages'; pick(); expect(popup.get_by_role('button', name='下一页')).to_be_visible()
        popup.get_by_role('button', name='下一页').click()
        expect(popup).to_contain_text('2/2 · 25 项')
        expect(popup.get_by_role('option')).to_have_count(5)
        popup.get_by_role('option').first.click(); selected('【新增数量】')
        print('PASS: paginated candidate selection (explicit mock metadata, no business write)', flush=True)

        mode = 'hold'; pick(); page.wait_for_timeout(500)
        assert held
        switch(OTHER); c.fill('@'); expect(popup).to_have_count(0)
        for route, body in held:
            route.fulfill(json={'type': 'server-response', 'rpcId': body['rpcId'], 'result': {'ok': True, 'value': json.dumps({'items': [{'value': '192.0.2.9', 'label': 'STALE_CANDIDATE_MUST_NOT_APPEAR'}], 'page': 1, 'pages': 1, 'total': 1})}})
        held.clear(); page.wait_for_timeout(500)
        expect(page.get_by_text('STALE_CANDIDATE_MUST_NOT_APPEAR')).to_have_count(0)
        expect(page.get_by_text('Actions · 浏览器管理员', exact=True)).to_have_count(0)
        c.fill(''); mode = 'real'; switch(SESSION); pick()
        expect(popup.get_by_role('option').first).to_be_visible(timeout=45000)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(300)
        collapse = page.get_by_role('button', name='Collapse sidebar', exact=True)
        if collapse.is_visible(): collapse.click()
        page.mouse.move(385, 500)
        expect(page.get_by_role('button', name='Open sidebar', exact=True)).to_be_visible()
        assert c.bounding_box()['width'] > 220
        focus_value('【机器 IP】'); expect(popup.get_by_role('option').first).to_be_visible(timeout=45000)
        box = popup.bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= 390 and box['y'] >= 0
        page.screenshot(path=os.path.join(EVIDENCE, 'dtc-action-options-machines-390.png'))
        page.evaluate("document.body.setAttribute('data-ds-dark-theme','')")
        assert popup.evaluate("e=>getComputedStyle(e).backgroundColor") == 'rgb(22, 27, 33)'
        assert popup.evaluate("e=>getComputedStyle(e).color") == 'rgb(228, 233, 238)'
        page.evaluate("document.body.removeAttribute('data-ds-dark-theme')")
        assert not errors and not writes, (errors, writes)
        print('PASS: delayed replies isolated across roles, public 1440/390px popup bounds, no prompt or machine operation', flush=True)
    except Exception:
        print('diagnostic', c.evaluate('''(e,sid)=>{const meta=JSON.parse(sessionStorage.getItem('dtc:action-draft:'+sid)||'null')?.progress;return {phase:e.dataset.phase,selection:[e.selectionStart,e.selectionEnd],selected:e.value.slice(e.selectionStart,e.selectionEnd),meta,fields:meta?.ranges.map(r=>({value:e.value.slice(r.start,r.end),removed:r.removed,inactive:r.inactive}))}}''', SESSION) if c.count() else None, errors, writes, flush=True)
        raise
    finally:
        for route, _ in held + catalog_held:
            route.abort()
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
assert read('sessionTurns', {'sessionId': SESSION})['totals'] == before
assert hashlib.sha256(json.dumps(read('agentActions', {'sessionId': SESSION}), sort_keys=True).encode()).hexdigest() == before_hash
print('PASS: native history and saved Actions unchanged by browser acceptance')
