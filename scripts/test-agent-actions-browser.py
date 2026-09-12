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
        editor = page.locator('.dtc-actions-editor')
        editor.get_by_role('button', name='＋ 新增 Action').wait_for(timeout=60000)
        print('public_agent_ready_seconds', round(time.time() - started, 2), flush=True)
        editor.get_by_role('button', name='＋ 新增 Action').click()
        editor.get_by_label('Action 名称', exact=True).fill('安全回声')
        editor.get_by_label('Action id', exact=True).fill('echo')
        editor.get_by_label('提示词模板', exact=False).fill('这是 UI 验收，不使用任何工具、不操作机器。请只回复 {{target}}。')
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
        composer = page.locator('textarea').first
        composer.fill('@' + agent_id)
        page.get_by_text('Action 界面验收', exact=True).last.click(timeout=30000)
        popup = page.get_by_role('dialog', name='Agent Action')
        expect(popup).to_be_visible()
        popup.get_by_label('选择 Action', exact=True).select_option('echo')
        expect(popup.get_by_role('button', name='创建会话并发送', exact=True)).to_be_disabled()
        popup.get_by_label('目标', exact=False).fill('ACTION_NEW_SESSION_OK')
        expect(popup.locator('.dtc-action-preview')).to_contain_text('ACTION_NEW_SESSION_OK')
        before = session_ids()
        popup.get_by_role('button', name='取消', exact=True).click()
        assert session_ids() == before, 'Cancel created a session'
        # Re-open without losing the original draft; only explicit send starts the role.
        composer.fill('')
        composer.fill('@' + agent_id)
        page.get_by_text('Action 界面验收', exact=True).last.click(timeout=30000)
        popup.get_by_label('选择 Action', exact=True).select_option('echo')
        popup.get_by_label('目标', exact=False).fill('ACTION_NEW_SESSION_OK')
        popup.get_by_role('button', name='创建会话并发送', exact=True).click()
        expect(popup).not_to_be_visible(timeout=45000)
        page.wait_for_url('**/*session=agent-' + agent_id + '-*', timeout=45000)
        sid = parse_qs(urlparse(page.url).query)['session'][0]
        assert session_ids() - before == {sid}, 'New Action did not create exactly one role session'
        assert rpc('agentActions', {'sessionId': sid})['agentId'] == agent_id
        print('new_session', sid, flush=True)
        composer = page.locator('textarea').first
        composer.fill('@')
        page.get_by_text('安全回声', exact=True).last.click(timeout=30000)
        expect(popup).to_be_visible()
        popup.get_by_label('目标', exact=False).fill('ACTION_CURRENT_SESSION_OK')
        page.screenshot(path='/tmp/dtc-actions-current-1440.png')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path='/tmp/dtc-actions-current-390.png')
        box = popup.bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= 391, 'Dialog overflows mobile viewport'
        page.set_viewport_size({'width': 1440, 'height': 1000})
        before_current = session_ids()
        popup.get_by_role('button', name='确认发送到当前会话', exact=True).click()
        expect(popup).not_to_be_visible(timeout=45000)
        assert parse_qs(urlparse(page.url).query)['session'][0] == sid
        assert session_ids() == before_current, 'Current Action created another session'
        expect(page.get_by_text('ACTION_CURRENT_SESSION_OK', exact=True).last).to_be_visible(timeout=60000)
        print('current_session_preserved', sid, flush=True)
        print('page_errors', errors, flush=True)
        assert not errors
    finally:
        # Only this script's randomized preset; preserve its transcript and screenshots.
        rpc('deleteAgent', {'id': agent_id})
        browser.close()
