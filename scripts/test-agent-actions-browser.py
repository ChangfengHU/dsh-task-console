"""Opt-in public UI smoke. Creates one tool-free test Agent; never operates Fleet.

Run: DSH_ACTION_SMOKE=1 python3 scripts/test-agent-actions-browser.py
Preserves its native session as acceptance evidence; removes only its own preset.
"""
import json
import os
import time
import uuid
import urllib.request
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

assert os.environ.get('DSH_ACTION_SMOKE') == '1', 'Explicit smoke opt-in required'
BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
RPC = os.environ.get('DSH_ACTION_RPC', 'http://127.0.0.1:3080')
agent_id = 'action-ui-check-' + uuid.uuid4().hex[:10]


def rpc(method, payload=None, native=False):
    name = method if native else 'taskConsole/' + method
    args = (payload or {}) if native else {'args': {} if payload is None else {'payload': json.dumps(payload)}}
    data = {'type': 'client-request', 'rpcId': 'action-smoke-' + uuid.uuid4().hex, 'method': name, 'payload': args}
    req = urllib.request.Request(RPC + '/api/' + name, data=json.dumps(data).encode(), headers={'content-type': 'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=30))['result']
    assert result['ok'], result.get('error', {}).get('message', 'RPC failed')
    return json.loads(result['value']) if isinstance(result['value'], str) else result['value']


def session_ids():
    return {s['sessionId'] for s in rpc('session.list', native=True)['items']}


rpc('saveAgent', {'id': agent_id, 'name': 'Action 界面验收', 'description': '工具为空的快捷指令验收，不参与业务任务',
                 'persona': '你只执行文本回声测试，不使用工具，不操作任何机器，不创建任务。',
                 'model': rpc('catalog')['defaultModel'], 'effort': '', 'permissionPreset': 'workspace-write',
                 'tools': [], 'skills': [], 'mcpTools': {}, 'mcpPolicy': {}})
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda dialog: dialog.accept())
    try:
        started = time.time()
        page.goto(BASE + '/#/tc/agents/' + agent_id, wait_until='domcontentloaded')
        expect(page.get_by_label('名字', exact=True)).to_be_visible(timeout=60000)
        expect(page.locator('.dtc-actions-editor')).not_to_be_visible()
        page.get_by_role('tab', name='Actions', exact=True).click()
        editor = page.locator('.dtc-actions-editor')
        editor.get_by_role('button', name='＋ 新增 Action').wait_for(timeout=60000)
        print('public_agent_ready_seconds', round(time.time() - started, 2), flush=True)
        editor.get_by_role('button', name='＋ 新增 Action').click()
        editor.get_by_label('Action 名称', exact=True).fill('安全回声')
        editor.get_by_label('Action id', exact=True).fill('echo')
        editor.get_by_role('button', name='＋ 参数', exact=True).click()
        editor.get_by_label('提示词模板', exact=False).fill('这是 UI 验收，不使用任何工具、不操作机器。请只回复 {{target}}_{{param_2}}。')
        editor.get_by_role('button', name='保存 Actions', exact=True).click()
        expect(editor.get_by_role('status')).to_contain_text('已保存')
        editor.get_by_role('button', name='复制 Action', exact=True).click()
        editor.get_by_label('Action 名称', exact=True).fill('准备删除')
        editor.get_by_role('button', name='保存 Actions', exact=True).click()
        expect(editor.get_by_role('status')).to_contain_text('已保存')
        assert len(rpc('agentActions', {'agentId': agent_id})['actions']) == 2
        editor.get_by_role('button', name='删除 Action', exact=True).click()
        editor.get_by_role('button', name='保存 Actions', exact=True).click()
        expect(editor.get_by_role('status')).to_contain_text('已保存')
        editor.get_by_role('button', name='重新加载', exact=True).click()
        expect(editor.get_by_label('Action 名称', exact=True)).to_have_value('安全回声')
        assert len(rpc('agentActions', {'agentId': agent_id})['actions']) == 1
        page.screenshot(path='/tmp/dtc-actions-editor-1440.png')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path='/tmp/dtc-actions-editor-390.png')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile page overflow'
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.get_by_role('button', name='关闭工作台', exact=True).click()
        page.get_by_role('button', name='New session', exact=True).first.click()
        composer = page.locator('textarea[data-phase]').first
        composer.fill('@')
        page.wait_for_timeout(1500)
        expect(page.get_by_role('option').filter(has=page.get_by_text('安全回声', exact=True))).to_have_count(0)
        composer.fill('@' + agent_id)
        page.get_by_role('option').filter(has=page.get_by_text('Action 界面验收', exact=True)).click(timeout=30000)
        expect(composer).to_have_value('@' + agent_id + '/')
        page.get_by_role('option').filter(has=page.get_by_text('安全回声', exact=True)).click(timeout=30000)
        expect(page.get_by_role('dialog')).to_have_count(0)
        expect(composer).to_have_value('@Action 界面验收/安全回声 这是 UI 验收，不使用任何工具、不操作机器。请只回复 【目标】_【新参数】。')
        selected = lambda: composer.evaluate('(e)=>e.value.slice(e.selectionStart,e.selectionEnd)')
        page.wait_for_timeout(200)
        assert selected() == '【目标】'
        composer.dispatch_event('keydown', {'key': 'Enter', 'code': 'Enter', 'keyCode': 229, 'isComposing': True})
        assert selected() == '【目标】', 'IME confirmation advanced a placeholder'
        before = session_ids()
        composer.press('Enter')
        assert selected() == '【目标】', 'An empty required field was skipped'
        page.get_by_role('button', name='Send message', exact=True).click()
        page.wait_for_timeout(300)
        assert '【目标】' in composer.input_value(), 'Send bypassed the placeholder guard'
        assert session_ids() == before, 'Picking an Action or empty Enter created a session'
        # Clearing the draft cancels without a modal or execution.
        composer.fill('')
        assert session_ids() == before
        composer.fill('@' + agent_id)
        page.get_by_role('option').filter(has=page.get_by_text('Action 界面验收', exact=True)).click(timeout=30000)
        page.get_by_role('option').filter(has=page.get_by_text('安全回声', exact=True)).click(timeout=30000)
        page.wait_for_timeout(200)
        composer.press_sequentially('ACTION_NEW')
        typed = composer.input_value()
        composer.press('Control+z')
        assert composer.input_value() != typed, 'Native undo was bypassed'
        composer.press('Control+Shift+z')
        expect(composer).to_have_value(typed)
        composer.press('Enter')
        assert selected() == '【新参数】', 'Enter did not move to the next placeholder'
        composer.press('Shift+Tab')
        assert selected() == 'ACTION_NEW', 'Shift+Tab did not revisit the edited field'
        composer.press('Tab')
        assert selected() == '【新参数】'
        composer.press_sequentially('SESSION_OK')
        composer.press('Enter')
        assert session_ids() == before, 'Finishing the last placeholder sent prematurely'
        assert 'ACTION_NEW_SESSION_OK' in composer.input_value()
        composer.press('Enter')
        page.wait_for_url('**/*session=agent-' + agent_id + '-*', timeout=45000)
        sid = parse_qs(urlparse(page.url).query)['session'][0]
        assert session_ids() - before == {sid}, 'New Action did not create exactly one role session'
        assert rpc('agentActions', {'sessionId': sid})['agentId'] == agent_id
        print('new_session', sid, flush=True)
        expect(page.get_by_text('ACTION_NEW_SESSION_OK', exact=True).last).to_be_visible(timeout=60000)
        composer = page.locator('textarea[data-phase]').first
        composer.fill('@')
        page.get_by_role('option').filter(has=page.get_by_text('安全回声', exact=True)).wait_for(timeout=30000)
        expect(page.get_by_role('option').filter(has=page.get_by_text('删除浏览器', exact=True))).to_have_count(0)
        page.get_by_role('option').filter(has=page.get_by_text('安全回声', exact=True)).click()
        page.wait_for_timeout(200)
        composer.press_sequentially('ACTION_CURRENT')
        composer.press('Enter')
        assert selected() == '【新参数】'
        composer.press_sequentially('SESSION_OK')
        composer.press('Enter')
        page.screenshot(path='/tmp/dtc-actions-current-1440.png')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(300)  # Wait for DSH's resize-driven auto-collapse before deciding to toggle.
        collapse = page.get_by_role('button', name='Collapse sidebar', exact=True)
        if collapse.count():
            collapse.click()
        page.mouse.move(385, 500)  # Native sidebar re-expands while the pointer hovers its rail.
        expect(page.get_by_role('button', name='Open sidebar', exact=True)).to_be_visible(timeout=30000)
        page.screenshot(path='/tmp/dtc-actions-current-390.png')
        box = composer.bounding_box()
        assert box['x'] >= 0 and box['width'] > 220 and box['x'] + box['width'] <= 391, 'Native input unusable on mobile'
        page.set_viewport_size({'width': 1440, 'height': 1000})
        before_current = session_ids()
        composer.press('Enter')
        assert parse_qs(urlparse(page.url).query)['session'][0] == sid
        assert session_ids() == before_current, 'Current Action created another session'
        expect(page.get_by_text('ACTION_CURRENT_SESSION_OK', exact=True).last).to_be_visible(timeout=60000)
        assert session_ids() == before_current, 'Current Action created another session after acknowledgement'
        print('current_session_preserved', sid, flush=True)
        print('page_errors', errors, flush=True)
        assert not errors
    finally:
        # Only this script's randomized preset; preserve its transcript and screenshots.
        rpc('deleteAgent', {'id': agent_id})
        browser.close()
