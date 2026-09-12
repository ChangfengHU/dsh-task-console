"""Read-only public layout regression: edits browser drafts, never saves or sends."""
import hashlib
import json
import os
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
RPC = os.environ.get('DSH_ACTION_RPC', 'http://127.0.0.1:3080')
ROLE = os.environ.get('DSH_ACTION_AGENT', 'browser-manager')


def persisted_hash():
    def read(method, query=None):
        name = 'taskConsole/' + method
        payload = {'type': 'client-request', 'rpcId': 'action-tabs-' + method, 'method': name,
                   'payload': {'args': {} if query is None else {'payload': json.dumps(query)}}}
        request = urllib.request.Request(RPC + '/api/' + name, data=json.dumps(payload).encode(), headers={'content-type': 'application/json'})
        reply = json.load(urllib.request.urlopen(request, timeout=30))['result']
        assert reply['ok']
        return json.loads(reply['value'])
    agent = next(a for a in read('agents') if a['id'] == ROLE)
    actions = read('agentActions', {'agentId': ROLE})
    return hashlib.sha256(json.dumps([agent['spec'], actions], sort_keys=True).encode()).hexdigest()


before = persisted_hash()
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, action_reads, mutations = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: action_reads.append(r.url) if '/api/taskConsole/agentActions' in r.url else None)
    page.on('request', lambda r: mutations.append(r.url) if any(s in r.url for s in ['/saveAgent', '/startAgentSession', '/launchWorkflow', '/session.prompt']) else None)
    try:
        url = BASE + '/?v=0.30.13#/tc/agents/' + ROLE
        page.goto(url, wait_until='domcontentloaded')
        identity = page.get_by_label('名字', exact=True)
        expect(identity).to_be_visible(timeout=60000)
        expect(page.get_by_role('tab', name='配置', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(page.locator('.dtc-actions-editor')).to_have_count(0)
        assert not action_reads, 'Default identity tab loaded Actions unnecessarily'
        assert identity.bounding_box()['y'] < 700, 'Identity pushed below initial viewport'
        page.screenshot(path='/tmp/dtc-action-tabs-config-1440.png')
        original_name = identity.input_value()
        identity.fill(original_name + ' · 未保存草稿')
        page.get_by_role('tab', name='Actions', exact=True).click()
        expect(page.get_by_role('tab', name='Actions', exact=True)).to_have_attribute('aria-selected', 'true')
        editor = page.locator('.dtc-actions-editor')
        action_name = editor.get_by_label('Action 名称', exact=True)
        expect(action_name).to_be_visible(timeout=30000)
        expect(identity).not_to_be_visible()
        expect(page.get_by_role('button', name='保存 → 写 preset', exact=True)).not_to_be_visible()
        expect(page.get_by_role('region', name='Agent 会话列表', exact=True)).to_have_count(0)
        original_action = action_name.input_value()
        action_name.fill(original_action + ' · 未保存草稿')
        page.get_by_role('tab', name='配置', exact=True).click()
        expect(identity).to_have_value(original_name + ' · 未保存草稿')
        expect(editor).not_to_be_visible()
        page.go_back()
        expect(action_name).to_have_value(original_action + ' · 未保存草稿')
        page.go_forward()
        expect(identity).to_be_visible()
        page.get_by_role('tab', name='Actions', exact=True).click()
        page.reload(wait_until='domcontentloaded')
        expect(action_name).to_have_value(original_action, timeout=60000)
        expect(page.get_by_role('tab', name='Actions', exact=True)).to_have_attribute('aria-selected', 'true')
        page.screenshot(path='/tmp/dtc-action-tabs-actions-1440.png')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path='/tmp/dtc-action-tabs-actions-390.png')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile page overflow'
        page.get_by_role('tab', name='配置', exact=True).click()
        expect(identity).to_have_value(original_name)
        expect(editor).not_to_be_visible()
        page.screenshot(path='/tmp/dtc-action-tabs-config-390.png')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.get_by_role('tab', name='会话', exact=False).click()
        expect(page.get_by_role('region', name='Agent 会话列表', exact=True)).to_be_visible()
        page.get_by_role('tab', name='任务', exact=False).click()
        expect(page.get_by_role('region', name='Agent 任务列表', exact=True)).to_be_visible()
        assert not errors, errors
        assert not mutations, mutations
        assert persisted_hash() == before, 'Layout test changed persisted data'
        print('PASS: default identity, lazy Actions tab, hidden panels, drafts, reload/deep-link, history navigation, 1440/390px, sessions/tasks; no mutations or page errors')
    finally:
        browser.close()
