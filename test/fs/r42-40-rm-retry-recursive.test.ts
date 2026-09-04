/**
 * R42-40（四十二轮挂账 → 2026-09-05 收编）回归：rmWithRetry 增设 recursive 档——
 * 目录树删源点（回收站 purge 版本目录连删，document/trash.ts）同享 EPERM/EBUSY 退避。
 *
 * - 递归档真实 fs 删多级目录树成功；
 * - 递归档注入 rm 连抛 2 次 EPERM → 退避序列 50/100ms 后成功（与 renameWithRetry
 *   同口径：3×50ms 指数退避，仅 EPERM/EBUSY 进重试）；
 * - 递归档确定性错误（EACCES）立即上抛不重试（重试白名单契约在递归档不变）；
 * - 缺省非递归形态不变：目录传入恒上抛、目录原样保留（防误用既有防线）；
 * - purgeTrash 版本目录删源点真走递归退避（node:fs 注入一次性 EPERM——win 杀毒/
 *   索引器瞬时锁形态；收编前此处裸 rmSync 直败，收编后退避后删净 + 条目移除）。
 *
 * 夹具：node:fs 注入（r42-doc-domain.test.ts 同款手法）——rmSync 对指定路径的
 * 一次性 EPERM。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failState = vi.hoisted(() => ({
  /** 命中即抛 EPERM 一次（一次性瞬时锁形态，抛后放行）；null = 不拦截。 */
  rmEpisOn: null as string | null,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) => {
      if (typeof p === 'string' && failState.rmEpisOn === p) {
        failState.rmEpisOn = null // 瞬时锁形态：一次后放行
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM' })
      }
      return actual.rmSync(p, opts)
    },
  }
})

import { rmWithRetry } from '../../src/fs/atomic.js'
import { purgeTrash } from '../../src/document/trash.js'
import { VERSIONS_DIR_NAME } from '../../src/document/version.js'

afterEach(() => {
  failState.rmEpisOn = null
})

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'clw-r42-40-'))
}

describe('R42-40：rmWithRetry recursive 档（原语）', () => {
  it('递归档：真实 fs 删多级目录树成功', () => {
    const root = tmpRoot()
    const dir = join(root, '工作区', VERSIONS_DIR_NAME, 'doc_a')
    mkdirSync(join(dir, '快照-1'), { recursive: true })
    writeFileSync(join(dir, '快照-1', 'v.md'), 'x', 'utf-8')
    writeFileSync(join(dir, 'v2.md'), 'y', 'utf-8')
    rmWithRetry(dir, { recursive: true })
    expect(existsSync(dir)).toBe(false)
  })

  it('递归档：注入 rm 连抛 2 次 EPERM → 退避 50/100ms 后成功', () => {
    const calls: string[] = []
    const sleeps: number[] = []
    let n = 0
    rmWithRetry('/some/verDir', {
      recursive: true,
      rm: (p) => {
        calls.push(p)
        if (n++ < 2) throw Object.assign(new Error(`EPERM: ${p}`), { code: 'EPERM' })
      },
      sleep: (ms) => sleeps.push(ms),
    })
    expect(calls).toEqual(['/some/verDir', '/some/verDir', '/some/verDir'])
    expect(sleeps).toEqual([50, 100])
  })

  it('递归档：确定性错误（EACCES）立即上抛不重试', () => {
    const sleeps: number[] = []
    let calls = 0
    expect(() =>
      rmWithRetry('/some/verDir', {
        recursive: true,
        rm: () => {
          calls++
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        },
        sleep: (ms) => sleeps.push(ms),
      }),
    ).toThrow('EACCES')
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('缺省非递归形态不变：目录传入恒上抛、目录原样保留（防误用防线）', () => {
    const root = tmpRoot()
    const dir = join(root, 'adir')
    mkdirSync(dir, { recursive: true })
    expect(() => rmWithRetry(dir)).toThrowError()
    expect(existsSync(dir)).toBe(true)
  })
})

describe('R42-40：purgeTrash 版本目录删源点收编退避', () => {
  it('版本目录首删 EPERM 一次 → 退避后删净 + 条目移除', async () => {
    const root = tmpRoot()
    const trashDir = join(root, '工作区', '.trash')
    mkdirSync(trashDir, { recursive: true })
    const trashedRel = '工作区/.trash/doc_r42-0001-a.md'
    writeFileSync(join(root, trashedRel), '旧内容', 'utf-8')
    writeFileSync(
      join(trashDir, '.trash-manifest.jsonl'),
      JSON.stringify({
        id: 'doc_r42',
        originalPath: '写作/正文/0001-a.md',
        trashedPath: trashedRel,
        trashedAt: '2026-09-05T00:00:00.000Z',
        role: 'chapter',
      }) + '\n',
      'utf-8',
    )
    const verDir = join(root, '工作区', VERSIONS_DIR_NAME, 'doc_r42')
    mkdirSync(verDir, { recursive: true })
    writeFileSync(join(verDir, 'v1.md'), '基线', 'utf-8')
    failState.rmEpisOn = verDir // win 杀毒/索引器一次性瞬时锁形态
    const r = await purgeTrash(root, 'doc_r42')
    expect(r).toEqual({ ok: true, id: 'doc_r42' })
    expect(existsSync(verDir)).toBe(false)
    expect(existsSync(join(root, trashedRel))).toBe(false)
  })
})
