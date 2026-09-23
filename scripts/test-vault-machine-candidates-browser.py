"""Read-only public browser acceptance; never submit an Action or start a Task."""
import json, os, urllib.request
from playwright.sync_api import sync_playwright, expect

TASK = 'T-chat-b4c6fcb369f0c20a9739'
SESSION = 'agent-task-create-agent-mu25ngup'
BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh.vyibc.com')
def rpc(name, args):
    method = 'taskConsole/' + name
    body = dict(type='client-request', rpcId='vault-browser-' + name, method=method, payload=dict(args=dict(payload=json.dumps(args))))
    req = urllib.request.Request('http://127.0.0.1:3080/api/' + method, data=json.dumps(body).encode(), headers={'content-type':'application/json'})
    result = json.load(urllib.request.urlopen(req, timeout=60))['result']
    assert result['ok'], name
    return json.loads(result['value'])

catalog = rpc('taskActions', dict(taskId=TASK))
before = rpc('taskSnapshot', dict(id=TASK, summary=True))
assert catalog['actions'][0]['parameters'][0]['source'] == 'vault.ssh-nodes'
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440, 'height':1000})
    errors, writes = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    def guard(route):
        if any(x in route.request.url for x in ['launchTaskAction','launchWorkflow','session.prompt','session.create','startAgentSession','saveTask','saveAgent','fireTask','agentPreset.select']):
            writes.append(route.request.url.split('/api/')[-1]); route.abort()
        else: route.continue_()
    page.route('**/api/**', guard)
    c = page.locator('textarea[data-phase]').first
    try:
        page.goto(BASE + '/?session=' + SESSION, wait_until='domcontentloaded', timeout=60000)
        expect(c).to_be_visible(timeout=90000)
        c.fill('@')
        task = page.get_by_role('option').filter(has=page.get_by_text(catalog['name'], exact=True))
        expect(task).to_be_visible(timeout=60000); task.click()
        action = page.get_by_role('option').filter(has=page.get_by_text('装机与账号验收', exact=True))
        expect(action).to_be_visible(timeout=30000); c.press('Enter')
        popup = page.get_by_role('region', name='Action 参数候选', exact=True)
        candidate = popup.get_by_role('option').filter(has_text='129.213.30.236')
        expect(candidate).to_be_visible(timeout=60000)
        assert '金库 SSH' in popup.inner_text()
        candidate.scroll_into_view_if_needed()
        page.screenshot(path='/tmp/dsh-vault-machine-candidates-1440.png')
        page.set_viewport_size({'width':390,'height':844})
        expect(candidate).to_be_visible()
        candidate.scroll_into_view_if_needed()
        page.screenshot(path='/tmp/dsh-vault-machine-candidates-390.png')
        candidate.click()
        assert '129.213.30.236' in c.input_value()
        assert not writes and not errors, (writes, errors)
        print('PASS: public @ Task Action shows Vault SSH candidate 129.213.30.236; selection fills draft only; desktop/narrow candidate popup screenshots (not a full mobile layout acceptance); no prompt or Task execution', flush=True)
    finally:
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
assert rpc('taskActions', dict(taskId=TASK)) == catalog
assert rpc('taskSnapshot', dict(id=TASK, summary=True)) == before
print('PASS: Task snapshot and Action revision unchanged by browser test')
