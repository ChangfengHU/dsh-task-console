"""Read-only browser acceptance of the standalone, fictional execution prototype.

Reuse installed Playwright/Chrome. Start a loopback static server or set
DSH_PROTOTYPE_URL to the published standalone HTML. No production API is used.
"""
import os
import json
import time
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('DSH_PROTOTYPE_URL', 'http://127.0.0.1:18765/task-execution-focus-v1.html')
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors, network = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: network.append((r.method,r.url)))
    start = time.monotonic()
    response = page.goto(URL, wait_until='load', timeout=60000)
    assert response.status == 200
    visible_ms = round((time.monotonic()-start)*1000)
    expect(page.locator('.node')).to_have_count(3)
    expect(page.locator('#detail-name')).to_have_text('浏览器管理员')
    expect(page.locator('#detail-body')).to_contain_text('8 / 20 分钟')
    assert page.locator('#workspace').bounding_box()['y'] < 240
    assert page.locator('.node').first.bounding_box()['y'] < 600
    page.screenshot(path='/tmp/dtc-focus-prototype-desktop.png', animations='disabled')
    page.get_by_role('button', name='查看装机者详情', exact=True).click()
    expect(page.locator('#detail-name')).to_have_text('装机者')
    page.get_by_role('tab', name='Trace', exact=True).click()
    page.locator('#trace-filter').select_option('LLM')
    expect(page.locator('#trace-list details:visible')).to_have_count(1)
    page.locator('#trace-list details:visible summary').click()
    expect(page.locator('#trace-list details:visible')).to_contain_text('返回 / 输出')
    page.get_by_role('tab', name='数据', exact=True).click()
    expect(page.locator('#detail-body')).to_contain_text('demo-card-0')
    page.get_by_role('button', name='全屏协作流程', exact=True).click()
    expect(page.locator('#workspace')).to_have_class('workspace detail-open expanded')
    page.get_by_role('button', name='查看浏览器管理员详情', exact=True).click()
    expect(page.locator('#detail-name')).to_have_text('浏览器管理员')
    expect(page.locator('#detail-body')).to_contain_text('demo-card-2')
    page.get_by_role('tab', name='进展', exact=True).click()
    page.screenshot(path='/tmp/dtc-focus-prototype-fullscreen.png', animations='disabled')
    page.keyboard.press('Escape')
    assert not page.locator('#workspace').evaluate('(e)=>e.classList.contains("expanded")')
    page.get_by_role('button', name='回到第一步', exact=True).click()
    expect(page.locator('.node')).to_have_count(0)
    for n in range(1,6):
        page.get_by_role('button', name='下一步', exact=True).click()
        expect(page.locator('.node')).to_have_count(min(3,n))
        expect(page.locator('.edge')).to_have_count(max(0,n-3))
    page.get_by_role('button', name='最新', exact=True).click()
    expect(page.locator('.node')).to_have_count(3)
    page.locator('#scenario').select_option('blocked')
    expect(page.locator('#overall')).to_contain_text('未通过')
    expect(page.locator('#detail-body')).to_contain_text('没有覆盖账号')
    page.get_by_role('button', name='验收与结果', exact=False).click()
    expect(page.locator('#modal')).to_contain_text('本次验收未通过')
    page.get_by_role('button', name='关闭弹窗', exact=True).click()
    page.locator('#scenario').select_option('done')
    page.get_by_role('button', name='验收与结果', exact=False).click()
    expect(page.locator('#modal')).to_contain_text('本次验收通过')
    page.get_by_role('button', name='View', exact=True).click()
    expect(page.locator('#modal-title')).to_contain_text('HTML 报告')
    page.get_by_role('button', name='返回验收与结果', exact=True).click()
    with page.expect_download() as download:
        page.get_by_role('button', name='下载', exact=True).click()
    assert download.value.suggested_filename == 'demo-fleet-acceptance.json'
    download.value.delete()
    page.get_by_role('button', name='关闭弹窗', exact=True).click()
    page.get_by_role('button', name='会话', exact=False).first.click()
    expect(page.locator('#modal [data-session]')).to_have_count(3)
    page.locator('[data-session="runner"]').click()
    expect(page.locator('#modal-title')).to_contain_text('Runner 运维者')
    page.get_by_role('button', name='查看对应 Trace', exact=True).click()
    expect(page.get_by_role('tab', name='Trace', exact=True)).to_have_attribute('aria-selected','true')
    page.locator('#speed').select_option('625')
    page.get_by_role('button', name='回到第一步', exact=True).click()
    page.get_by_role('button', name='自动播放', exact=True).click()
    expect(page.locator('#cursor')).to_have_value('10', timeout=12000)
    expect(page.get_by_role('button', name='自动播放', exact=True)).to_be_visible()
    page.locator('#execution').select_option('previous')
    expect(page.locator('#run-code')).to_have_text('#DEMO21')
    page.locator('#execution').select_option('current')
    page.get_by_role('button', name='切换深浅主题', exact=True).click()
    expect(page.locator('html')).to_have_attribute('data-theme','dark')
    page.get_by_role('tab', name='进展', exact=True).click()
    page.screenshot(path='/tmp/dtc-focus-prototype-dark.png', animations='disabled')
    page.get_by_role('button', name='切换深浅主题', exact=True).click()
    page.set_viewport_size({'width':390,'height':844})
    page.locator('#workspace').evaluate('(e)=>e.classList.remove("detail-open")')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile page overflow'
    page.screenshot(path='/tmp/dtc-focus-prototype-mobile.png', animations='disabled')
    page.get_by_role('button', name='适配', exact=True).click()
    assert page.locator('.node').last.bounding_box()['x'] < 390, 'fit must bring all roles into viewport'
    page.get_by_role('button', name='角色详情', exact=False).click()
    expect(page.locator('.inspector')).to_be_visible()
    page.get_by_role('tab', name='Trace', exact=True).click()
    expect(page.locator('#trace-list')).to_be_visible()
    page.screenshot(path='/tmp/dtc-focus-prototype-mobile-detail.png', animations='disabled')
    page.get_by_role('button', name='关闭角色详情', exact=True).click()
    page.get_by_role('button', name='全屏协作流程', exact=True).click()
    page.get_by_role('button', name='角色详情', exact=False).click()
    expect(page.locator('.inspector')).to_be_visible()
    page.get_by_role('button', name='关闭角色详情', exact=True).click()
    page.keyboard.press('Escape')
    assert not errors, errors
    assert all(method == 'GET' and url.split('#')[0] == URL.split('#')[0] for method,url in network), network
    browser.close()
    print(json.dumps({'status':'PASS','initialLoadMs':visible_ms,'checks':['1440px layout','390px overflow','node/detail selection','Trace categories + requests/responses','raw snapshot','fullscreen inspector','database-time replay','blocked/passed reports','HTML preview','JSON download cleanup','session conversations','autoplay','execution switching','dark theme','mobile detail + fullscreen','zero API/subresource requests','zero page errors']}, ensure_ascii=False))
