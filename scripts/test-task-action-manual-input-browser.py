"""Staged UI against the live catalog, mocked candidates; NEVER submits business work."""
import json
import os
from pathlib import Path
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DSH_ACTION_BASE', 'https://dsh.vyibc.com')
SESSION = os.environ.get('DSH_ACTION_SESSION', 'session-f979c6e1-104f-4d38-892e-c03a08d0b276')
TASK = 'T-chat-b4c6fcb369f0c20a9739'
ASSETS = Path(os.environ['DTC_BUILD_OUT'])
EVIDENCE = Path(os.environ.get('DSH_ACTION_EVIDENCE', '/tmp'))

def read(method, query):
    name = 'taskConsole/' + method
    request = urllib.request.Request('http://127.0.0.1:3080/api/' + name,
        data=json.dumps(dict(type='client-request',rpcId='manual-input-test',method=name,payload=dict(args=dict(payload=json.dumps(query))))).encode(),
        headers={'Content-Type':'application/json'})
    result = json.load(urllib.request.urlopen(request,timeout=30))['result']
    assert result['ok'], method
    return json.loads(result['value'])

catalog = read('taskActions', {'taskId':TASK})
before = read('sessionTurns', {'sessionId':SESSION})['totals']
account = dict(label='fixture@example.test',value='fixture@example.test · accountId=gemini_aaaaaaaa · #aaaaaaaa')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors, submissions, loaded = [], [], []
    page.on('pageerror',lambda e: errors.append(str(e)))
    def route(request):
        url = request.request.url
        if 'task-console' in url and '/client.js' in url:
            loaded.append('client'); request.fulfill(path=str(ASSETS/'client.js'),content_type='text/javascript'); return
        if 'task-console' in url and '/client-heavy.js' in url:
            loaded.append('heavy'); request.fulfill(path=str(ASSETS/'client-heavy.js'),content_type='text/javascript'); return
        if url.endswith('/api/taskConsole/agentActionOptions'):
            body = request.request.post_data_json
            q = json.loads(body['payload']['args']['payload'])
            result = {'ok':False,'error':{'code':'internal','message':'候选 MCP 尚未就绪；测试手填 IP','details':{}}} if q['parameter']=='ip' else {
                'ok':True,'value':json.dumps({'items':[account],'page':1,'pages':1,'total':1})}
            request.fulfill(json={'type':'server-response','rpcId':body['rpcId'],'result':result}); return
        if any(s in url for s in ['launchTaskAction','launchWorkflow','session.prompt','session.create','startAgentSession','saveTask','saveAgent','fireTask','agentPreset.select']):
            if url.endswith('/api/taskConsole/launchTaskAction'):
                body = request.request.post_data_json
                submissions.append(json.loads(body['payload']['args']['payload']))
                request.fulfill(json={'type':'server-response','rpcId':body['rpcId'],'result':{'ok':False,'error':{'code':'internal','message':'测试拦截：未创建执行、未操作目标机器','details':{}}}})
            else:
                errors.append('unexpected-business-write'); request.abort()
            return
        request.continue_()
    page.route('**/*',route)
    c = page.locator('textarea[data-phase]').first
    popup = page.get_by_role('region',name='Action 参数候选',exact=True)
    def selected(value):
        page.wait_for_function('(v)=>{let e=document.querySelector("textarea[data-phase]");return e&&e.value.slice(e.selectionStart,e.selectionEnd)===v}',arg=value,timeout=15000)
    try:
        page.goto(BASE+'/?session='+SESSION,wait_until='domcontentloaded')
        expect(c).to_be_visible(timeout=60000)
        c.fill('@'+TASK+'/')
        action = page.get_by_role('option').filter(has=page.get_by_text('装机与账号验收',exact=True))
        expect(action).to_be_visible(timeout=30000); action.click(); selected('【机器 IP】')
        expect(popup).to_contain_text('测试手填 IP',timeout=30000)
        c.press_sequentially('79.72.76.64'); c.press('Enter'); selected('【SSH 接入方式】')
        c.press('Enter'); selected('【账号选择】')
        popup.get_by_role('option',name='指定账号',exact=True).click(); selected('【金库账号】')
        c.press_sequentially(account['label']); c.press('Enter'); c.press('Enter')
        page.wait_for_timeout(1500)
        assert len(submissions)==1, 'manual email never reached the guarded submission'
        assert submissions[0]['values']['ip']=='79.72.76.64'
        assert submissions[0]['values']['account']==account['value']
        draft = c.input_value()
        # A pasted filled prompt, including a trailing newline in IP, must also work after reload.
        pasted = draft.replace('79.72.76.64','79.72.76.64\n')
        page.reload(wait_until='domcontentloaded'); expect(c).to_be_visible(timeout=60000)
        c.fill(pasted)
        c.press('Enter')
        expect(c).to_have_attribute('data-phase','claimed',timeout=30000)
        c.press('Enter')
        for _ in range(100):
            if len(submissions)>1: break
            page.wait_for_timeout(100)
        assert len(submissions)==2, 'pasted prompt did not restore complete field positions'
        assert submissions[1]['values']['ip']=='79.72.76.64'
        assert submissions[1]['values']['account']==account['value']
        page.screenshot(path=str(EVIDENCE/'task-action-manual-input.png'))
        assert 'client' in loaded and 'heavy' in loaded and not errors, (loaded,errors)
        print('PASS: staged public UI; candidate outage does not block manual IP; typed email resolves to exact accountId; pasted prompt restores fields; ALL submissions intercepted, NO target operations.')
    except Exception:
        page.screenshot(path=str(EVIDENCE/'task-action-manual-input-failure.png'))
        print('diagnostic',json.dumps({'assets':loaded,'errors':errors,'intercepted':len(submissions)},ensure_ascii=False))
        raise
    finally:
        if c.count() and c.is_visible(): c.fill('')
        browser.close()
assert read('sessionTurns',{'sessionId':SESSION})['totals']==before
assert read('taskActions',{'taskId':TASK})==catalog
