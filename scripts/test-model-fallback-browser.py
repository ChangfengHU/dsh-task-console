"""Inspect the real repaired Task run without issuing any machine operation."""
import os, json
from playwright.sync_api import sync_playwright, expect

batch = os.environ.get('DSH_VERIFY_BATCH', 'b-chat-48a47c2f21fe61a23551')
url = 'https://dsh.vyibc.com/#/tc/tasks/T-chat-b4c6fcb369f0c20a9739/runs/' + batch
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1440,'height':1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url, wait_until='domcontentloaded', timeout=60000)
    expect(page.get_by_text('Fleet 基础节点幂等接入与 Gemini 账号验收', exact=True).first).to_be_visible(timeout=90000)
    expect(page.get_by_text('fleet-installer', exact=True).first).to_be_visible(timeout=30000)
    slider = page.locator('input[type="range"]').first
    slider.fill('10')
    expect(page.get_by_text('主模型启动失败，切换备用模型', exact=True)).to_be_visible(timeout=15000)
    page.locator('details.dtc-compact-event summary').click()
    expect(page.get_by_text('codex-local → deepseek-official/qwen-plus-latest', exact=True)).to_be_visible(timeout=10000)
    page.screenshot(path='/tmp/dsh-model-fallback-run-1440.png')
    text = page.locator('body').inner_text()
    print(json.dumps({'url':url,'pageErrors':errors,'visibleWorkflow': 'fleet-runner-operator' in text and 'browser-manager' in text,
                      'fallbackVisible':'codex-local → deepseek-official/qwen-plus-latest' in text},ensure_ascii=False),flush=True)
    assert not errors
    browser.close()
