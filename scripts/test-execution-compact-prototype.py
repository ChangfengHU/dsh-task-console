"""V2 only: preserve original drawer/plan, enforce a single viewport. No APIs."""
import os
import json
import time
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('DSH_PROTOTYPE_URL', 'http://127.0.0.1:18765/task-execution-compact-v2.html')

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page()
    errors,requests=[],[]
    context.on('request',lambda r:requests.append((r.method,r.url)))
    page.on('pageerror',lambda e:errors.append(str(e)))
    def one_screen():
        size=page.evaluate('({h:innerHeight,w:innerWidth,sh:document.documentElement.scrollHeight,sw:document.documentElement.scrollWidth})')
        assert size['sh']<=size['h']+1 and size['sw']<=size['w']+1, size
        assert page.locator('#workspace').bounding_box()['height']>130
    start=time.monotonic()
    assert page.goto(URL,wait_until='load',timeout=60000).status==200
    ms=round((time.monotonic()-start)*1000)
    expect(page.locator('.node')).to_have_count(3)
    expect(page.locator('#detail-name')).to_have_text('装机者')
    one_screen()
    assert page.locator('#workspace').bounding_box()['y']<270
    assert page.locator('#utility-content').is_hidden()
    page.screenshot(path='/tmp/dtc-compact-v2-desktop.png',animations='disabled')

    page.get_by_role('button',name='查看协作计划',exact=True).click()
    expect(page.locator('#plan-body')).to_be_visible()
    assert not page.locator('#modal').is_visible()
    expect(page.locator('.plan-roles li')).to_have_count(3)
    one_screen()
    page.screenshot(path='/tmp/dtc-compact-v2-plan.png',animations='disabled')
    page.get_by_role('tab',name='本次输入',exact=True).click()
    expect(page.locator('#plan-content')).to_contain_text('本次 Action 快照')
    expect(page.locator('#plan-content')).to_contain_text('本次用户请求')
    page.get_by_role('tab',name='计划 JSON',exact=True).click()
    expect(page.locator('#plan-content')).to_contain_text('"timeoutSec": 7200')
    assert page.locator('#plan-body').evaluate('(e)=>e.scrollHeight>e.clientHeight')
    one_screen()
    page.get_by_role('button',name='收起计划',exact=True).click()

    position=page.locator('#cursor').input_value()
    page.get_by_role('button',name='Sessions',exact=False).first.click()
    drawer=page.locator('#sessions-drawer')
    expect(drawer).to_be_visible()
    box=drawer.bounding_box()
    assert abs(box['x']+box['width']-1440)<2 and box['height']==1000
    expect(page.locator('#sessions-body')).to_contain_text('创建 / 编排 · 不计入执行节点')
    expect(page.locator('#sessions-body .session-row')).to_have_count(2)
    page.screenshot(path='/tmp/dtc-compact-v2-sessions.png',animations='disabled')
    page.locator('#sessions-body [data-trace-session="demo-installer-01"]').last.click()
    expect(page.locator('#sessions-title')).to_have_text('Session Trace')
    page.locator('#drawer-trace-filter').select_option('LLM')
    expect(page.locator('#drawer-trace-list details:visible')).to_have_count(1)
    page.locator('#drawer-trace-list details:visible summary').click()
    expect(page.locator('#drawer-trace-list details:visible')).to_contain_text('返回 / 输出')
    with context.expect_page() as opened:
        page.get_by_role('link',name='打开原会话',exact=False).click()
    preview=opened.value
    preview.on('pageerror',lambda e:errors.append(str(e)))
    preview.wait_for_load_state()
    expect(preview.locator('.session-preview')).to_contain_text('装机者 · 会话预览')
    assert not any(method!='GET' for method,url in requests)
    preview.close()
    page.get_by_role('button',name='返回 2 Sessions',exact=False).click()
    expect(page.locator('#sessions-title')).to_have_text('Related Sessions')
    page.get_by_role('button',name='关闭 Sessions',exact=True).click()
    assert page.locator('#cursor').input_value()==position

    for section in ['report','events','boundary']:
        page.locator('[data-section="'+section+'"]').click()
        expect(page.locator('#utility-content')).to_be_visible()
        one_screen()
        if section=='boundary':
            expect(page.locator('#utility-content')).to_contain_text('120 分钟 / 角色')
            expect(page.locator('#utility-content')).to_contain_text('角色权限')
            expect(page.locator('#utility-content')).to_contain_text('验收条件')
            page.screenshot(path='/tmp/dtc-compact-v2-boundary.png',animations='disabled')
        page.locator('[data-section="'+section+'"]').click()
        expect(page.locator('#utility-content')).to_be_hidden()
    page.locator('[data-section="events"]').click()
    page.locator('#utility-content [data-frame="1"]').click()
    expect(page.locator('.node')).to_have_count(1)
    expect(page.locator('.edge')).to_have_count(0)
    page.get_by_role('button',name='最新',exact=True).click()
    expect(page.locator('.edge')).to_have_count(2)
    page.locator('[data-section="events"]').click()

    page.get_by_role('button',name='全屏协作流程',exact=True).click()
    page.get_by_role('button',name='查看浏览器管理员详情',exact=True).click()
    expect(page.locator('#detail-name')).to_have_text('浏览器管理员')
    page.screenshot(path='/tmp/dtc-compact-v2-fullscreen.png',animations='disabled')
    page.get_by_role('button',name='查看装机者详情',exact=True).click()
    page.locator('#detail-body [data-trace-session]').click()
    expect(drawer).to_be_visible()
    page.keyboard.press('Escape')
    assert page.locator('#workspace').evaluate('(e)=>e.classList.contains("expanded")')
    page.keyboard.press('Escape')
    assert not page.locator('#workspace').evaluate('(e)=>e.classList.contains("expanded")')

    for state,text in [('observing','执行中'),('blocked','未通过'),('done','已通过')]:
        page.locator('#scenario').select_option(state)
        expect(page.locator('#overall')).to_contain_text(text)
    page.locator('#speed').select_option('625')
    page.get_by_role('button',name='自动播放',exact=True).click()
    expect(page.locator('#cursor')).to_have_value('10',timeout=12000)
    page.get_by_role('button',name='执行报告',exact=False).first.click()
    expect(page.locator('#utility-content')).to_contain_text('本次验收通过')
    with page.expect_download() as d:
        page.locator('#utility-content #download').click()
    d.value.delete()
    page.locator('#toast').evaluate('(e)=>e.hidden=true')
    page.locator('[data-section="report"]').click()
    page.locator('#scenario').select_option('running')

    for width,height in [(1366,768),(1920,1080),(390,844),(390,667),(844,390)]:
        page.set_viewport_size({'width':width,'height':height})
        one_screen()
        page.locator('[data-section="boundary"]').click()
        one_screen()
        page.locator('[data-section="boundary"]').click()
        if width==390 and height==844:
            page.screenshot(path='/tmp/dtc-compact-v2-mobile.png',animations='disabled')
            page.get_by_role('button',name='Sessions',exact=False).first.click()
            expect(drawer).to_be_visible()
            one_screen()
            page.screenshot(path='/tmp/dtc-compact-v2-mobile-sessions.png',animations='disabled')
            page.get_by_role('button',name='关闭 Sessions',exact=True).click()
            page.get_by_role('button',name='查看协作计划',exact=True).click()
            one_screen()
            page.get_by_role('button',name='收起计划',exact=True).click()
    page.set_viewport_size({'width':1440,'height':1000})
    page.get_by_role('button',name='切换深浅主题',exact=True).click()
    page.screenshot(path='/tmp/dtc-compact-v2-dark.png',animations='disabled')
    assert not errors,errors
    assert all(method=='GET' and url.split('?')[0].split('#')[0]==URL.split('?')[0].split('#')[0] for method,url in requests), requests
    browser.close()
    print(json.dumps({'status':'PASS','loadMs':ms,'checks':['single viewport at six sizes','bounded internal scrolling','original inline plan + three tabs','right Sessions drawer + creator grouping','Trace filters + I/O','open session in isolated demo tab','drawer close retains replay cursor','fullscreen retains inspector and drawer','report/events/boundaries retained','canonical event replay','autoplay','states','download cleanup','dark theme','no API or external subresources','no page errors']},ensure_ascii=False))
