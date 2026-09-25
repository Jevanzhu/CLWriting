/**
 * PM-4/6（性能与内存专项·2026-09-05）回归：保存链副本收敛 + 版本字数。
 *
 * R0916-7-P3-9（2026-09-25）：原 PM-3 用例（appendPending 快照尺寸闸 256KB / 降级行头尾
 * 截断）钉住的快照机制已整段删除——journal pending 只记 opId/baseRevision/ts 元数据，
 * 正文不再进 journal。本文件 PM-3 段按新形态改造为「保存链 journal 尺寸与正文规模解耦」
 * 契约定点：任意规模正文保存后 pending 行都不含内容字段、journal 尺寸与正文规模无关。
 * - PM-4：executeSave 副本收敛——wordDelta 的旧文字数走 revision 键控缓存
 *   （docWordsCache），连续保存/外部改动后 delta 仍逐次精确（缓存陈旧即在此暴露）；
 *   字数日记为外部可观测面。
 * - PM-6：留底携带 words——保存链 maybeSnapshot / meta PATCH 路径写入的字数进版本
 *   meta，listVersionEntries 对带字数版本走头部读快路径
 *   （countWords 兜底不触发）；存量无字数版本回落全量读兜底（口径不变）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { DocumentService } from '../../src/document/service.js'
import { findUnsettled } from '../../src/document/journal.js'
import { listVersionEntries, writeVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'
import { countWords } from '../../src/format/words.js'
import { bodyOf } from '../../src/format/frontmatter.js'
import { readTodayDelta, todayDate } from '../../src/document/words-diary.js'

/** 从 journal 文本里取 pending 行（未结算行的唯一形态；settled 行另计） */
function pendingLineOf(text: string): string {
  const line = text.split('\n').find((l) => l.includes('"status":"pending"'))
  expect(line).toBeDefined()
  return line!
}

describe('PM-3/4/6 保存链回归', () => {
  let bookRoot: string
  let svc: DocumentService
  let docId: string
  let absPath: string
  let journalPath: string
  let seq = 0
  const relPath = '写作/正文/0001-开篇.md'
  const v1 = '---\n标题: 开篇\n章号: 1\n---\n' + '他推开门，屋里静得能听见灰尘落地的声音。'.repeat(10)

  beforeEach(async () => {
    bookRoot = mkdtempTracked(join(tmpdir(), 'pm346-cluster-'))
    svc = new DocumentService({ bookRoot })
    const c = await svc.createDocument({ relPath, content: v1 })
    if (!c.ok) throw new Error('prereq create 失败')
    docId = c.docId
    absPath = join(bookRoot, relPath)
    journalPath = join(bookRoot, '工作区', '.journal', `${docId}.jsonl`)
  })
  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  // ── P3-9：保存链 journal 只记元数据（正文不进 journal）───────────

  it('P3-9: 超大章（>256KB 正文）保存 → pending 行仍只含元数据，journal 尺寸与正文规模解耦', async () => {
    const bigBody = '山'.repeat(300_000) // ≈900KB UTF-8：原 256KB 快照闸的触发域
    const big = '---\n标题: 开篇\n章号: 1\n---\n' + bigBody
    const r = await svc.save(docId, relPath, { content: big, expectedRevision: computeRevision(absPath), operationId: 'op-big-' + String(seq++), origin: 'manual' })
    expect(r.ok).toBe(true)

    const text = readFileSync(journalPath, 'utf-8')
    const parsed = JSON.parse(pendingLineOf(text)) as Record<string, unknown>
    // 行 = 元数据全量（键集精确钉住：多一个 content/degraded 即红）
    expect(Object.keys(parsed).sort()).toEqual(['baseRevision', 'docId', 'opId', 'status', 'ts'])
    expect(parsed.status).toBe('pending')
    expect(text).not.toContain('快照超长已截断')
    // journal 尺寸与正文规模无关（原全文快照形态此处 ≈900KB，降级形态 ≈64KB）
    expect(text.length).toBeLessThan(2 * 1024)

    // 崩溃检测契约不变：save 成功已 settled → 无未结算项
    expect(findUnsettled(journalPath).length).toBe(0)
  })

  it('P3-9: 常规章保存 → 同样无内容字段（新旧形态唯一差别是少了快照，元数据口径全一致）', async () => {
    const small = '---\n标题: 开篇\n章号: 1\n---\n新正文一段话，不长。'
    const baseRevision = computeRevision(absPath) // 保存前基线（pending.baseRevision 语义）
    const r = await svc.save(docId, relPath, { content: small, expectedRevision: baseRevision, operationId: 'op-small-' + String(seq++), origin: 'manual' })
    expect(r.ok).toBe(true)
    const text = readFileSync(journalPath, 'utf-8')
    const parsed = JSON.parse(pendingLineOf(text)) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['baseRevision', 'docId', 'opId', 'status', 'ts'])
    // 基线仍进 journal（health 的 save pending 复核靠它比对盘上指纹，R0912-1a）
    expect(parsed.baseRevision).toBe(baseRevision)
    expect(computeRevision(absPath)).not.toBe(baseRevision) // 本笔确已落盘（复核判『已保存』的形态）
    expect(text).not.toContain('新正文一段话')
    expect(text).not.toContain('"content"')
  })

  // ── PM-4：副本收敛——wordDelta 缓存逐次精确 + 外部改动自动失效 ──

  it('PM-4: 连续保存 delta 逐次精确（缓存命中路径），外部改写后 delta 重算', async () => {
    const w = (s: string) => countWords(bodyOf(s))
    const body = (n: number) => '---\n标题: 开篇\n章号: 1\n---\n' + '字'.repeat(n)
    const date = todayDate()

    // 第一笔：旧文 = create 的 v1，未命中缓存（首笔）→ delta1 = w(v2)-w(v1)
    const v2 = body(50)
    const r1 = await svc.save(docId, relPath, { content: v2, expectedRevision: computeRevision(absPath), operationId: 'op-v2-' + String(seq++), origin: 'manual' })
    expect(r1.ok).toBe(true)
    const delta1 = readTodayDelta(bookRoot, date)
    expect(delta1).toBe(w(v2) - w(v1))

    // 第二笔紧接：旧文字数必须命中 revision 键控缓存（若缓存返回陈旧值，此处 delta 即错）。
    // readTodayDelta 是当日累计和：两笔后 = w(v3)-w(v1)
    const v3 = body(80)
    const r2 = await svc.save(docId, relPath, { content: v3, expectedRevision: computeRevision(absPath), operationId: 'op-v3-' + String(seq++), origin: 'manual' })
    expect(r2.ok).toBe(true)
    expect(readTodayDelta(bookRoot, date)).toBe(w(v3) - w(v1))

    // 外部编辑器改写（rev 变 → 缓存必须自动失效重算，不得用 v3 的旧字数）
    const v4ext = body(120)
    writeFileSync(absPath, v4ext)
    const v5 = body(150)
    const r3 = await svc.save(docId, relPath, { content: v5, expectedRevision: computeRevision(absPath), operationId: 'op-v5-' + String(seq++), origin: 'manual' })
    expect(r3.ok).toBe(true)
    expect(readTodayDelta(bookRoot, date)).toBe((w(v5) - w(v4ext)) + (w(v3) - w(v2)) + (w(v2) - w(v1)))

    // 字节档恢复：delta 恒 0（R34D-18 口径不回归）
    const r4 = await svc.save(docId, relPath, { content: readFileSync(absPath), expectedRevision: computeRevision(absPath), operationId: 'op-restore-' + String(seq++), origin: 'restore' })
    expect(r4.ok).toBe(true)
    expect(readTodayDelta(bookRoot, date)).toBe((w(v5) - w(v4ext)) + (w(v3) - w(v2)) + (w(v2) - w(v1)))
  })

  // ── PM-6：留底携带 words + 读侧头读快路径 / 存量兜底 ────────

  it('PM-6: 保存留底带 words（countWords 兜底不触发），无字数存量版本仍回落兜底', async () => {
    const v2 = '---\n标题: 开篇\n章号: 1\n---\n' + '新'.repeat(30)
    const r = await svc.save(docId, relPath, { content: v2, expectedRevision: computeRevision(absPath), operationId: 'op-v2-' + String(seq++), origin: 'manual' })
    expect(r.ok).toBe(true)
    const snapshotsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
    // 快路径：本批写入的版本全部带字数——countWords 兜底一触发（抛错）即失败
    const entries = listVersionEntries(snapshotsDir, docId, () => {
      throw new Error('PM-6：带字数版本不应走全量读兜底')
    })
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.words).toBe(countWords(bodyOf(v1)))

    // 存量兜底：手工写一个无 字数 行的旧形态版本 → 全量读兜底照常算出
    writeVersion(snapshotsDir, docId, '---\n标题: 开篇\n章号: 1\n---\n旧形态无字数行。', {
      origin: 'manual',
      reason: 'legacy 形态（PM-6 前的存量版本）',
      baseRevision: null,
    })
    const entries2 = listVersionEntries(snapshotsDir, docId, (t) => countWords(bodyOf(t)))
    const legacy = entries2.find((e) => e.reason.includes('legacy'))
    expect(legacy).toBeDefined()
    expect(legacy!.words).toBe(countWords('旧形态无字数行。'))
  })
})
