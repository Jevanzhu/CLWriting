/**
 * PM-3/4/6（性能与内存专项·2026-09-05）回归：保存链 journal 尺寸闸 + 副本收敛 + 版本字数。
 *
 * - PM-3：appendPending 快照尺寸闸——快照超 JOURNAL_PENDING_SNAPSHOT_MAX_BYTES（256KB）
 *   时落降级行（degraded:true），journal 不再随超大章每笔翻倍 IO + 立即触发 compact
 *   全量重读。恢复面契约不变：findUnsettled 仍报 opId（恢复消费方只读 opId，content
 *   全仓零程序性消费方——R31-21 已实证）；常规章全文快照照旧完整入 journal。
 *   R53-D-2（五十三轮）：降级行快照从 content:'' 改为头尾各 32KB 截断
 *   （truncateSnapshotHeadTail）——空快照使崩窗内新内容零盘上副本，红线失守。
 * - PM-4：executeSave 副本收敛——wordDelta 的旧文字数走 revision 键控缓存
 *   （docWordsCache），连续保存/外部改动后 delta 仍逐次精确（缓存陈旧即在此暴露）；
 *   字数日记为外部可观测面。
 * - PM-6：留底携带 words——保存链 maybeSnapshot / meta PATCH 路径写入的字数进版本
 *   meta，listVersionEntries / listSnapshotEntries 对带字数版本走头部读快路径
 *   （countWords 兜底不触发）；存量无字数版本回落全量读兜底（口径不变）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { findUnsettled, appendPending, JOURNAL_PENDING_SNAPSHOT_MAX_BYTES } from '../../src/document/journal.js'
import { listVersionEntries, writeVersion, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'
import { countWords } from '../../src/format/words.js'
import { bodyOf } from '../../src/format/frontmatter.js'
import { readTodayDelta, todayDate } from '../../src/document/words-diary.js'

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
    bookRoot = mkdtempSync(join(tmpdir(), 'pm346-cluster-'))
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

  // ── PM-3：pending 快照尺寸闸 ───────────────────────────────

  it('PM-3: 快照超 256KB → 降级行（degraded + 头尾截断，R53-D-2），findUnsettled 仍报 opId，保存成功', async () => {
    const bigBody = '山'.repeat(JOURNAL_PENDING_SNAPSHOT_MAX_BYTES) // 256K 个「山」（UTF-8 计 768KB，超限）
    const big = '---\n标题: 开篇\n章号: 1\n---\n' + bigBody
    const r = await svc.save(docId, relPath, { content: big, expectedRevision: computeRevision(absPath), operationId: 'op-big-' + String(seq++), origin: 'manual' })
    expect(r.ok).toBe(true)

    // journal pending 行已降级：无兆级行（文件远小于快照本体），行形态 = degraded:true
    // + 头尾截断快照（R53-D-2：原 content:'' 使崩窗内新内容零盘上副本）
    const text = readFileSync(journalPath, 'utf-8')
    const pendingLine = text.split('\n').find((l) => l.includes('"pending"'))
    expect(pendingLine).toBeDefined()
    const parsed = JSON.parse(pendingLine!) as { content: string; degraded?: boolean }
    expect(parsed.content.startsWith('---\n标题: 开篇\n章号: 1\n---\n')).toBe(true) // 头部正文开头
    expect(parsed.content.endsWith('山')).toBe(true) // 尾部最新键入
    expect(parsed.content).toContain('快照超长已截断')
    expect(parsed.degraded).toBe(true)
    expect(text.length).toBeLessThan(80 * 1024) // 降级行 ≤ 2×32KB 截断 + 标记（原全文形态此处会 ≈768KB）

    // 崩溃恢复契约不变：save 成功已 settled → 无未结算项；再手工追加一条超限 pending
    // 验证降级形态仍被 findUnsettled 识别（opId 可报，恢复面零缺口）
    expect(findUnsettled(journalPath).length).toBe(0)
    const opId = await appendPending(journalPath, docId, null, 'x'.repeat(JOURNAL_PENDING_SNAPSHOT_MAX_BYTES + 1))
    const after = findUnsettled(journalPath)
    expect(after.map((p) => p.opId)).toContain(opId)
    const line2 = readFileSync(journalPath, 'utf-8').split('\n').find((l) => l.includes(opId))
    expect(line2).toBeDefined()
    const parsed2 = JSON.parse(line2!) as { content: string; degraded?: boolean }
    expect(parsed2.degraded).toBe(true)
    expect(parsed2.content.startsWith('x')).toBe(true)
    expect(parsed2.content.endsWith('x')).toBe(true)
    expect(parsed2.content).toContain('快照超长已截断')
  })

  it('PM-3: 常规章（< 阈值）全文快照照旧完整入 journal', async () => {
    const small = '---\n标题: 开篇\n章号: 1\n---\n新正文一段话，不长。'
    const r = await svc.save(docId, relPath, { content: small, expectedRevision: computeRevision(absPath), operationId: 'op-small-' + String(seq++), origin: 'manual' })
    expect(r.ok).toBe(true)
    const text = readFileSync(journalPath, 'utf-8')
    const pendingLine = text.split('\n').find((l) => l.includes('"pending"'))
    const parsed = JSON.parse(pendingLine!) as { content: string; degraded?: boolean }
    expect(parsed.content).toBe('---\n标题: 开篇\n章号: 1\n---\n新正文一段话，不长。')
    expect(parsed.degraded).toBeUndefined()
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
