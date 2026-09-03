/**
 * B5 作者信号单测—— 作者删掉的片段命中规则 → 统计 +1。
 *
 * 用 git 仓库 fixture（recordAiVersion 走 git refs）。
 * 覆盖：命中累加 / 无删改不记录 / 非套话不记录 / 无上一版静默。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordAiVersion } from '../../src/git/ai-track.js'
import { git } from '../../src/git/exec.js'
import { recordAuthorSignal } from '../../src/ai/author-signal.js'
import { readRuleHits } from '../../src/ai/rule-hits.js'
import { rmWithRetryQuiet } from '../../src/fs/cross-process-lock.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-author-signal-'))
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)
})

afterEach(() => {
  // R39-1（三十九轮）：rmWithRetryQuiet——fixture 恒为 git 书库，await 之后的
  // git.exe 句柄释放仍可能有毫秒级延迟，win 上裸 rmSync 递归删临时目录偶发
  // EPERM/EBUSY（基线全量跑 3 例稳定红的本体之一）；EPERM/EBUSY 3×50ms 退避，
  // 确定性错误静默放弃不反噬（残留交 OS tmp 清理）。
  if (root) rmWithRetryQuiet(root, { rm: (p) => rmSync(p, { recursive: true, force: true }) })
})

const AI_TEXT = '第一段。\n\n值得一提的是，他走进了房间。\n\n第二段。'
const DOC = 'doc_TEST001'

describe('B5 作者信号', () => {
  it('作者删掉含套话词的行 → ai-cliche 命中 +1', async () => {
    recordAiVersion(root, DOC, AI_TEXT)
    // 作者手改版：删掉「值得一提的是」那行
    const edited = '第一段。\n\n第二段。'
    // R32-13：recordAuthorSignal 异步化（recordRuleHits 锁等待 async）
    await recordAuthorSignal(root, DOC, edited, 'self-heal')

    const hits = readRuleHits(root)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('ai-cliche')
    expect(hits[0]!.hits).toBe(1)
    expect(hits[0]!.recentMessages[0]).toContain('值得一提的是')
  })

  it('多文档不串信号', async () => {
    recordAiVersion(root, DOC, AI_TEXT)
    recordAiVersion(root, 'doc_OTHER', '另一篇没有套话的内容')
    await recordAuthorSignal(root, DOC, '第一段。\n\n第二段。', 'self-heal')

    const hits = readRuleHits(root)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('ai-cliche')
  })

  // R39-1：以下三例改 async + await——原同步回调裸调不 await，断言跑在异步逻辑
  // 完成前（断言力虚置），且挂起的 gitAsync 子进程与 afterEach rmSync 竞态：
  // win 全量跑 3 例稳定 EPERM（失败集合与未 await 集合精确重合）
  it('作者未删改（内容相同）→ 不记录', async () => {
    recordAiVersion(root, DOC, AI_TEXT)
    await recordAuthorSignal(root, DOC, AI_TEXT, 'self-heal')
    expect(readRuleHits(root)).toEqual([])
  })

  it('作者删掉非套话内容 → 不记录（只统计套话类规则）', async () => {
    recordAiVersion(root, DOC, '第一段。\n\n第二段。\n\n第三段。')
    await recordAuthorSignal(root, DOC, '第一段。\n\n第三段。', 'self-heal')
    expect(readRuleHits(root)).toEqual([])
  })

  it('无上一版（首次保存）→ 静默返回', async () => {
    await recordAuthorSignal(root, DOC, '第一段。', 'self-heal')
    expect(readRuleHits(root)).toEqual([])
  })
})