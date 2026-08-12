import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readChapter, validateEnums, readChapterDir } from '../../src/format/chapters.js'
import { writeChapter } from '../helpers/chapter.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ChapterMeta 场景字段（#7.4）', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clwriting-scene-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('readChapter 解析场景字段', () => {
    const fp = join(dir, '1-测试.md')
    writeFileSync(fp, '---\n章号: 1\n标题: 测试\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 战斗\n---\n\n正文', 'utf8')
    const r = readChapter(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.场景).toBe('战斗')
  })

  it('writeChapter 写回场景 + 往返一致', () => {
    const fp = join(dir, '2-往返.md')
    writeChapter(fp, { 章号: 2, 标题: '往返', 钩子类型: '危机钩', 钩子强弱: '强', 情绪定位: '大爽', 场景: '对话' }, '正文')
    const r = readChapter(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.场景).toBe('对话')
  })

  it('validateEnums 场景越界告警', () => {
    const errs = validateEnums({
      章号: 1, 标题: 'x', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      场景: '不存在' as never,
    })
    expect(errs.some((e) => e.includes('场景越界'))).toBe(true)
  })

  it('场景缺省时为 undefined（旧正文兼容）', () => {
    const fp = join(dir, '3-旧.md')
    writeFileSync(fp, '---\n章号: 3\n标题: 旧\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文', 'utf8')
    const r = readChapter(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.场景).toBeUndefined()
  })

  // ── 字数目标（块4：节奏预测规划值）──
  it('readChapter 解析字数目标字段', () => {
    const fp = join(dir, '4-目标.md')
    writeFileSync(fp, '---\n章号: 4\n标题: 目标\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 战斗\n字数目标: 3000\n---\n\n正文', 'utf8')
    const r = readChapter(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.字数目标).toBe(3000)
  })

  it('writeChapter 写回字数目标 + 往返一致', () => {
    const fp = join(dir, '5-往返.md')
    writeChapter(fp, { 章号: 5, 标题: '往返', 钩子类型: '危机钩', 钩子强弱: '强', 情绪定位: '大爽', 场景: '对话', 字数目标: 2500 }, '正文')
    const r = readChapter(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.字数目标).toBe(2500)
  })

  it('字数目标缺省时为 undefined（旧正文兼容）', () => {
    const fp = join(dir, '6-无目标.md')
    writeFileSync(fp, '---\n章号: 6\n标题: 无目标\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文', 'utf8')
    const r = readChapter(fp)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.字数目标).toBeUndefined()
  })

  // ── readChapterDir 递归（卷子目录支持，修单层 bug）──
  it('readChapterDir 递归读卷子目录下的章 + 根目录章', () => {
    const bodyDir = join(dir, '正文')
    const volDir = join(bodyDir, '第一卷')
    mkdirSync(volDir, { recursive: true })
    writeFileSync(join(volDir, '0001-卷内.md'), '---\n章号: 1\n标题: 卷内\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文', 'utf8')
    writeFileSync(join(bodyDir, '0002-根.md'), '---\n章号: 2\n标题: 根\n钩子类型: 危机钩\n钩子强弱: 强\n情绪定位: 大爽\n---\n\n正文', 'utf8')
    const { chapters } = readChapterDir(bodyDir)
    expect(chapters).toHaveLength(2)
    expect(chapters.some((c) => c.标题 === '卷内')).toBe(true)
    expect(chapters.some((c) => c.标题 === '根')).toBe(true)
  })
})
