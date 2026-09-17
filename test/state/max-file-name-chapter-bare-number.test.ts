/**
 * 0918独立重评修复批（B005）回归：maxFileNameChapter 取号下限认裸数字名。
 *
 * 双轨漂移：maxFileNameChapter 原用窄正则 parseChapterFileName（须 `数字-标题`），
 * 而取号下限消费面（state.ts:211 nextChapter = skipFinalizedChapters(max(formula,
 * maxFileNameChapter))；recap.ts currentChapter；health manifestEmpty 哨兵）语义全是
 * 「已用章号下限/章文件存在性」——裸数字名（0012.md）/破折号名（5—标.md）/空格名
 * （5 标.md）此前失明，下限回指已用号区间。修复后收编 chapterNoFromName 单源
 * （tree 宽容集）+ 剥 .md 扩展后判定。
 *
 * 命名违规检测类（未定稿草稿扫描 unfinishedPieceNames 的 `^\d+-`、chapterFromRelPath
 * 的 `^(\d+)-` 等）不经本函数、各持窄口径——末段钉死窄正则对裸数字名行为与修复前
 * 一致（本就不管，保持）。锚：0918独立重评修复批 B005。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { maxFileNameChapter, skipFinalizedChapters } from '../../src/state/health.js'
import { parseChapterFileName } from '../../src/format/words.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let bodyDir = ''

afterEach(() => {
  if (bodyDir) rmSync(bodyDir, { recursive: true, force: true })
  bodyDir = ''
})

function writeBody(name: string, content: string): void {
  if (!bodyDir) {
    bodyDir = mkdtempTracked(join(tmpdir(), 'clw-maxfnchapter-'))
    mkdirSync(bodyDir, { recursive: true })
  }
  writeFileSync(join(bodyDir, name), content, 'utf8')
}

describe('0918独立重评修复批 B005: maxFileNameChapter 认裸数字名', () => {
  it('裸数字章（0012.md）计入下限；破折号/空格宽容集与 titled 常规名并存', () => {
    writeBody('0001-甲.md', '---\n章号: 1\n标题: 甲\n---\n正文\n')
    writeBody('0012.md', '---\n章号: 12\n标题: 裸名章\n---\n正文\n')
    writeBody('0005—破折.md', '---\n章号: 5\n标题: 破折\n---\n正文\n')
    writeBody('0007 空格.md', '---\n章号: 7\n标题: 空格\n---\n正文\n')
    writeBody('notes.md', '无章号杂记\n')
    expect(maxFileNameChapter(bodyDir)).toBe(12)
  })

  it('大写扩展名（.MD）裸数字名同判（isMdFileName 单源剥扩展）', () => {
    writeBody('0015.MD', '---\n章号: 15\n标题: 大写裸名\n---\n正文\n')
    expect(maxFileNameChapter(bodyDir)).toBe(15)
  })

  it('空目录/无匹配文件 → 0（口径不变）', () => {
    writeBody('0003-丙.md', '---\n章号: 3\n标题: 丙\n---\n正文\n')
    expect(maxFileNameChapter(bodyDir)).toBe(3)
    const empty = mkdtempSync(join(tmpdir(), 'clw-maxfnchapter-empty-'))
    try {
      expect(maxFileNameChapter(empty)).toBe(0)
      expect(maxFileNameChapter(join(empty, '不存在'))).toBe(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('nextChapter 组合点（state.ts:211 同式）：裸数字章存在时不再回指已用号区间', () => {
    // 书内实算形态：清单在册定稿 1 章 + 1 → formula=2；裸名 0012.md 无 fm（不进
    // readChapterDir chapters、不匹配 `^\d+-` 排除面）——修复前下限盲区使
    // max(2, 旧 maxFileName=1)=2，新章号滑回 2..11 区间（12 已被盘面文件占用）
    writeBody('0001-甲.md', '---\n章号: 1\n标题: 甲\n---\n正文\n')
    writeBody('0012.md', '外部投放的无 fm 裸名章文件\n')
    const formula = 2
    const nextChapter = skipFinalizedChapters(Math.max(formula, maxFileNameChapter(bodyDir)), new Set())
    expect(nextChapter).toBe(12)
  })

  it('命名违规检测窄轨行为不变：parseChapterFileName 对裸数字名保持失明', () => {
    expect(parseChapterFileName('0012.md')).toBeNull()
    expect(parseChapterFileName('0012-标题.md')).toEqual({ 章号: 12, 标题: '标题' })
  })
})
