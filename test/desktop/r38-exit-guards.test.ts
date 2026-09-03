/**
 * R38-19/R38-20/R38-23/R38-3（三十八轮修复批）回归：
 * - main.ts 退出兜底信号集必须含 SIGTERM（R1W-9 动机面收口——kill 默认信号不再
 *   硬杀跳过 before-quit 优雅停机链）与 unhandledRejection 最后防线（log-only）；
 * - titleBarOverlay 颜色白名单收紧为 CSS 合法位数集合（5/7 位非法 hex 不再放行）；
 * - electron-builder.yml mac 侧 identity 必须为 "-"（真 ad-hoc 密封——R38-3 核实
 *   上游语义：null = 完全跳过签名，"-" 才走 IdentityClass("-") 密封路径）。
 *
 * main.ts 的信号注册在模块加载期对 process.on 生效，测试进程内断言会与全量运行的
 * 其他用例串扰（信号是进程级单例），故按 r30-async-handler-guard 静态守卫先例以
 * 源码契约固化；行为面（hexColor 位数集）由 main.test.ts R74-21 用例扩展覆盖。
 */
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const mainTs = readFileSync(join(root, 'src', 'desktop', 'main.ts'), 'utf-8')
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf-8')

test('R38-19: main.ts 退出兜底信号集含 SIGTERM（与 SIGINT/SIGBREAK 同款 app.quit）', () => {
  expect(mainTs).toContain("process.on('SIGINT', () => app.quit())")
  expect(mainTs).toContain("process.on('SIGBREAK', () => app.quit())")
  expect(mainTs).toContain("process.on('SIGTERM', () => app.quit())")
})

test('R38-23: main.ts 有 unhandledRejection 最后防线（log-only，不退出）', () => {
  expect(mainTs).toContain("process.on('unhandledRejection'")
  // 兜底语义是记录不退出：注册块内不得出现 process.exit
  const idx = mainTs.indexOf("process.on('unhandledRejection'")
  const block = mainTs.slice(idx, mainTs.indexOf('})', idx))
  expect(block).not.toContain('process.exit')
})

test('R38-20: titleBarOverlay hexColor 白名单为 CSS 合法位数集合（3/4/6/8，无 5/7 位漏放）', () => {
  const m = mainTs.match(/const hexColor = (\/\^#\(\?:.*\)\$\/)/)
  expect(m).not.toBeNull()
  const re = new RegExp(m![1]!.slice(1, -1))
  expect(re.test('#f6f')).toBe(true)
  expect(re.test('#f6f6')).toBe(true)
  expect(re.test('#f6f6f6')).toBe(true)
  expect(re.test('#f6f6f6ff')).toBe(true)
  expect(re.test('#12345')).toBe(false)
  expect(re.test('#1234567')).toBe(false)
})

test('R38-3: electron-builder.yml mac identity 为 "-"（真 ad-hoc 密封，非跳签的 null）', () => {
  const macBlock = builderYml.slice(builderYml.indexOf('\nmac:'), builderYml.indexOf('\nwin:'))
  expect(macBlock).toMatch(/^  identity: "-"$/m)
  expect(macBlock).not.toMatch(/^  identity: null$/m)
})
