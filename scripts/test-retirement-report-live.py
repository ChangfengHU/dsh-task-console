"""Explicit opt-in: approve a reviewed plan, then click one real Task execution.
Never fabricates offline nodes or calls retirement/WeCom tools directly.
"""
import argparse,json
from playwright.sync_api import sync_playwright,expect

p=argparse.ArgumentParser()
p.add_argument('--plan',required=True)
p.add_argument('--execute',action='store_true')
p.add_argument('--session',required=True)
a=p.parse_args()
if not a.execute: raise SystemExit('Requires --execute: sends one real reviewed Task notification')
task='T-chat-74a2ed1bccbf91f4db88'
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox'])
    try:
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('https://dsh.vyibc.com/?session='+a.session+'#/tc/tasks/plans/'+a.plan,wait_until='domcontentloaded',timeout=60000)
        reason=page.get_by_role('textbox',name='审查意见')
        expect(reason).to_be_visible(timeout=90000)
        reason.fill('已独立核对：同一Task、原两角色/通知群/工具权限，candidates仅用于操作，candidates+deferred用于完整报告；空候选有限收口，未知不算在线。保留历史，定时不启用；本次从页面手动验收通知。')
        page.get_by_role('checkbox').check()
        with page.expect_response(lambda r:'/reviewTaskPlan' in r.url,timeout=60000) as response:
            page.get_by_role('button',name='批准计划，等待手动验收',exact=True).click()
        body=response.value.json()
        assert body.get('result',{}).get('ok'),body
        reviewed=json.loads(body['result']['value'])
        assert reviewed['state']=='awaiting_trial',reviewed['state']
        print(json.dumps({'review':{'id':reviewed['id'],'state':reviewed['state'],'taskId':reviewed['taskId']}}),flush=True)
        page.goto('https://dsh.vyibc.com/?session='+a.session+'#/tc/tasks',wait_until='domcontentloaded',timeout=60000)
        heading=page.get_by_text('Fleet 连续离线节点自动退役与企微通知',exact=True)
        expect(heading.first).to_be_visible(timeout=90000)
        # Select only the card containing this exact title, never another Task.
        card=heading.first.locator('xpath=ancestor::*[.//button[normalize-space()="立即执行"]][1]')
        with page.expect_response(lambda r:'/fireTask' in r.url,timeout=60000) as response:
            card.get_by_role('button',name='立即执行',exact=True).click()
        body=response.value.json()
        assert body.get('result',{}).get('ok'),body
        receipt=json.loads(body['result']['value'])
        print(json.dumps({'execution':receipt,'errors':errors}),flush=True)
        page.get_by_role('button',name='全屏 DAG',exact=True).wait_for(timeout=90000)
        page.screenshot(path='/tmp/dsh-retirement-report-start.png')
        assert not errors,errors
    finally:
        browser.close()
