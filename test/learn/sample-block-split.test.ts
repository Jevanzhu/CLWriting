/**
 * R0912-2 P3（2026-09-12 全量重评修复批）回归：learn 样章块切分与长度口径。
 *
 * - CRLF 切分：原 `/\n\n+/` 只认连续 LF，CRLF 存量/外部编辑章（\r\n\r\n）整章成
 *   一块、超 500 被滤，样章候选静默全灭；现 `(?:\r?\n){2,}` 按换行单位（可选 \r +
 *   \n）切分，分隔符整体消费不残留 \r。
 * - 码点长度：块长过滤原用 UTF-16 .length（与金句 R0912-7 码点口径双轨并存），含
 *   增补平面字符（emoji）的段 length 偏大被 500 上限误杀；现改码点计数（文件内
 *   codePointLength 单源，与金句同口径），码点超上限的块仍被滤（口径未放宽）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learnFromBook } from '../../src/learn/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 合格叙事段（R72-2 大书 fixture 同款 para，单段 ≈45 码点，打分过 60 低分过滤） */
const PARA = '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起，玉佩在胸前微微发烫，像一颗不肯安分的心。'

/** 单章定稿书（无清单 → 全量收割降级，与 index.test.ts H-1 口径一致） */
function makeBookWithBody(body: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'r0912-2-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '0001-定稿章.md'), `---\n章号: 1\n标题: 定稿章\n---\n${body}`, 'utf-8')
  return root
}

test('r0912-2: CRLF 章（\\r\\n\\r\\n 分段）能切出样章块（修前整章一块超 500 被滤全灭）', async () => {
  // 6 段 CRLF 分隔：单段 ≈90 码点在 50..500 内；修前 /\n\n+/ 不命中 \r\n\r\n →
  // 整章一块 ≈550 UTF-16 超 500 上限被滤，sampleCount = 0；修后切出 6 块各合格
  const body = Array.from({ length: 6 }, () => PARA.repeat(2)).join('\r\n\r\n')
  expect(body.length).toBeGreaterThan(500) // 前提钉：整章一块确实超 500（修前全灭成因）
  const root = makeBookWithBody(body)
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sampleCount).toBe(6)
    // 换行单位整体消费，切出的块不残留 \r
    for (const s of r.samples ?? []) expect(s.正文).not.toContain('\r')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r0912-2: 含 emoji 块按码点计数——UTF-16 超 500 不再误杀，码点超 500 仍滤', async () => {
  // 块 A：码点 ≈285（50..500 内）但 UTF-16 ≈525（超 500）——修前被误杀，修后保留
  const blockA = PARA + '🌊'.repeat(240)
  // 块 B：码点 ≈508（超 500）——修后仍滤（钉口径未被整体放宽/删除）
  const blockB = PARA + '乙段锚' + '🌊'.repeat(460)
  // 前提钉：A 码点 ≤500 且 UTF-16 > 500；B 码点 > 500
  expect([...blockA].length).toBeLessThanOrEqual(500)
  expect(blockA.length).toBeGreaterThan(500)
  expect([...blockB].length).toBeGreaterThan(500)
  const root = makeBookWithBody(`${blockA}\n\n${blockB}`)
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sampleCount).toBe(1)
    expect(r.samples?.[0]?.正文).toBe(blockA)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
