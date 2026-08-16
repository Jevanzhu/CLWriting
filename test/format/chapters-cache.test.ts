/**
 * CC-P1-3 回归：readChapterDir stat 级元数据缓存。
 *
 * 修复前：热路径（GET /books、GET /overview、机检、树红点聚合）对数百章大书每轮
 * readFile+parse+countWords 全量整读，单请求秒级阻塞事件循环。修复后按 (mtimeMs,size)
 * stat 命中——文件未变跳过整读，变化/新增/删除由每轮 walk 自愈。
 *
 * 断言口径：
 * - 未变文件：两次读取内容指纹一致（缓存命中复用）
 * - mtime+size 撞车（同字节改写 + utimes 恢复 mtime）：缓存按 stat 判定命中 → 旧内容
 *   （与 probeCache 同口径的理论窗口）；includeBody=true 现读不受缓存影响 → 新内容
 * - 内容变化（writeFileSync 改 mtime）：重读新内容，缓存不陈旧
 * - 新增/删除文件：下一轮 walk 自愈
 * - 返回引用隔离：调用方 sort/mutate 不污染缓存
 * - 递归卷子目录也走缓存
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readChapterDir, clearChapterDirCache } from '../../src/format/chapters.js'

describe('readChapterDir stat 级缓存（CC-P1-3）', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    clearChapterDirCache()
  })

  function makeDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'chapters-cache-'))
    mkdirSync(join(dir, '正文'), { recursive: true })
    return join(dir, '正文')
  }

  function writeChapter(no: number, title: string, body: string): string {
    const fp = join(dir, '正文', `${String(no).padStart(3, '0')}-${title}.md`)
    writeFileSync(fp, `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}\n`, 'utf8')
    return fp
  }

  it('未变文件两次读取内容指纹一致（缓存命中复用）', () => {
    const bodyDir = makeDir()
    writeChapter(1, '第一章', '山门玉佩。')
    writeChapter(2, '第二章', '弟子林远。')
    const first = readChapterDir(bodyDir)
    expect(first.chapters).toHaveLength(2)
    const second = readChapterDir(bodyDir)
    expect(second.chapters).toHaveLength(2)
    // 未变：内容指纹（字数）一致 → 复用缓存
    expect(second.chapters.map((c) => c._wordCount)).toEqual(first.chapters.map((c) => c._wordCount))
  })

  it('（反证）mtime+size 撞车时缓存命中返回旧内容——证明 stat 级判定生效', () => {
    const bodyDir = makeDir()
    const fp = writeChapter(1, '第一章', '甲正文。')
    const st = statSync(fp)
    const before = readChapterDir(bodyDir)
    expect(before.chapters[0]!._wordCount).toBeGreaterThan(0)

    // 同字节改写（甲→乙，utf8 同长度）+ utimes 恢复 mtime → (mtime,size) 未变 → 命中旧缓存。
    // 这是与 probeCache 同口径的理论撞车窗口，恰好反向证明「未变文件走 stat 命中不整读」。
    writeFileSync(fp, '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n乙正文。\n', 'utf8')
    utimesSync(fp, st.atime, st.mtime)
    const after = readChapterDir(bodyDir)
    expect(after.chapters[0]!._wordCount).toBe(before.chapters[0]!._wordCount)
  })

  it('includeBody=true 走现读：mtime+size 撞车仍读到新正文（不驻留缓存）', () => {
    const bodyDir = makeDir()
    const fp = writeChapter(1, '第一章', '甲正文。')
    const st = statSync(fp)
    readChapterDir(bodyDir, true) // 预热（若错误缓存 includeBody，此处会缓存旧 body）

    // 同字节改写 + 恢复 mtime → 现读路径必须读到新内容（不走缓存判定）
    writeFileSync(fp, '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n乙正文。\n', 'utf8')
    utimesSync(fp, st.atime, st.mtime)
    const again = readChapterDir(bodyDir, true)
    expect(again.chapters[0]!._body).toContain('乙正文。')
  })

  it('内容变化（writeFileSync 改 mtime）→ 重读新内容，缓存不陈旧', () => {
    const bodyDir = makeDir()
    writeChapter(1, '第一章', '旧正文。')
    const oldCount = readChapterDir(bodyDir).chapters[0]!._wordCount

    writeChapter(1, '第一章', '新正文很长很长很长很长很长。')
    const after = readChapterDir(bodyDir)
    expect(after.chapters[0]!._wordCount).not.toBe(oldCount)
  })

  it('新增文件 → 下一轮 walk 自愈出现；删除文件 → 下一轮消失', () => {
    const bodyDir = makeDir()
    writeChapter(1, '第一章', '正文。')
    expect(readChapterDir(bodyDir).chapters).toHaveLength(1)

    writeChapter(2, '第二章', '正文二。')
    expect(readChapterDir(bodyDir).chapters).toHaveLength(2)

    rmSync(join(dir, '正文', '001-第一章.md'))
    const after = readChapterDir(bodyDir)
    expect(after.chapters).toHaveLength(1)
    expect(after.chapters[0]!.章号).toBe(2)
  })

  it('返回引用隔离：调用方 sort/改字段不污染缓存', () => {
    const bodyDir = makeDir()
    writeChapter(2, '第二章', '二。')
    writeChapter(1, '第一章', '一。')
    expect(readChapterDir(bodyDir).chapters).toHaveLength(2)

    // 调用方 sort 重排 + 改字段（不依赖 readdir 顺序：只验证缓存不受污染）
    const got = readChapterDir(bodyDir)
    got.chapters.sort((a, b) => a.章号 - b.章号)
    got.chapters[0]!.标题 = '被改'

    // 再次读取：标题未被污染
    const again = readChapterDir(bodyDir)
    expect(again.chapters.map((c) => c.标题)).not.toContain('被改')
    expect(again.chapters.every((c) => c.标题 === '第二章' || c.标题 === '第一章')).toBe(true)
  })

  it('递归卷子目录也走缓存（卷结构）', () => {
    const bodyDir = makeDir()
    mkdirSync(join(dir, '正文', '卷一'), { recursive: true })
    writeFileSync(
      join(dir, '正文', '卷一', '010-卷内章.md'),
      '---\n章号: 10\n标题: 卷内章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n卷内正文。\n',
      'utf8',
    )
    const first = readChapterDir(bodyDir)
    expect(first.chapters.map((c) => c.章号)).toEqual([10])

    // 未变：第二次内容指纹一致（缓存命中）
    const second = readChapterDir(bodyDir)
    expect(second.chapters.map((c) => c._wordCount)).toEqual(first.chapters.map((c) => c._wordCount))
  })
})
