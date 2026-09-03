/**
 * R43-2（四十三轮）回归：崩溃 tmp 清扫每书 TTL 节流。
 *
 * 修复前每次 detectState（5s 缓存过期后）都在请求路径全树同步扫（.版本 快照目录
 * 成百上千文件，SMB/坚果云卷每文件 statSync 5-50ms → 事件循环冻结数百 ms-秒级）。
 * 修复后每书 6h 至多扫一次——清扫仍发生（tmp 仍被清）但请求路径成本有界。
 * 观察面：5 分钟年龄门槛内的合法 tmp 不会被清（年龄门维持），本测试用「真过期
 * tmp 文件在节流窗内第二次 detectState 后仍在、reset 后被清」锚定节流行为。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState, __resetSweepThrottleForTest } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '节流书', genre: '悬疑' } }
let root = ''

beforeEach(() => {
  __resetSweepThrottleForTest()
  root = mkdtempSync(join(tmpdir(), 'r43-sweep-'))
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个 10 分钟前 mtime 的崩溃 tmp（过 5 分钟年龄门，属可清扫对象）。 */
function plantStaleTmp(name: string): string {
  const p = join(root, '工作区', name)
  writeFileSync(p, 'stale', 'utf8')
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(p, old, old)
  return p
}

test('R43-2: TTL 窗内第二次 detectState 不再全树扫——过期 tmp 保留；reset 后第三次被清', async () => {
  const tmp1 = plantStaleTmp('.stale-a.md.123.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp')
  await detectState(root, SHORT_CONFIG)
  expect(existsSync(tmp1)).toBe(false) // 首扫（节流表空）清扫

  const tmp2 = plantStaleTmp('.stale-b.md.123.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp')
  await detectState(root, SHORT_CONFIG)
  expect(existsSync(tmp2)).toBe(true) // 节流窗内：不再扫，tmp 保留

  __resetSweepThrottleForTest()
  await detectState(root, SHORT_CONFIG)
  expect(existsSync(tmp2)).toBe(false) // 节流复位：清扫仍会发生
})
