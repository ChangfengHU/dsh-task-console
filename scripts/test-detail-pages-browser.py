"""Read-only candidate/public acceptance: no task firing or machine mutation."""
import json
import os
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('DTC_TEST_BASE', 'https://dsh.vyibc.com')
ASSET = os.environ.get('DTC_TEST_ASSET')
PREVIEW = os.environ.get('DTC_TEST_PREVIEW')
TASK = 'T-chat-bbb714b2ba8439b69178'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors, sizes, cache_status = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('response', lambda r: cache_status.append(r.headers.get('x-dsh-asset-cache','NONE')) if '/plugins/' in r.url and 'client.js' in r.url else None)
    def guard(route):
        req = route.request
        method = req.url.split('/api/')[-1].split('?')[0]
        if method.startswith('taskConsole/') and method.split('/')[-1] in ['taskGraph','taskSnapshot','sessionTurns']:
            if PREVIEW:
                r = urllib.request.Request(PREVIEW, data=req.post_data.encode(), headers={'content-type':'application/json'})
                body = urllib.request.urlopen(r, timeout=30).read()
                sizes.append((method, len(body)))
                route.fulfill(body=body, content_type='application/json'); return
        if any(x in method for x in ['fireTask','launchWorkflow','delete','cancelRun','setBatch','session.prompt','session.create','saveAgent']):
            route.abort(); return
        route.continue_()
    page.route('**/api/**', guard)
    if ASSET: page.route('**/dsh-task-console/client-heavy.js*',lambda r:r.fulfill(path=ASSET,content_type='text/javascript'))
    start=time.monotonic()
    page.goto(BASE+'/?session=agent-task-create-agent-muaqlhtv#/tc/tasks/'+TASK,wait_until='domcontentloaded',timeout=60000)
    page.locator('.dtc-compact').wait_for(timeout=60000)
    print('detail_visible_seconds',round(time.monotonic()-start,2),flush=True)
    print('slow_resources',page.evaluate('performance.getEntriesByType("resource").sort((a,b)=>b.duration-a.duration).slice(0,8).map(x=>({path:new URL(x.name).pathname,ms:Math.round(x.duration)}))'),flush=True)
    play=page.locator('.dtc-replay-actions .play')
    expect(play).to_be_enabled(timeout=60000)
    page.get_by_role('button',name='从头',exact=True).click()
    expect(page.locator('.dtc-session-trigger i')).to_have_text('0')
    expect(page.locator('.dtc-replay-range output')).to_have_text('0')
    page.get_by_role('button',name='→',exact=True).click()
    expect(page.locator('.dtc-replay-range output')).to_have_text('1')
    play.click(); page.wait_for_timeout(1100); play.click()
    assert int(page.locator('.dtc-replay-range output').inner_text())>=2
    page.get_by_role('button',name='● 回到实时',exact=True).click()
    page.locator('.dtc-session-trigger').click()
    expect(page.locator('.dtc-session-drawer')).to_be_visible()
    page.locator('.dtc-session-drawer').get_by_role('button',name='Trace',exact=True).first.click()
    expect(page.get_by_role('navigation',name='Trace 分页')).to_be_visible(timeout=30000)
    assert page.locator('.dtc-step-row').count() <= 10
    page.keyboard.press('Escape')
    page.screenshot(path='/tmp/dtc-detail-paged-browser.png',animations='disabled')
    assert not errors,errors
    print(json.dumps({'result':'passed','rpc_sizes':sizes,'page_errors':errors,'plugin_cache':{k:cache_status.count(k) for k in set(cache_status)}}),flush=True)
    browser.close()
