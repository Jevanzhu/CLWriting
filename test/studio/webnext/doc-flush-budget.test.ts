/**
 * R44-2（四十四轮）静态防回归闸：渲染层保存链上不得再出现同步 XHR。
 *
 * 契约演进：原「杂项② flushSyncOnUnload 同步落盘总预算（2s）」测试随 V-P1-2 同步
 * XHR 兜底一并移除——Chromium ≥M80 在页面卸载路径整体禁同步 XHR（beforeunload 内
 * send() 同步抛 NetworkError、请求零字节到达，双 Electron 实验实证，四十四轮报告
 * §3.1），「预算内串行同步 PUT」在真实引擎下根本不存在，预算语义随之失去主体。
 * 关窗/退出兜底改主进程 close/before-quit 拦截 + 渲染层 flushBeforeClose 异步钩子
 *（行为面见 doc.test.ts / main.test.ts R44-2 用例与 r44-close-flush-electron 实机
 * 回归）。本文件留静态守卫：doc store 再引入 XMLHttpRequest 即红——它在这个 store
 * 的历史上只有同步卸载兜底一种用途，任何回归形态都应走异步保存链。
 */
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const docTs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../src/studio/web-next/src/stores/doc.ts'),
  'utf-8',
)

test('R44-2: doc store 源码不含 XMLHttpRequest（同步卸载兜底不得回归）', () => {
  expect(docTs).not.toContain('XMLHttpRequest')
  // 主进程钩子契约在位（close/before-quit 拦截的渲染层调用面）
  expect(docTs).toContain('flushBeforeClose')
})
