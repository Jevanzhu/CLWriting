/**
 * R58-A-2（五十八轮）回归：网盘副本扫描每书 60s TTL 节流。
 *
 * 修复前每次 detectState（/api/state 5s 缓存过期后）都在请求路径全树同步扫
 * （readdirSync 递归 + 逐文件 existsSync 验母本，SMB/坚果云卷每文件 stat 5-50ms →
 * 事件循环冻结数百 ms-秒级）；R43-2 只节流了崩溃 tmp 清扫，本扫描漏网。
 * 修复后每书 60s 至多扫一次——冲突副本残留仍会被检出但请求路径成本有界。
 * 观察面：节流窗内第二次 detectState 不重扫（窗内新出现的副本不可见），reset 后
 * 第三次可见（与 r43-sweep-throttle.test.ts 同构）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState, __resetSweepThrottleForTest } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '节流书', genre: '悬疑' } }
let root = ''

beforeEach(() => {
  __resetSweepThrottleForTest()
  root = mkdtempSync(join(tmpdir(), 'r58-cloud-'))
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个 Dropbox 风格冲突副本（需同名母本共存才算副本，X-P2-20 口径）。 */
function plantCloudCopy(): void {
  writeFileSync(join(root, '写作', '正文', '某章.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '某章 2.md'), '副本内容', 'utf-8')
}

test('R58-A-2: TTL 窗内第二次 detectState 不再全树扫——窗内新副本不可见；reset 后第三次检出', async () => {
  const first = await detectState(root, SHORT_CONFIG)
  expect(first.state).not.toBe(1) // 首扫（节流表空）：树干净 → 非态 1

  plantCloudCopy()
  const second = await detectState(root, SHORT_CONFIG)
  expect(second.state).not.toBe(1) // 节流窗内：不重扫，副本未检出

  __resetSweepThrottleForTest()
  const third = await detectState(root, SHORT_CONFIG)
  expect(third.state).toBe(1) // 节流复位：真实重扫，副本检出
  if (third.state === 1) {
    expect(third.issues.some((i) => i.kind === 'cloudCopy')).toBe(true)
  }
})

test('R1010-P2-2: 已检出副本在节流窗内保持可见——缓存上次结果而非空数组', async () => {
  plantCloudCopy()
  const first = await detectState(root, SHORT_CONFIG)
  expect(first.state).toBe(1) // 首扫即检出：态 1 + cloudCopy 健康项

  const second = await detectState(root, SHORT_CONFIG)
  expect(second.state).toBe(1) // 修复前：窗内回 [] → 健康项消失、态闪烁；修复后：回上次结果持续可见
  if (second.state === 1) {
    expect(second.issues.some((i) => i.kind === 'cloudCopy')).toBe(true)
  }
})