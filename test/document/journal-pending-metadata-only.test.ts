/**
 * R0916-7-P3-9（2026-09-25，源码质量评审 P3-9）回归：journal pending 只记元数据。
 *
 * 背景：每笔保存把 ≤256KB 全文快照写进 journal（含头尾截断降级、惰性构造、256KB 闸、
 * compact 尾段补追、降级写 inode 自校验一套机制），但快照全仓零程序性消费方——读取面
 * （state/health.ts reconcileSavePending、studio/server/api/state.ts acknowledge）只用
 * opId 与 baseRevision，作者侧唯一出口是叫作者手读 JSON 转义的隐藏 JSONL；实际承担未保存
 * 恢复的是前端 dirty 镜像（web-next shared/dirty-mirror.ts）与版本历史。收窄后
 * pending = { opId, docId, baseRevision, ts, status }。
 *
 * 覆盖（路线②三条回归面）：
 * 1. 旧格式 journal 仍可读——升级前落盘的含 content/degraded 字段的行照常被 findUnsettled
 *    检出、照常被 settled 抵消（向后兼容读旧，未知字段忽略）；
 * 2. 新写入不含快照——appendPending / appendMovePending 落盘行键集精确等元数据（多一个
 *    content/degraded 即红）；
 * 3. 崩溃检测仍工作——无 settled 的 pending 恒可报，compact 保留未结算行（旧格式行经压缩
 *    按新形态重写，内容字段随之丢弃：零消费方）；
 * 4. 锁超时降级裸写路径不回归——行短（元数据）故裸写照常完整落盘 + warn 留痕。
 * 崩溃安全语义（追加写 + fsync）由 journal-cross-process-lock / journal-compact-* 家族
 * 与保存链用例覆盖，本文件不动其口径。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendPending,
  appendSettled,
  findUnsettled,
  __setJournalCompactBytesForTest,
  __setJournalLockTimeoutForTest,
  JOURNAL_COMPACT_BYTES,
  JOURNAL_LOCK_TIMEOUT_MS,
  type JournalPending,
} from '../../src/document/journal.js'
import { initLogging, flushLogsForTest } from '../../src/log/index.js'

/** 升级前（P3-9 前）落盘的 pending 行形态：元数据 + 全文快照（degraded 为降级档标记）。 */
function legacyPendingLine(opId: string, content: string, degraded = false): string {
  return (
    JSON.stringify({
      opId,
      docId: 'doc_legacy',
      baseRevision: 'sha256:base-legacy',
      ts: '2026-09-24T00:00:00.000Z',
      status: 'pending',
      content,
      ...(degraded ? { degraded: true } : {}),
    }) + '\n'
  )
}

describe('R0916-7-P3-9：journal pending 只记元数据', () => {
  let dir: string
  let j: string
  let logsDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'journal-p3-9-'))
    j = join(dir, 'doc_1.jsonl')
    logsDir = join(dir, 'logs')
    initLogging({ logsDir, mirrorConsole: false })
  })
  afterEach(() => {
    __setJournalCompactBytesForTest(JOURNAL_COMPACT_BYTES)
    __setJournalLockTimeoutForTest(JOURNAL_LOCK_TIMEOUT_MS)
    rmSync(dir, { recursive: true, force: true })
  })

  it('旧格式 journal（含全文快照 content/degraded）仍被 findUnsettled 检出并给出 baseRevision', () => {
    writeFileSync(j, legacyPendingLine('legacy-1', '崩溃前的全文快照') + legacyPendingLine('legacy-2', '降级档头尾截断…片段', true), 'utf-8')
    const u = findUnsettled(j)
    expect(u.map((p) => p.opId).sort()).toEqual(['legacy-1', 'legacy-2'])
    // 复核判据（health.reconcileSavePending）读的字段仍在
    expect((u[0] as JournalPending).baseRevision).toBe('sha256:base-legacy')
  })

  it('旧格式 pending 被同文件 settled 抵消（读到旧行不改变配对语义）', async () => {
    writeFileSync(j, legacyPendingLine('legacy-3', '正文'), 'utf-8')
    await appendSettled(j, 'legacy-3', 'sha256:new-rev')
    expect(findUnsettled(j)).toEqual([])
  })

  it('新写入行键集 = 元数据全量（无 content/degraded；R0916-7-P3-8 起连传参通道也已删除）', async () => {
    const opId = await appendPending(j, 'doc_new', 'sha256:base-new')
    const line = readFileSync(j, 'utf-8').trim()
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['baseRevision', 'docId', 'opId', 'status', 'ts'])
    expect(parsed.baseRevision).toBe('sha256:base-new')
    // 行体不含任何内容字段（P3-9 收窄写侧 + P3-8 删形参，全文自此连参数通道都不存在）
    expect(line).not.toContain('content')
    expect(findUnsettled(j).map((p) => p.opId)).toEqual([opId])
  })

  it('compact 保留未结算 pending 且按新形态重写（旧格式行的内容字段随压缩丢弃——零消费方）', async () => {
    __setJournalCompactBytesForTest(1024)
    writeFileSync(j, legacyPendingLine('legacy-keep', '旧格式快照·'.repeat(60)), 'utf-8') // ≈1.5KB > 阈值
    const opId = await appendPending(j, 'doc_new', null)
    await appendSettled(j, opId, 'sha256:z') // 触发压缩

    const text = readFileSync(j, 'utf-8')
    expect(findUnsettled(j).map((p) => p.opId)).toEqual(['legacy-keep']) // 未结算行保留
    expect(text).not.toContain('content') // 重写为新形态：快照字段不再随行
    expect(text).not.toContain('degraded')
    expect(text).not.toContain('"status":"settled"') // 已结算行整段丢弃
    expect(Object.keys(JSON.parse(text.trim()) as Record<string, unknown>).sort()).toEqual([
      'baseRevision',
      'docId',
      'opId',
      'status',
      'ts',
    ])
  })

  it('锁超时降级裸写路径：新形态行仍完整落盘（行短，无需自校验/截断机制）+ warn 留痕', async () => {
    __setJournalLockTimeoutForTest(50)
    // 手工放置「活进程」锁（本进程 pid → 缺省探测恒存活）→ 等锁超时走降级裸写
    writeFileSync(`${j}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }), 'utf-8')
    try {
      const opId = await appendPending(j, 'doc_degraded', 'sha256:base')
      const parsed = JSON.parse(readFileSync(j, 'utf-8').trim()) as { opId: string; status: string }
      expect(parsed.opId).toBe(opId)
      expect(parsed.status).toBe('pending')
      expect(findUnsettled(j).map((p) => p.opId)).toEqual([opId])
      await flushLogsForTest()
      const logs = readdirSync(logsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => readFileSync(join(logsDir, f), 'utf-8'))
        .join('')
      expect(logs).toContain('降级裸写')
    } finally {
      rmSync(`${j}.lock`, { force: true })
    }
  })
})
