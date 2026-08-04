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

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-author-signal-'))
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const AI_TEXT = '第一段。\n\n值得一提的是，他走进了房间。\n\n第二段。'
const DOC = 'doc_TEST001'

describe('B5 作者信号', () => {
  it('作者删掉含套话词的行 → ai-cliche 命中 +1', () => {
    recordAiVersion(root, DOC, AI_TEXT)
    // 作者手改版：删掉「值得一提的是」那行
    const edited = '第一段。\n\n第二段。'
    recordAuthorSignal(root, DOC, edited, 'self-heal')

    const hits = readRuleHits(root)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('ai-cliche')
    expect(hits[0]!.hits).toBe(1)
    expect(hits[0]!.recentMessages[0]).toContain('值得一提的是')
  })

  it('多文档不串信号', () => {
    recordAiVersion(root, DOC, AI_TEXT)
    recordAiVersion(root, 'doc_OTHER', '另一篇没有套话的内容')
    recordAuthorSignal(root, DOC, '第一段。\n\n第二段。', 'self-heal')

    const hits = readRuleHits(root)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('ai-cliche')
  })

  it('作者未删改（内容相同）→ 不记录', () => {
    recordAiVersion(root, DOC, AI_TEXT)
    recordAuthorSignal(root, DOC, AI_TEXT, 'self-heal')
    expect(readRuleHits(root)).toEqual([])
  })

  it('作者删掉非套话内容 → 不记录（只统计套话类规则）', () => {
    recordAiVersion(root, DOC, '第一段。\n\n第二段。\n\n第三段。')
    recordAuthorSignal(root, DOC, '第一段。\n\n第三段。', 'self-heal')
    expect(readRuleHits(root)).toEqual([])
  })

  it('无上一版（首次保存）→ 静默返回', () => {
    recordAuthorSignal(root, DOC, '第一段。', 'self-heal')
    expect(readRuleHits(root)).toEqual([])
  })
})