/**
 * R40-1（四十轮）回归：平台块 × 主题层 CSS 级联结构不变式（静态扫描锚）。
 *
 * 缺陷：--text-normal: #2e2e2e 定义在 :root[data-platform='win32']（特异度 0,2,0）
 * 内恒压过 [data-theme='dark']（0,1,0）的 #dadada——win+暗色组合正文近黑贴暗底
 * 不可读（两属性同挂 html 根：main.ts 挂 data-platform / prefs.ts 挂 data-theme）。
 * browser/e2e 从不注入 data-platform（结构性测试盲区，渲染层测不到该组合），故用
 * 文本断言钉住结构不变式：平台块只许放结构性变量（字体族/字号档），色板归主题层
 * 独占；win 亮色 ClearType 微调必须带 :not([data-theme='dark']) 守卫（暗色下规则
 * 整体不命中，主题层接管）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cssPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'src', 'studio', 'web-next', 'src', 'styles', 'tokens.css',
)
const css = readFileSync(cssPath, 'utf-8')

/** 取选择器（字面量）首个规则块体——tokens.css 无嵌套规则；用「行首选择器」定位，
 *  防 :not([data-theme='dark']) 守卫规则里的子串误命中（R40-1 修复引入的新规则恰好
 *  包含同形子串，indexOf 裸找会拿错块）。 */
function ruleBody(sel: string): string | null {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`^${esc}\\s*\\{`, 'm'))
  if (!m) return null
  const open = css.indexOf('{', m.index!)
  const close = css.indexOf('}', open)
  if (open === -1 || close === -1) return null
  return css.slice(open + 1, close)
}

/** 色板变量前缀族——平台块内不得出现（结构性变量白名单外的一切 --text/--background 等） */
const PALETTE_DECL = /^\s*--(text|background|interactive|cat|shadow|dv|div|seq)-/m

describe('R40-1: 平台块 × 主题层级联矩阵（tokens.css 结构不变式）', () => {
  it('win32 平台块只含结构性变量（字体族/字号档），无任何色板变量', () => {
    const body = ruleBody(":root[data-platform='win32']")
    expect(body).not.toBeNull()
    expect(body!).not.toMatch(PALETTE_DECL)
    // 结构性白名单仍在位（J5 段语义不回归）
    expect(body!).toMatch(/--font-ui:/)
    expect(body!).toMatch(/--font-size-step:/)
  })

  it('darwin 平台块同口径（只含字体族）', () => {
    const body = ruleBody(":root[data-platform='darwin']")
    expect(body).not.toBeNull()
    expect(body!).not.toMatch(PALETTE_DECL)
  })

  it('win 亮色文字微调存在于 :not([data-theme=dark]) 守卫规则内（暗色下不命中）', () => {
    const guarded = ":root[data-platform='win32']:not([data-theme='dark'])"
    const body = ruleBody(guarded)
    expect(body).not.toBeNull()
    // 守卫规则里正是 --text-normal:#2e2e2e（win 亮色 ClearType 提亮，J5 原注迁移）
    expect(body!).toMatch(/--text-normal:\s*#2e2e2e/)
  })

  it('暗色主题块独立定义 --text-normal（主题层色板自足，不依赖平台块让位）', () => {
    const body = ruleBody("[data-theme='dark']")
    expect(body).not.toBeNull()
    expect(body!).toMatch(/--text-normal:\s*#dadada/)
  })
})
