"""Read-only public UI acceptance for configuration migration. Does not export or import."""
from playwright.sync_api import sync_playwright

URL = 'https://dsh-152-32-214-95.vyibc.com/?v=0.31.0#/tc/tasks/migration'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for width in (1440, 390):
        page = browser.new_page(viewport={'width': width, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL, wait_until='domcontentloaded', timeout=60000)
        page.get_by_role('heading', name='配置迁移', exact=True).wait_for(timeout=60000)
        assert page.get_by_role('button', name='生成并上传到 R2', exact=True).is_enabled()
        field = page.get_by_label('R2 配置地址', exact=True)
        field.fill('https://resource.vyibc.com/dsh-task-console/config-exports/example.json')
        assert page.get_by_role('button', name='校验并预览', exact=True).is_enabled()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=f'/tmp/dsh-config-migration-{width}.png', full_page=True)
        assert not errors, errors
        page.close()
    browser.close()
print('PASS: public migration page, export/import controls, desktop/mobile layout, no JS errors; no mutation invoked')
