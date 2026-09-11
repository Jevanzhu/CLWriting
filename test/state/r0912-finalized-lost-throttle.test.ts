/**
 * R0912-9（2026-09-11 重评-0911c 修复批）：finalizedLost 逐条 statSync 每书 TTL 节流。
 *
 * 修复前：healthCheck 每次进门对清单内全部 finalizedRevision 条目逐条 statSync
 * （条目数 = 章数级，SMB/网盘卷每条 5-50ms），5s /state TTL 过期后每轮重付。
 * 修复后：每书 60s TTL（口径对齐同文件 cloudScanCache 纪律），窗内回**上次结果**
 *（fail-closed：持续丢失面在窗内仍可见）。观察面：首次全量探测后，窗内新增的
 * 丢失在下一次 detectState 不可见（statSync 被节流跳过）、reset 节流表后可见。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState, __resetSweepThrottleForTest } from '../../src/state/state.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { computeRevision } from '../../src/document/revision.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

// 注入时钟消除 Date.now() 墙钟漂移（r43-sweep-throttle R0911-G-P1-1c 同款纪律）
vi.useFakeTimers({ toFake: ['Date'] })

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'long', book: { title: 'TTL书', genre: '悬疑' } }

let root = ''
const docId = 'doc_ttl_lost'

beforeEach(() => {
  __resetSweepThrottleForTest()
  root = join(tmpdir(), 'r0912-ttl-')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '布线'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  const body = join(root, '写作', '正文', '0001-开篇.md')
  writeFileSync(body, '---\n章号: 1\n标题: 开篇\n---\n\n正文。\n', 'utf-8')
  const m = readManifest(join(root, '项目', '文档清单.jsonl'))
  upsertEntry(m, {
    id: docId,
    nodeType: 'document',
    path: '写作/正文/0001-开篇.md',
    parentId: null,
    finalizedRevision: computeRevision(body),
    finalizedAt: new Date().toISOString(),
  })
  writeManifest(join(root, '项目', '文档清单.jsonl'), m)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function lostIssue(d: Awaited<ReturnType<typeof detectState>>): boolean {
  return d.state === 1 && d.issues.some((i) => i.kind === 'finalizedLost')
}

test('R0912-9: TTL 窗内新增的定稿丢失不可见（statSync 被节流跳过），reset 后可见', async () => {
  // 首次进门：文件在盘 → 无 finalizedLost，节流表落键（此刻起 60s 内跳过逐条探测）
  const d0 = await detectState(root, SHORT_CONFIG)
  expect(lostIssue(d0)).toBe(false)

  // 窗内文件被外部删除 → 第二次 detectState 不再逐条 statSync → 丢失不可见（节流生效）
  unlinkSync(join(root, '写作', '正文', '0001-开篇.md'))
  expect(existsSync(join(root, '写作', '正文', '0001-开篇.md'))).toBe(false)
  const d1 = await detectState(root, SHORT_CONFIG)
  expect(lostIssue(d1)).toBe(false)

  // 复位节流表 → 下次进门重付全量探测 → 丢失如实可见（fail-closed 方向不丢信号）
  __resetSweepThrottleForTest()
  const d2 = await detectState(root, SHORT_CONFIG)
  expect(lostIssue(d2)).toBe(true)
})

test('R0912-9: TTL 窗内回上次结果——窗内已报红的丢失在窗内持续可见（fail-closed）', async () => {
  // 首次进门即丢失 → 报红 + 节流表记录「有丢失」
  unlinkSync(join(root, '写作', '正文', '0001-开篇.md'))
  const d0 = await detectState(root, SHORT_CONFIG)
  expect(lostIssue(d0)).toBe(true)

  // 窗内作者恢复了文件（statSync 被节流跳过）→ 仍按上次结果报红（宁多报不漏报，
  // 修复最迟 TTL 过后下一次健康检查可见——cloudScanCache 同款登记取舍）
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n\n正文。\n', 'utf-8')
  const d1 = await detectState(root, SHORT_CONFIG)
  expect(lostIssue(d1)).toBe(true)

  // 复位 → 如实反映恢复
  __resetSweepThrottleForTest()
  const d2 = await detectState(root, SHORT_CONFIG)
  expect(lostIssue(d2)).toBe(false)
})
