import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readChapter } from '../../src/format/chapters.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// R62-13：章号门槛收敛到 number——front matter 由 AI 产出/作者手改，引号写法
// 此前整章对本系统隐形（readChapter 硬判 number），现收敛为 number。
describe('R62-13 章号收敛', () => {
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'clwriting-r6213-')) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const fm = (章号line: string) => '---\n' + 章号line + '\n标题: 测试\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文'

  it('int 章号 1 正常解析', () => {
    writeFileSync(join(dir, '1.md'), fm('章号: 1'), 'utf8')
    const r = readChapter(join(dir, '1.md'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.章号).toBe(1)
  })

  it('引号章号 章号: "7" 收敛为 number（不再整章隐形）', () => {
    writeFileSync(join(dir, '2.md'), fm('章号: "7"'), 'utf8')
    const r = readChapter(join(dir, '2.md'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.章号).toBe(7)
  })

  it('章号带前导/尾随空白仍收敛（章号: " 8 "）', () => {
    writeFileSync(join(dir, '3.md'), fm('章号: " 8 "'), 'utf8')
    const r = readChapter(join(dir, '3.md'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.chapter.章号).toBe(8)
  })

  it('非数字章号（章号: 五）报「格式不符」而非「缺少」', () => {
    writeFileSync(join(dir, '4.md'), fm('章号: 五'), 'utf8')
    const r = readChapter(join(dir, '4.md'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('格式不符')
  })

  it('非整数（章号: 5.0）报「格式不符」', () => {
    writeFileSync(join(dir, '5.md'), fm('章号: 5.0'), 'utf8')
    const r = readChapter(join(dir, '5.md'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('格式不符')
  })

  it('缺失章号报「缺少」', () => {
    writeFileSync(join(dir, '6.md'), '---\n标题: 无章号\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文', 'utf8')
    const r = readChapter(join(dir, '6.md'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('缺少')
  })
})
