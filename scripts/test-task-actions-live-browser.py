"""Real Task/catalog/Vault metadata acceptance; blocks ALL execution and config writes."""
import json
import os
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
SESSION = 'agent-browser-manager-mty0qfi0'
TASK = 'T-chat-b4c6fcb369f0c20a9739'

def read(method, query):
    name = 'taskConsole/' + method
    body = dict(type='client-request', rpcId='task-actions-live-' + method, method=name, payload=dict(args=dict(payload=json.dumps(query))))
    request = urllib.request.Request('http://127.0.0.1:3080/api/' + name, data=json.dumps(body).encode(), headers={'content-type':'application/json'})
    result = json.load(urllib.request.urlopen(request, timeout=60))['result']
    assert result['ok'], method
    return json.loads(result['value'])

catalog = read('taskActions', dict(taskId=TASK))
before = read('sessionTurns', dict(sessionId=SESSION))['totals']
assert catalog['actions'][0]['id'] == 'onboard-node'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors, mutations = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def guard(route):
        if any(x in route.request.url for x in ['launchTaskAction','launchWorkflow','session.prompt','session.create','startAgentSession','saveTask','saveAgent','fireTask','agentPreset.select']):
            mutations.append(route.request.url.split('/api/')[-1]); route.abort()
        else: route.continue_()
    page.route('**/api/**', guard)
    c = page.locator('textarea[data-phase]').first
    def selected(value):
        page.wait_for_function('(v)=>{let e=document.querySelector("textarea[data-phase]");return e&&e.value.slice(e.selectionStart,e.selectionEnd)===v}', arg=value)
    try:
        page.goto(BASE + '/?v=0.30.22&session=' + SESSION + '#/tc/tasks/' + TASK + '/actions', wait_until='domcontentloaded')
        editor = page.locator('.dtc-actions-editor')
        expect(editor.get_by_label('Action 名称', exact=True)).to_have_value('装机与账号验收', timeout=60000)
        expect(editor.get_by_label('启用 Action', exact=True)).to_be_checked()
        page.screenshot(path='/tmp/dtc-task-actions-live-editor-1440.png')
        page.set_viewport_size({'width':390,'height':844}); page.wait_for_timeout(200)
        assert editor.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.screenshot(path='/tmp/dtc-task-actions-live-editor-390.png')
        page.set_viewport_size({'width':1440,'height':1000})
        page.get_by_role('button', name='关闭工作台', exact=True).click()
        expect(c).to_be_visible(timeout=60000)
        c.fill('@')
        task = page.get_by_role('option').filter(has=page.get_by_text(catalog['name'], exact=True))
        expect(task).to_be_visible(timeout=30000); task.click()
        expect(c).to_have_value('@' + TASK + '/')
        action = page.get_by_role('option').filter(has=page.get_by_text('装机与账号验收', exact=True))
        expect(action).to_be_visible(timeout=30000); c.press('Enter'); selected('【机器 IP】')
        popup = page.get_by_role('region', name='Action 参数候选', exact=True)
        expect(popup.get_by_role('option').first).to_be_visible(timeout=30000)
        c.press_sequentially('192.0.2.30'); c.press('Enter'); selected('【SSH 接入方式】')
        c.press('Enter'); selected('【账号选择】')
        expect(popup.get_by_role('option', name='指定账号', exact=True)).to_be_visible()
        c.press('ArrowDown'); c.press('ArrowDown'); c.press('Enter'); selected('【金库账号】')
        choices = popup.get_by_role('option')
        expect(choices.first).to_be_visible(timeout=30000)
        assert any('金库' in t for t in choices.all_text_contents()), 'Must read actual Vault metadata, not live-browser fallback'
        assert 'faker322424' not in popup.inner_text(), 'Excluded account must stay excluded'
        page.screenshot(path='/tmp/dtc-task-actions-live-vault-1440.png')
        page.set_viewport_size({'width':390,'height':844}); page.wait_for_timeout(200)
        page.screenshot(path='/tmp/dtc-task-actions-live-vault-390.png')
        assert not mutations and not errors, (mutations, errors)
        print('PASS: live catalog, existing Task @ submenu, native keyboard defaults, actual Fleet candidates, Vault intent for unregistered documentation IP, excluded accounts, responsive UI; NO execution/config writes.', flush=True)
    finally:
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
assert read('sessionTurns', dict(sessionId=SESSION))['totals'] == before
assert read('taskActions', dict(taskId=TASK)) == catalog
print('PASS: original session totals and Task Action catalog unchanged by browser test')
