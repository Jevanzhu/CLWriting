import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readChapter, writeChapter, validateEnums } from '../../src/format/chapters.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
})
