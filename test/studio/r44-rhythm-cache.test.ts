/**
 * R44-8（四十四轮）回归：rhythm 端点「目录指纹 + TTL」缓存壳。
 *
 * 端点原每请求 readBookConfig + rhythmLong 双 readChapterDir（写作/正文 + 大纲/
 * 章纲）——章节元数据虽有 CC-P1-3 stat 级缓存，冷路径（首查/有章变更）仍整读全部
 * 章节全文。R44-8 对齐 search.ts R35-7 手法加缓存壳：指纹 = book.yaml size:mtime
 *（kind 决定响应形状，单文件内容写必须以文件 stat 入指纹）+ 两目录 mtime。
 *
 * 断言用「全量重算计数」观测口（__rhythmScanCountForTest），确定性不依赖墙钟 5s
 *（先例 r35-search-cache / r36-version-stats-cache）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getRhythmCached,
  forgetRhythmCache,
  __setRhythmCacheTtlForTest,
  __rhythmScanCountForTest,
  __resetRhythmScanCountForTest,
} from '../../src/studio/server/api/rhythm.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

/** 建书：长篇（book.yaml + 写作/正文 2 章 + 大纲/章纲 3 章含字数目标）。 */
function makeLongBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r44-rhythm-cache-'))
  roots.push(root)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 节奏缓存书\n  genre: 玄幻\nhost: cc\n', 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文一二三\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '0002-转折.md'),
    '---\n章号: 2\n标题: 转折\n钩子类型: 危机钩\n钩子强弱: 强\n情绪定位: 小爽\n---\n\n正文四五六七八\n',
    'utf-8',
  )
  for (let no = 1; no <= 3; no++) {
    writeFileSync(
      join(root, '大纲', '章纲', `000${no}-章${no}.md`),
      `---\n章号: ${no}\n标题: 章${no}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n字数目标: ${3000 + no}\n---\n\n章纲正文\n`,
      'utf-8',
    )
  }
  return root
}

afterEach(() => {
  __setRhythmCacheTtlForTest(null)
  __resetRhythmScanCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R44-8 rhythm 缓存壳', () => {
  it('TTL 内二次调用命中不重扫（scan 计数不变），结果一致', () => {
    const root = makeLongBook()
    __setRhythmCacheTtlForTest(60_000)
    const r1 = getRhythmCached(root) as { kind: string; written: { count: number }; planned: { count: number } }
    expect(__rhythmScanCountForTest()).toBe(1)
    expect(r1.kind).toBe('long')
    expect(r1.written.count).toBe(2)
    expect(r1.planned.count).toBe(3)
    const r2 = getRhythmCached(root)
    expect(__rhythmScanCountForTest()).toBe(1) // 命中：未重扫
    expect(r2).toEqual(r1)
  })

  it('目录变化（指纹变）后重算：新增正文章节 written.count 反映新章', async () => {
    const root = makeLongBook()
    __setRhythmCacheTtlForTest(60_000)
    getRhythmCached(root)
    expect(__rhythmScanCountForTest()).toBe(1)
    await sleep(5) // 让目录 mtime 跨过同毫秒档，指纹必然失配
    writeFileSync(
      join(root, '写作', '正文', '0003-新章.md'),
      '---\n章号: 3\n标题: 新章\n钩子类型: 渴望钩\n钩子强弱: 弱\n情绪定位: 大爽\n---\n\n新章正文\n',
      'utf-8',
    )
    const r2 = getRhythmCached(root) as { written: { count: number }; chapterDiff: unknown[] }
    expect(__rhythmScanCountForTest()).toBe(2) // 写作/正文 mtime 变 → 重扫
    expect(r2.written.count).toBe(3)
    expect(r2.chapterDiff).toHaveLength(3)
  })

  it('book.yaml 内容变化（kind 翻转）→ 文件 stat 指纹失配 → 重算见新形状', async () => {
    const root = makeLongBook()
    __setRhythmCacheTtlForTest(60_000)
    const before = getRhythmCached(root) as { kind: string }
    expect(before.kind).toBe('long')
    await sleep(5)
    // book.yaml 是单文件内容写（目录 mtime 不变）——必须由文件 size:mtime 探出
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 节奏缓存书\n  genre: 玄幻\nhost: cc\n', 'utf-8')
    const after = getRhythmCached(root) as { kind: string }
    expect(__rhythmScanCountForTest()).toBe(2) // book.yaml stat 变 → 重扫
    expect(after.kind).toBe('short')
  })

  it('TTL 到期重扫；forget 显式失效同效', () => {
    const root = makeLongBook()
    __setRhythmCacheTtlForTest(60_000)
    getRhythmCached(root)
    expect(__rhythmScanCountForTest()).toBe(1)
    forgetRhythmCache(root) // 删书/改名挂点同款失效
    getRhythmCached(root)
    expect(__rhythmScanCountForTest()).toBe(2)
    __setRhythmCacheTtlForTest(0) // 即刻过期
    getRhythmCached(root)
    expect(__rhythmScanCountForTest()).toBe(3)
  })
})
