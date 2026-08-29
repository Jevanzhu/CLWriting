/**
 * R74-24（二十二轮 批E）：e2e 渲染层异常 warn 基线。
 *
 * 29 个 spec 此前无 page.on('pageerror')/console error 监听——渲染层未捕获异常
 * （Vue 组件抛错、资源加载失败）不会让用例红，问题被断言偶然通过所掩盖。本轮
 * 修法＝warn 立基线（只告警不红）：异常打到输出供人工/日志排查，待基线噪音摸清
 * 后再评估升级为断言。零断言变化，不改变任何用例的通过判定。
 *
 * 接线约定：各 spec 用例开头（首个 page 动作之前）调
 *   attachPageErrorBaseline(page, '<spec 文件名去 .spec.ts>')
 * specTag 用于多 spec 并行跑时定位异常来源。注意 test.beforeEach 拿不到 page 的
 * 说法不成立（Playwright 的 hook 可注入 fixture，shelf-search 即在 beforeEach 接），
 * 但为统一可读性，常规 spec 一律在用例体首行接。
 */
import type { Page } from '@playwright/test'

/**
 * 挂 pageerror + console error 的 warn 基线（幂等：同一 page 重复挂会重复告警，
 * 各用例只接一次即可）。
 */
export function attachPageErrorBaseline(page: Page, specTag: string): void {
  // 渲染层未捕获异常（window.onerror / unhandledrejection 上抛到 CDP）
  page.on('pageerror', (err) => {
    console.warn(`[e2e-pageerror][${specTag}] ${err.message}`)
  })
  // 页面 console.error（Vue warn 之外的报错日志、资源加载失败等）
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.warn(`[e2e-console-error][${specTag}] ${msg.text()}`)
    }
  })
}
