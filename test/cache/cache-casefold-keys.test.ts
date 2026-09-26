/**
 * R0913-win P3 折叠键族（2026-09-13 全库源码重评 win 适配修复批）：
 * case 漂移寻址下「重复章号误报」与「缓存前缀清不净」的折叠语义回归。
 * 折叠面 = win32 + darwin（platformCaseFold / samePath 单源口径），断言按
 * process.platform 分支（R45-2 钉值测试同族：linux 为不折叠臂）。
 *
 * 注：cache/rebuild.ts forgetChapterParseCacheForBook 与 fs/md-text-cache 同一批
 * 同款一行修（前缀 platformCaseFold），其缓存为 rebuild 模块内私有、种子需走完整
 * rebuild 链——行为与 md-text-cache forget 逐位同构，由本件 md 分支 + diff 复核覆盖。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { syncChapter } from '../../src/cache/sync.js'
import { createAllTables } from '../../src/cache/schema.js'
import {
  readMdTextCached,
  forgetMdTextCacheForBook,
  __mdTextCacheTestHooks,
} from '../../src/fs/md-text-cache.js'
import { log } from '../../src/log/index.js'
import type { ChapterMeta } from '../../src/format/types.js'

const FOLD_FS = process.platform === 'win32' || process.platform === 'darwin'

let dir: string | null = null

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
  __mdTextCacheTestHooks.clear()
  vi.restoreAllMocks()
})

/** case 变体寻址（折叠面：全小写形，与原路径指向同一物理目录；不折叠面：全大写形，
 *  为必然不存在的前缀——两臂都确定性可断言）。 */
function caseVariant(root: string): string {
  return FOLD_FS ? root.toLowerCase() : root.toUpperCase()
}

describe('R0913-win P3：折叠键族', () => {
  it('syncChapter 重复章号告警：case 变体路径不误报（折叠面），异路径仍报（真重复不丢）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'r0913-cache-'))
    mkdirSync(join(dir, '写作', '正文'), { recursive: true })
    const db = new DatabaseSync(':memory:')
    createAllTables(db)
    const p1 = join(dir, '写作', '正文', '0001-a.md')
    syncChapter(db, { 章号: 1, 标题: 'a', _path: p1 } as ChapterMeta)
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    // case 变体第二次入库：折叠面 = 同一物理文件（不应报重复）；不折叠面 = 字面异路径（报）
    syncChapter(db, { 章号: 1, 标题: 'a', _path: caseVariant(p1) } as ChapterMeta)
    expect(warnSpy).toHaveBeenCalledTimes(FOLD_FS ? 0 : 1)
    // 真异路径：重复章号告警不丢
    syncChapter(db, { 章号: 1, 标题: 'a', _path: join(dir, '写作', '正文', '其他', '0001-b.md') } as ChapterMeta)
    expect(warnSpy).toHaveBeenCalledTimes(FOLD_FS ? 1 : 2)
  })

  it('forgetMdTextCacheForBook case 变体寻址：折叠面全清，不折叠面按字面前缀', () => {
    dir = mkdtempTracked(join(tmpdir(), 'r0913-mdcache-'))
    mkdirSync(join(dir, '写作', '正文'), { recursive: true })
    const f = join(dir, '写作', '正文', '0001-a.md')
    writeFileSync(f, '---\n章号: 1\n---\n正文', 'utf-8')
    expect(readMdTextCached(f)).not.toBeNull()
    // 变体寻址 forget：折叠面命中清除（1），不折叠面前缀失配（0）
    expect(forgetMdTextCacheForBook(caseVariant(dir))).toBe(FOLD_FS ? 1 : 0)
    // 原寻址 forget：折叠面已清（0 残留），不折叠面此时才清（1）
    expect(forgetMdTextCacheForBook(dir)).toBe(FOLD_FS ? 0 : 1)
  })

  it('md-text-cache 正常 forget 不回归：原寻址单书清除计数准确', () => {
    dir = mkdtempTracked(join(tmpdir(), 'r0913-mdcache2-'))
    mkdirSync(join(dir, '写作', '正文'), { recursive: true })
    const f = join(dir, '写作', '正文', '0001-a.md')
    writeFileSync(f, 'x', 'utf-8')
    expect(readMdTextCached(f)).not.toBeNull()
    expect(forgetMdTextCacheForBook(dir)).toBe(1)
    expect(forgetMdTextCacheForBook(dir)).toBe(0)
  })
})
