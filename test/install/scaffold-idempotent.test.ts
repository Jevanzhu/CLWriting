/**
 * DA-2（第七轮）回归：scaffold 幂等前提修复——占位/骨架产物存在即跳过 + 预置禁词去重。
 *
 * 修复背景：doInit 半成品恢复（第六轮）复跑 scaffoldBookRepo，但 scaffold 对占位
 * .md（世界观/境界体系/名册/卷纲/章纲/总纲/文风铁律/简介）与 book.yaml/清单是无条件
 * 覆盖写、预置禁词 addEntry 无去重——未登记书可被 CLI/AI 操作，复跑会覆盖已积累的
 * 真实内容并把 6 条预置禁词翻倍。「正文是唯一不可再生区」的注释断言过强。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldBookRepo } from '../../src/install/scaffold.js'
import { readManifest, upsertEntry, writeManifest, type ManifestEntry } from '../../src/document/manifest.js'

const OPTS = { name: '幂等书', genre: '玄幻', leadsEnabled: [] as never[], kind: 'long' as const }

test('DA-2: 复跑 scaffold → 占位文档不覆盖已有真实内容', () => {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-idem-'))
  try {
    scaffoldBookRepo(root, OPTS)
    const world = join(root, '设定', '世界观.md')
    writeFileSync(world, '# 世界观\n\n主角已定：真实设定内容', 'utf-8')
    const outline = join(root, '大纲', '总纲.md')
    writeFileSync(outline, '# 总纲\n\n真实大纲三幕', 'utf-8')

    scaffoldBookRepo(root, OPTS) // 半成品恢复同款复跑

    expect(readFileSync(world, 'utf-8')).toContain('真实设定内容')
    expect(readFileSync(outline, 'utf-8')).toContain('真实大纲三幕')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DA-2: 复跑 scaffold → book.yaml 与已有清单登记不抹掉', () => {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-idem2-'))
  try {
    scaffoldBookRepo(root, OPTS)
    // 作者改过 book.yaml（如改题材）+ 半成品阶段已登记条目
    const cfgFp = join(root, 'book.yaml')
    const tuned = readFileSync(cfgFp, 'utf-8').replace('玄幻', '仙侠')
    writeFileSync(cfgFp, tuned, 'utf-8')
    const mFp = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(mFp)
    upsertEntry(m, { id: 'doc_half', nodeType: 'document', path: '大纲/总纲.md' } as unknown as ManifestEntry)
    writeManifest(mFp, m)

    scaffoldBookRepo(root, OPTS)

    expect(readFileSync(cfgFp, 'utf-8')).toContain('仙侠') // 不被 opts.genre=玄幻 覆盖回去
    expect(readManifest(mFp).entries.has('doc_half')).toBe(true) // 登记不被空清单整写抹掉
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DA-2: 复跑 scaffold → 预置 AI 味禁词不翻倍（按 类型+正文 去重）', () => {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-idem3-'))
  try {
    scaffoldBookRepo(root, OPTS)
    scaffoldBookRepo(root, OPTS)
    scaffoldBookRepo(root, OPTS)
    const banned = readdirSync(join(root, '文风/条目/禁词'))
    expect(banned).toHaveLength(6) // 预置恰 6 条，复跑 3 次不翻倍
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
