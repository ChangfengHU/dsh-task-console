"""Static Apps prototype acceptance. Never accesses production DSH APIs."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'file:///home/claude/dsh-task-console/docs/prototypes/apps-v1.html'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    page.get_by_role('button', name='查看详情', exact=False).count()  # card has an accessible compound label
    page.locator('button.card').click()
    page.screenshot(path='/tmp/dsh-apps-overview-v1.png', full_page=True)
    for tab in ['Skills', 'MCP', 'Commands', 'Hooks', 'Contents', 'Overview']:
        page.locator('.tabs button').filter(has_text=tab).click()
        assert page.locator('#tabbody').inner_text().strip()
    page.get_by_role('button', name='安装 App', exact=True).click()
    page.get_by_role('button', name='模拟安装', exact=True).click()
    assert '已安装' in page.locator('.hero + .row').inner_text()
    page.locator('.tabs button').filter(has_text='MCP').click()
    page.locator('.listrow').first.click()
    page.get_by_role('button', name='模拟连接成功', exact=True).click()
    assert '已连接（演示）' in page.locator('.listrow').first.inner_text()
    page.locator('.tabs button').filter(has_text='Skills').click()
    page.get_by_role('textbox', name='搜索 Skill', exact=True).fill('studio-help')
    assert page.locator('#skillrows .listrow').count() == 1
    page.locator('#skillrows .listrow').click()
    page.get_by_role('button', name='排除通用 Agent', exact=True).click()
    assert '显式排除' in page.locator('.modal').inner_text()
    page.keyboard.press('Escape')
    assert page.locator('.modal').count() == 0
    page.get_by_role('button', name='在会话中使用 ↗', exact=True).click()
    assert page.locator('#draft').input_value().startswith('使用卡通视频工作室')
    page.get_by_role('button', name='发送（演示） ↑', exact=True).click()
    assert '原型不发送' in page.locator('.toast').inner_text()
    page.get_by_role('button', name='← 返回 App', exact=True).click()
    page.get_by_role('button', name='管理', exact=True).click()
    page.get_by_role('button', name='卸载…', exact=True).click()
    page.get_by_role('button', name='确认模拟卸载', exact=True).click()
    assert page.get_by_role('button', name='安装 App', exact=True).count() == 1
    page.get_by_role('button', name='← Apps', exact=True).click()
    page.get_by_role('button', name='＋ 添加 App', exact=True).click()
    page.get_by_role('button', name='解析来源 →', exact=True).click()
    assert '安装前检查' in page.locator('.modal').inner_text()
    page.keyboard.press('Escape')
    for width in [1440, 390]:
        page.set_viewport_size({'width': width, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=f'/tmp/dsh-apps-v1-{width}.png', full_page=True)
    page.get_by_role('button', name='切换明暗主题', exact=True).click()
    page.screenshot(path='/tmp/dsh-apps-v1-dark-390.png', full_page=True)
    assert not errors, errors
    browser.close()
print('PASS: tabs, install preview, MCP simulation, Skill policy, draft, uninstall, source parsing, Escape, responsive 1440/390, theme; no JS errors')
