/**
 * R40-14（四十轮平台批，2026-09-04 补覆盖）：bookHash win32 trueCasePath 归一。
 *
 * 覆盖缺口记档：trueCasePath（逐段 readdir 大小写不敏感匹配盘上真名）系 win32
 * 专属路径，mac/linux 上 `process.platform === 'win32'` 守卫恒假 → 63 行永不执行，
 * events 桶自 97.25（2026-08-27 基线）跌至 94.02 破 95 门（R41 修复批收口终门
 * 发现；平台规范化批 a2a0929 并入时未复跑 coverage，存量漂移）。本文件钉
 * platform=win32 + mock readdirSync 走真分支——mac 上可全量覆盖 win32 专属臂。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'

const fsState = vi.hoisted(() => ({
  /** 模拟盘上目录名 → 实际 entries（大小写真形） */
  dirs: new Map<string, string[]>(),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: (p: string, ...rest: unknown[]) => {
      const hit = fsState.dirs.get(p)
      if (hit !== undefined) return hit
      return actual.readdirSync(p, ...(rest as []))
    },
  }
})

import { bookHash } from '../../src/events/store.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  fsState.dirs.clear()
})

describe('R40-14: bookHash win32 trueCasePath 归一（钉 win32 + mock 盘上真名）', () => {
  it('大小写漂移拼写归一到盘上真名 → 同一书一个库键（不开第二库）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // 盘上真形：/tmp（首段按 UNC 形 \\tmp readdir）→ Books → MyBook
    fsState.dirs.set('\\tmp', ['Books', '别的'])
    fsState.dirs.set('\\tmp\\Books', ['MyBook'])
    // 三种漂移拼写（盘符/段大小写各异）→ 全部归一 \\tmp\Books\MyBook → 同 hash
    const a = bookHash('/tmp/books/mybook')
    const b = bookHash('/tmp/BOOKS/MYBOOK')
    const c = bookHash('/tmp/Books/MyBook')
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('段消失/不可读 → 回落词法形态（memo 以小写为键，大小写变体仍合流一键）', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    fsState.dirs.set('\\tmp', ['Books'])
    // 'ghost' 段盘上无 → ok=false → 回落 resolve 词法形态。回落结果经 trueCaseCache
    //（键 = 小写全路径）记忆：大小写变体合流到首见拼写一键——win32 大小写不敏感
    // FS 下 /tmp/ghost/x 与 /tmp/GHOST/x 本就是同一路径，合流即正确语义（不会开双库）
    const a = bookHash('/tmp/ghost/x')
    const b = bookHash('/tmp/GHOST/x')
    expect(a).toBe(b)
    // 不同缺失路径仍不同键（回落不串扰存在的键空间）
    expect(bookHash('/tmp/ghost/x')).not.toBe(bookHash('/tmp/ghost/z'))
  })

  it('posix 不折叠（R41-13 维持口径）：大小写变体是不同路径', () => {
    // 不钉 win32（mac/linux 本腿）——trueCasePath 不进，键 = resolve 词法形态
    expect(bookHash('/tmp-definitely-not-there/CaseA')).not.toBe(bookHash('/tmp-definitely-not-there/casea'))
  })
})
