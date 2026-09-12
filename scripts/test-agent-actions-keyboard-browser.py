"""Read-only real-role keyboard acceptance. Never sends a prompt or changes a preset."""
import hashlib
import json
import os
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
RPC = os.environ.get('DSH_ACTION_RPC', 'http://127.0.0.1:3080')
SESSION = os.environ.get('DSH_ACTION_SESSION', 'agent-browser-manager-mty0qfi0')


def read(method, query):
    name = 'taskConsole/' + method
    data = {'type': 'client-request', 'rpcId': 'action-keyboard-' + method, 'method': name,
            'payload': {'args': {'payload': json.dumps(query)}}}
    req = urllib.request.Request(RPC + '/api/' + name, data=json.dumps(data).encode(), headers={'content-type': 'application/json'})
    reply = json.load(urllib.request.urlopen(req, timeout=30))['result']
    assert reply['ok']
    return json.loads(reply['value'])


catalog = read('agentActions', {'sessionId': SESSION})
assert catalog['agentId'] == 'browser-manager'
before = read('sessionTurns', {'sessionId': SESSION})['totals']
before_catalog = hashlib.sha256(json.dumps(catalog, sort_keys=True).encode()).hexdigest()
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, writes = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: writes.append(r.url) if any(s in r.url for s in ['/startAgentSession', '/session.prompt', '/launchWorkflow', '/saveAgent']) else None)
    composer = page.locator('textarea[data-phase]').first
    try:
        page.goto(BASE + '/?v=0.30.15&session=' + SESSION, wait_until='domcontentloaded')
        expect(composer).to_be_visible(timeout=60000)
        composer.fill('@')
        names = ['新增浏览器', '删除浏览器', '自动登录', '检查登录', '恢复浏览器']
        first = page.get_by_role('option').filter(has=page.get_by_text(names[0], exact=True))
        expect(first).to_be_visible(timeout=30000)
        expect(first).to_have_attribute('aria-selected', 'true')
        page.screenshot(path='/tmp/dtc-action-keyboard-menu-1440.png')
        for name in names[1:]:
            composer.press('ArrowDown')
            expect(page.get_by_role('option', selected=True)).to_contain_text(name)
        for name in reversed(names[:-1]):
            composer.press('ArrowUp')
            expect(page.get_by_role('option', selected=True)).to_contain_text(name)
        # Enter selects the Action; it must not send it or choose a file.
        composer.press('Enter')
        expect(composer).to_have_value('@新增浏览器 ' + next(a['template'] for a in catalog['actions'] if a['id'] == 'create-browser')
                                       .replace('{{ip}}', '【机器 IP】').replace('{{count}}', '【新增数量】').replace('{{login}}', '【自动分配 Gemini 登录】'))

        def selected(value):
            page.wait_for_function('(value) => {const e=document.querySelector("textarea[data-phase]");return e.value.slice(e.selectionStart,e.selectionEnd)===value}', arg=value)

        selected('【机器 IP】')
        page.screenshot(path='/tmp/dtc-action-keyboard-fields-1440.png')
        composer.press('Enter'); selected('【机器 IP】')
        composer.press_sequentially('192.0.2.1')  # Documentation-only address, never submitted.
        composer.press('Enter'); selected('【新增数量】')
        expect(page.get_by_text('2/3 · 新增数量', exact=False)).to_be_visible()
        composer.press_sequentially('2'); composer.press('Enter'); selected('【自动分配 Gemini 登录】')
        composer.press('Shift+Tab'); selected('2')
        composer.press('Tab'); selected('【自动分配 Gemini 登录】')
        composer.press('Enter')
        assert '新增 2 个浏览器' in composer.input_value() and '自动分配 Gemini 登录：是' in composer.input_value()
        assert '【' not in composer.input_value(), 'Default was not accepted into the native draft'
        assert read('sessionTurns', {'sessionId': SESSION})['totals'] == before, 'Final-field Enter sent a prompt'
        # Reopen and accept the numeric default too; both remain visible until accepted.
        composer.fill('@新增浏览器'); expect(first).to_be_visible(timeout=30000); composer.press('Enter'); selected('【机器 IP】')
        composer.press_sequentially('192.0.2.1'); composer.press('Enter'); selected('【新增数量】')
        composer.press('Enter'); selected('【自动分配 Gemini 登录】')
        assert '新增 1 个浏览器' in composer.input_value()
        composer.press_sequentially('否'); composer.press('Enter')
        assert '自动分配 Gemini 登录：否' in composer.input_value()
        composer.fill('@'); expect(first).to_be_visible(timeout=30000); expect(first).to_have_attribute('aria-selected', 'true')
        # Files still participate in the same keyboard order; do not delete their source.
        options = page.get_by_role('option')
        file_index = next(i for i, text in enumerate(options.all_text_contents()) if text.startswith('Folder ·'))
        for _ in range(file_index):
            composer.press('ArrowDown')
        expect(page.get_by_role('option', selected=True)).to_contain_text('Folder ·')
        composer.press('Escape'); composer.fill('@新增浏览器'); expect(first).to_be_visible(); composer.press('Enter'); selected('【机器 IP】')
        page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(300)
        collapse = page.get_by_role('button', name='Collapse sidebar', exact=True)
        if collapse.count():
            collapse.click()
        page.mouse.move(385, 500)
        expect(page.get_by_role('button', name='Open sidebar', exact=True)).to_be_visible()
        page.screenshot(path='/tmp/dtc-action-keyboard-fields-390.png')
        assert composer.bounding_box()['width'] > 220
        assert not errors and not writes, (errors, writes)
        print('PASS: public @ initial focus, five Actions by arrows/Enter, Files retained, three visible parameters, forward/back, numeric/boolean defaults and edits, no final-field send, 1440/390px')
    finally:
        if composer.count() and composer.is_visible():
            composer.fill('')
        browser.close()
assert read('sessionTurns', {'sessionId': SESSION})['totals'] == before
assert hashlib.sha256(json.dumps(read('agentActions', {'sessionId': SESSION}), sort_keys=True).encode()).hexdigest() == before_catalog
print('PASS: original session totals and Agent Actions unchanged; no business operation')
