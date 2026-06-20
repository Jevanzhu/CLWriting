/**
 * 账本推进声明读取 单元测试 —— 账本 CLI 接缝修复。
 *
 * 覆盖 readChapterLeadUpdates（兑现层）+ readOutlineLeads（计划层）。
 */

import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChapterLeadUpdates } from '../../src/process/lead-updates.js'
import { readOutlineLeads } from '../../src/process/materials.js'

function tmpWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'lead-updates-'))
}

test('readChapterLeadUpdates: 解析标准行（编号/动词/证据，全角冒号）', () => {
  const wd = tmpWorkDir()
  try {
    writeFileSync(
      join(wd, '账本推进.md'),
      '- 成长线-001 起步：林开脉，踏入炼气一层。\n- 设定线-001 树立：灵脉体系——天地灵气分九品。\n',
      'utf-8',
    )
    expect(readChapterLeadUpdates(wd)).toEqual([
      { leadId: '成长线-001', 动词: '起步', 证据: '林开脉，踏入炼气一层。' },
      { leadId: '设定线-001', 动词: '树立', 证据: '灵脉体系——天地灵气分九品。' },
    ])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('readChapterLeadUpdates: 半角冒号 + 忽略非列表行', () => {
  const wd = tmpWorkDir()
  try {
    writeFileSync(join(wd, '账本推进.md'), '# 本章推进\n说明文字一行\n- 伏笔-002 埋下: 桌上多了一封信\n', 'utf-8')
    expect(readChapterLeadUpdates(wd)).toEqual([{ leadId: '伏笔-002', 动词: '埋下', 证据: '桌上多了一封信' }])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('readChapterLeadUpdates: 无文件 → []', () => {
  const wd = tmpWorkDir()
  try {
    expect(readChapterLeadUpdates(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})

test('readOutlineLeads: 多值 / 单值 / 缺省', () => {
  const wd = tmpWorkDir()
  try {
    writeFileSync(join(wd, '细纲.md'), '---\n章号: 1\n推进: [成长线-001, 设定线-001]\n---\n正文', 'utf-8')
    expect(readOutlineLeads(wd)).toEqual(['成长线-001', '设定线-001'])

    writeFileSync(join(wd, '细纲.md'), '---\n章号: 1\n推进: 成长线-001\n---\n正文', 'utf-8')
    expect(readOutlineLeads(wd)).toEqual(['成长线-001'])

    writeFileSync(join(wd, '细纲.md'), '---\n章号: 1\n---\n正文', 'utf-8')
    expect(readOutlineLeads(wd)).toEqual([])
  } finally {
    rmSync(wd, { recursive: true, force: true })
  }
})
