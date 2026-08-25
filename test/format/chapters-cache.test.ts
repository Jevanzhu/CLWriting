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
import { readChapterDir, clearChapterDirCache, clearChapterDirCacheForBook } from '../../src/format/chapters.js'

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

// ── 内存闸（2026-08-24 审计 C2）：clearChapterDirCacheForBook 按 bookRoot 前缀清理 ────
// 删书/改名链（books.ts）接线后，该书的外层键（join(bookRoot, '写作', '正文') 等）应全部
// 归零、他书不受连坐；清后再读走惰性重建，语义无损。返回值 = 清除的外层键数（计数断言用）。

describe('clearChapterDirCacheForBook 按 bookRoot 前缀清理（审计 C2）', () => {
  let root: string
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    clearChapterDirCache()
  })

  function makeBook(name: string): string {
    const bookRoot = join(root, name)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    mkdirSync(join(bookRoot, '大纲', '章纲'), { recursive: true })
    writeFileSync(
      join(bookRoot, '写作', '正文', '001-甲.md'),
      '---\n章号: 1\n标题: 甲\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n甲正文。\n',
      'utf8',
    )
    writeFileSync(
      join(bookRoot, '大纲', '章纲', '001-甲纲.md'),
      '---\n章号: 1\n标题: 甲纲\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n纲。\n',
      'utf8',
    )
    return bookRoot
  }

  it('删书口径：该书全部前缀键归零，他书条目保留，清后再读惰性重建', () => {
    root = mkdtempSync(join(tmpdir(), 'chapters-bookclear-'))
    const a = makeBook('bookA')
    const b = makeBook('bookB')
    // 预热：bookA 两个目录（正文 + 章纲）各占一个外层键，bookB 一个
    expect(readChapterDir(join(a, '写作', '正文')).chapters).toHaveLength(1)
    expect(readChapterDir(join(a, '大纲', '章纲')).chapters).toHaveLength(1)
    expect(readChapterDir(join(b, '写作', '正文')).chapters).toHaveLength(1)

    // 删书后该书 chapterDirCache 条目归零（含全部子目录键）
    expect(clearChapterDirCacheForBook(a)).toBe(2)
    expect(clearChapterDirCacheForBook(a)).toBe(0) // 幂等：重复清理无残留
    // 他书不受连坐
    expect(clearChapterDirCacheForBook(b)).toBe(1)
    // 清后再读：惰性重建，内容不受影响
    const again = readChapterDir(join(a, '写作', '正文'))
    expect(again.chapters.map((c) => c.章号)).toEqual([1])
  })

  it('前缀匹配不误伤同前缀目录（bookA 与 bookA2）', () => {
    root = mkdtempSync(join(tmpdir(), 'chapters-bookprefix-'))
    const a = makeBook('bookA')
    const a2 = makeBook('bookA2')
    readChapterDir(join(a, '写作', '正文'))
    readChapterDir(join(a2, '写作', '正文'))
    // bookRoot + 分隔符 为前缀：清 bookA 不得吞掉 bookA2 的键（裸 startsWith 会误伤）
    expect(clearChapterDirCacheForBook(a)).toBe(1)
    expect(clearChapterDirCacheForBook(a2)).toBe(1)
  })
})
