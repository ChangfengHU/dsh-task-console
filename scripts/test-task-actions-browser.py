"""Public native composer + controlled Task Action API fixtures. No real dispatch/host writes."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh-152-32-214-95.vyibc.com')
SESSION = 'agent-browser-manager-mty0qfi0'
TASK = 'T-action-ui-fixture'
actions = json.loads((Path(__file__).resolve().parent.parent / 'presets/fleet-task-actions.json').read_text())
catalog = dict(taskId=TASK, agentId=None, name='Task Actions 验收', revision='fixture-v1', writable=True, actions=actions)
workflow = dict(id=TASK, title=catalog['name'], brief='UI routing fixture, never executes', participants=[], actionCount=1)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    calls, blocked, errors = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))

    def route_api(route):
        name = route.request.url.split('/api/')[-1].split('?')[0]
        data = route.request.post_data_json or {}
        args = data.get('payload', {}).get('args', {})
        query = json.loads(args.get('payload', '{}'))

        def reply(value):
            route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(type='server-response', rpcId=data.get('rpcId'), result=dict(ok=True, value=json.dumps(value)))))

        if name == 'taskConsole/workflowCatalog':
            reply([workflow])
        elif name == 'taskConsole/taskActions':
            assert query['taskId'] == TASK
            reply(catalog)
        elif name == 'taskConsole/agentActionOptions' and query.get('taskId'):
            values = [{'value':'192.0.2.30','label':'192.0.2.30','detail':'Document-only fixture'}] if query['parameter'] == 'ip' else [{'value':'fixture@example.test · accountId=gemini_12345678 · #12345678','label':'fixture@example.test','detail':'Fixture Vault account'}]
            reply(dict(items=values, page=1, pages=1, total=len(values)))
        elif name == 'taskConsole/launchTaskAction':
            calls.append(query)
            if len(calls) == 3:
                reply(dict(taskId=TASK, batchId='b-action-ui-fixture', path='/#/tc/tasks/' + TASK + '/runs/b-action-ui-fixture'))
                return
            # Intercept before the host: deterministic failure allows retry-ID verification.
            route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(type='server-response', rpcId=data.get('rpcId'), result=dict(ok=False, error=dict(code='fixture_unavailable', message='Fixture delivery unavailable; no dispatch')))))
        elif any(s in name for s in ['session.prompt','session.create','startAgentSession','launchWorkflow','saveAgent','saveTask','fireTask','agentPreset.select']):
            blocked.append(name)
            route.abort()
        else:
            route.continue_()

    page.route('**/api/**', route_api)
    c = page.locator('textarea[data-phase]').first
    def selected(value):
        page.wait_for_function('(v)=>{const e=document.querySelector("textarea[data-phase]");return e&&e.value.slice(e.selectionStart,e.selectionEnd)===v}', arg=value, timeout=15000)

    try:
        page.goto(BASE + '/?v=task-actions-fixture&session=' + SESSION + '#/tc/tasks/' + TASK + '/actions', wait_until='domcontentloaded')
        editor = page.locator('.dtc-actions-editor')
        expect(editor.get_by_label('Action 名称', exact=True)).to_have_value('装机与账号验收', timeout=60000)
        page.screenshot(path='/tmp/dtc-task-actions-editor-1440.png')
        page.set_viewport_size({'width':390,'height':844}); page.wait_for_timeout(300)
        page.screenshot(path='/tmp/dtc-task-actions-editor-390.png')
        assert editor.evaluate('(e)=>e.scrollWidth <= e.clientWidth + 1'), 'Editor overflow'
        page.set_viewport_size({'width':1440,'height':1000})
        page.get_by_role('button', name='关闭工作台', exact=True).click()
        expect(c).to_be_visible(timeout=60000)
        c.fill('@')
        task = page.get_by_role('option').filter(has=page.get_by_text(catalog['name'], exact=True))
        expect(task).to_be_visible(timeout=30000)
        expect(page.get_by_role('option').filter(has=page.get_by_text('装机与账号验收', exact=True))).to_have_count(0)
        task.click()
        expect(c).to_have_value('@' + TASK + '/')
        action = page.get_by_role('option').filter(has=page.get_by_text('装机与账号验收', exact=True))
        expect(action).to_be_visible(timeout=30000)
        expect(page.get_by_role('option').filter(has=page.get_by_text('新增浏览器', exact=True))).to_have_count(0)
        c.press('Enter'); selected('【机器 IP】')
        c.press_sequentially('192.0.2.30'); c.press('Enter'); selected('【SSH 接入方式】')
        c.press('Enter'); selected('【账号选择】')
        popup = page.get_by_role('region', name='Action 参数候选', exact=True)
        expect(popup.get_by_role('option', name='指定账号', exact=True)).to_be_visible()
        c.press('ArrowDown'); c.press('ArrowDown'); c.press('Enter'); selected('【金库账号】')
        expect(popup.get_by_role('option').filter(has=page.get_by_text('fixture@example.test', exact=True))).to_be_visible(timeout=10000)
        c.press('ArrowDown'); c.press('Enter')
        assert not calls and not blocked, 'Final placeholder Enter must not dispatch'
        draft = c.input_value()
        assert 'accountId=gemini_12345678' in draft
        page.screenshot(path='/tmp/dtc-task-actions-composer-1440.png')
        page.reload(wait_until='domcontentloaded'); expect(c).to_have_value(draft, timeout=60000)
        page.wait_for_function('()=>document.querySelector("textarea[data-phase]")?.dataset.phase !== "plain"')
        meta = page.evaluate('(s)=>JSON.parse(sessionStorage.getItem("dtc:action-draft:"+s))', SESSION)
        assert meta['taskId'] == TASK and meta.get('requestId')
        assert '192.0.2.30' not in json.dumps(meta)
        page.get_by_role('button', name='Send message', exact=True).click()
        page.wait_for_timeout(1500)
        assert len(calls) == 1, (calls, errors, blocked)
        assert calls[0]['taskId'] == TASK and calls[0]['values']['ip'] == '192.0.2.30'
        assert 'username' not in calls[0]['values'] and 'password' not in calls[0]['values']
        page.get_by_role('button', name='Send message', exact=True).click(); page.wait_for_timeout(1500)
        assert len(calls) == 2 and calls[0]['requestId'] == calls[1]['requestId']
        page.get_by_role('button', name='Send message', exact=True).click()
        page.wait_for_url('**#/tc/tasks/' + TASK + '/runs/b-action-ui-fixture')
        assert len(calls) == 3 and calls[0]['requestId'] == calls[2]['requestId']
        page.evaluate('(id)=>{location.hash="/tc/tasks/"+id+"/actions"}', TASK)
        editor = page.locator('.dtc-actions-editor')
        expect(editor.get_by_label('Action 名称', exact=True)).to_have_value('装机与账号验收', timeout=30000)
        editor.get_by_text('预览输入框 · 不会执行', exact=True).click()
        expect(editor.locator('pre')).to_contain_text('【机器 IP】')
        assert not errors and not blocked, (errors, blocked)
        print('PASS: Task-only selection, native defaults/conditional Vault candidates, refresh, structured dispatch-only routing, retry ID, lazy editor and preview, 1440/390. API fixtures; no business execution.', flush=True)
    except Exception:
        print('fixture diagnostic', c.input_value() if c.count() else None, page.get_by_role('region', name='Action 参数候选', exact=True).all_text_contents(), errors, blocked, flush=True)
        page.screenshot(path='/tmp/dtc-task-actions-diagnostic.png')
        raise
    finally:
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
