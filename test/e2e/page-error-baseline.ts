/**
 * e2e 渲染层异常基线（R74-24 立warn → R75-7〔二十三轮 批F〕升级为红）。
 *
 * 29 个 spec 此前无 page.on('pageerror')/console error 监听——渲染层未捕获异常
 * （Vue 组件抛错、资源加载失败）不会让用例红，问题被断言偶然通过所掩盖。
 * R74-24 先立 warn 基线摸噪音；R75-7 全量跑 42 spec 摸底：108 条噪音全部是浏览器
 * 对**预期 4xx**（400/409/404 负路径用例）自动打的「Failed to load resource」日志，
 * pageerror 事件为零——升级条件成熟：
 * - pageerror → 直接 throw（Playwright 将事件监听器内异常记为用例失败）：
 *   渲染层未捕获异常从此红，不再被断言偶然通过掩盖。
 * - pageerror → 直接 throw（Playwright 将事件监听器内异常记为用例失败）：
 *   渲染层未捕获异常从此红，不再被断言偶然通过掩盖。
 * - console error → R29-14（二十九轮批 F）升红：滤除「Failed to load resource:」开头的
 *   资源加载日志（HTTP 语义已由各 spec 对状态码/响应体的显式断言覆盖，属负路径用例的
 *   预期产物，非渲染层缺陷）后，其余真实应用 console.error（Vue 报错、逻辑分支 error
 *   日志）升为用例失败——收集到同一 page 的错误清单，照 pageerror 的升红模式（监听器内
 *   throw，Playwright 记为当前用例失败）在首个应用错误处抛出，消息携带全部已收集条目。
 *   R75-7 摸底时应用级 console.error 为零（108 条噪音全是资源日志），此后新增 spec 由
 *   本门兜底；如现全量跑出新形态预期噪音，按白名单窄化口径在下方 filter 处登记。
 *
 * 接线约定：各 spec 用例开头（首个 page 动作之前）调
 *   attachPageErrorBaseline(page, '<spec 文件名去 .spec.ts>')
 * specTag 用于多 spec 并行跑时定位异常来源。注意 test.beforeEach 拿不到 page 的
 * 说法不成立（Playwright 的 hook 可注入 fixture，shelf-search 即在 beforeEach 接），
 * 但为统一可读性，常规 spec 一律在用例体首行接。
 */
import type { Page } from '@playwright/test'

/**
 * 挂 pageerror（红）+ 应用 console error（滤资源日志后红，R29-14）基线（幂等：同一
 * page 重复挂会重复告警/重复抛，各用例只接一次即可）。
 */
export function attachPageErrorBaseline(page: Page, specTag: string): void {
  // R75-7：渲染层未捕获异常（window.onerror / unhandledrejection 上抛到 CDP）——
  // throw 在监听器内，Playwright 将其记为当前用例失败（此前仅 warn，被掩盖）
  page.on('pageerror', (err) => {
    throw new Error(`[e2e-pageerror][${specTag}] 渲染层未捕获异常：${err.message}`)
  })
  // 页面 console.error——先滤掉浏览器对非 2xx 响应自动打的资源加载日志（预期 4xx
  // 是负路径用例的断言对象，非缺陷；见文件头 R75-7 摸底记录），其余为应用自身错误：
  // R29-14 升红——收集后照 pageerror 模式在监听器内 throw，首个应用错误即用例失败，
  // 错误消息携带本用例已收集的全部应用错误（避免多条报错被首条掩盖）
  const appErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (text.startsWith('Failed to load resource:')) return
    appErrors.push(text)
    throw new Error(
      `[e2e-console-error][${specTag}] 应用自身 console.error（R29-14 升红，共 ${appErrors.length} 条）：\n` +
        appErrors.map((t, i) => `  ${i + 1}. ${t}`).join('\n'),
    )
  })
}

/**
 * 关闭启动通告横幅（startup-notice：repair-books 自愈等）。e2e 全量跑时前序 spec 会
 * 改磁盘 fixture（books.jsonl/正文），后续 spec 的 server 启动触发 repair-books 自愈
 * 通告 → 横幅占位推迟编辑器挂载（单跑 fixture 干净不弹、全量弹——状态差异实证，
 * 三十三轮全量复跑 check/focus/conflict 挂因）。打开书前调用消除横幅版面占位；
 * 无横幅时静默返回（幂等）。
 */
export async function dismissStartupNotices(page: Page): Promise<void> {
  const snClose = page.locator('.sn-close')
  if (await snClose.isVisible({ timeout: 3000 }).catch(() => false)) {
    await snClose.click()
  }
}
