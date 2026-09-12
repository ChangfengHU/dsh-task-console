import type { ActionOptionPage } from '../action-options.ts'

/** A small list beside the native composer, not a second input/form. */
export function actionOptionPopup(field: () => HTMLTextAreaElement | undefined, pick: (value: string) => void, paginate: (page: number) => void) {
  let root: HTMLDivElement | undefined, data: ActionOptionPage = { items: [], page: 1, pages: 1, total: 0 }, chosen = -1
  let title = '', status = ''
  const hide = () => { root?.remove(); root = undefined; chosen = -1 }
  const position = () => {
    const el = field()
    if (!root || !el) return
    const rect = el.getBoundingClientRect(), width = Math.min(480, window.innerWidth - 24)
    root.style.width = `${width}px`
    root.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`
    root.style.bottom = `${Math.max(12, window.innerHeight - Math.max(rect.top - 8, 230))}px`
    root.style.maxHeight = `${Math.min(310, window.innerHeight - 32)}px`
  }
  const paint = () => {
    if (!field()) return
    if (!root) { root = document.createElement('div'); root.className = 'dtc-root dtc-action-options'; root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Action 参数候选'); document.body.append(root) }
    root.replaceChildren()
    const heading = document.createElement('div'); heading.className = 'dtc-action-options-heading'; heading.setAttribute('role', 'status'); heading.textContent = `${title} · ${status || '输入筛选 · ↑↓ 选择 · Enter 确认'}`; root.append(heading)
    const list = document.createElement('div'); list.className = 'dtc-action-options-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', `${title}候选`); root.append(list)
    data.items.forEach((item, i) => {
      const row = document.createElement('button'); row.type = 'button'; row.tabIndex = -1; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === chosen)); row.setAttribute('aria-disabled', String(!!item.disabled)); row.disabled = !!item.disabled
      const label = document.createElement('span'); label.textContent = item.label; row.append(label)
      if (item.detail) { const detail = document.createElement('small'); detail.textContent = item.detail; row.append(detail) }
      row.addEventListener('mousedown', e => e.preventDefault())
      row.addEventListener('click', () => { if (!item.disabled) pick(item.value) }); list.append(row)
    })
    if (!data.items.length) { const empty = document.createElement('p'); empty.textContent = status || '没有匹配候选'; list.append(empty) }
    if (status && status !== '正在读取候选…') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'dtc-action-options-nav'; retry.textContent = '重试读取'; retry.addEventListener('mousedown', e => e.preventDefault()); retry.onclick = () => paginate(1); root.append(retry)
    }
    if (data.pages > 1) {
      const nav = document.createElement('div'); nav.className = 'dtc-action-options-nav'; nav.textContent = `${data.page}/${data.pages} · ${data.total} 项 `
      for (const [label, page] of [['上一页', data.page - 1], ['下一页', data.page + 1]] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = page < 1 || page > data.pages; button.addEventListener('mousedown', e => e.preventDefault()); button.onclick = () => paginate(page); nav.append(button)
      }
      root.append(nav)
    }
    if (data.notice) { const note = document.createElement('small'); note.className = 'dtc-action-options-note'; note.textContent = data.notice; root.append(note) }
    position(); list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }
  return {
    hide, position,
    show: (label: string, page: ActionOptionPage, message = '') => { title = label; data = page; status = message; chosen = -1; paint() },
    move: (direction: number) => { if (!root || !data.items.length) return false; let i = chosen; for (let n = 0; n < data.items.length; n++) { i = (i + direction + data.items.length) % data.items.length; if (!data.items[i].disabled) { chosen = i; paint(); return true } } return true },
    selected: () => root && chosen >= 0 && !data.items[chosen]?.disabled ? data.items[chosen]?.value : undefined,
    visible: () => !!root,
  }
}
