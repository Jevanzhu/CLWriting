/**
 * providers 损坏恢复段安全性（源码锚注：RC 源码重审 A-7，Opus-5.5 轮）。
 *
 * 三条不变量（对应 src/ai/provider/store.ts tryRestoreFromBak）：
 * ① bak 缺失/不可读 → 主文件原封不动：修复前 rmQuietly(fp) 先于 readFileSync(bakFp)，
 *    bak 读失败时主文件已被无痕删除，而调用点文案却称「损坏文件保留」；
 * ② 进入「留证 + 写回」段后失败 → 原损坏字节必在 providers.json.corrupt-<ts>，错误
 *    文案带出留证路径（不再有与处置相反的声称）；
 * ③ 写锁被占 → 本轮跳过、主文件原封不动（修复前恢复段不持锁，可与并发 save 交错覆盖）；
 * ④ 锁内复核 → 取值窗口内主文件已被并发写方修复时不覆盖（不把新配置打回旧 bak 快照）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import {
  loadProviders,
  saveProviders,
  emptySettings,
} from '../../../src/ai/provider/store.js'
import { tryAcquireCrossProcessLock } from '../../../src/fs/cross-process-lock.js'

const CORRUPT = '{ broken json !!!'

let dir: string

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-bak-restore-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FP = () => join(dir, 'providers.json')
const BAK = () => join(dir, 'providers.bak.json')
const LOCK = () => join(dir, 'providers.json.lock')

/** 造「主文件损坏 + bak 可用」现场：两笔 save（第二笔写前备份生成 bak，口径同 S5-D7）。 */
function seedCorruptWithBak(corruptBytes = CORRUPT): void {
  const seed = emptySettings()
  saveProviders(dir, seed)
  saveProviders(dir, seed) // 第二笔：主文件在位 → 写前备份生成 providers.bak.json
  expect(existsSync(BAK())).toBe(true)
  writeFileSync(FP(), corruptBytes, 'utf8')
}

/** .corrupt-* 留证文件名（时间戳后缀不可预知；排序稳定便于断言）。 */
function corruptSiblings(): string[] {
  return readdirSync(dir)
    .filter((n) => n.startsWith('providers.json.corrupt-'))
    .sort()
}

describe('providers 损坏恢复段安全性（A-7）', () => {
  it('① bak 存在但不可读 → 抛错、主文件字节不变、无 .corrupt-* 留证', () => {
    seedCorruptWithBak()
    let err: unknown
    try {
      // R0916-7-P3-6：fs 依赖改逐调用参数注入（原 __setProvidersRestoreDepsForTest）
      loadProviders(dir, {
        restoreFs: {
          readBak: () => {
            throw new Error('EACCES: 模拟 bak 不可读')
          },
        },
      })
    } catch (e) {
      err = e
    }
    const msg = String(err)
    expect(msg).toContain('备份恢复亦失败')
    expect(msg).toContain('备份文件不可读') // 原因如实透出（不再谎称「原文件保留」而已删）

    // 核心：主文件字节逐位不变（修复前 rmQuietly 已把它删掉，此处必红）
    expect(existsSync(FP())).toBe(true)
    expect(readFileSync(FP(), 'utf8')).toBe(CORRUPT)
    expect(corruptSiblings()).toEqual([])
  })

  it('② bak 可读但写回失败 → 原损坏字节留证为 providers.json.corrupt-<ts>、主文件缺失、文案带留证路径', () => {
    seedCorruptWithBak()
    const bakBytes = readFileSync(BAK())
    let err: unknown
    try {
      // R0916-7-P3-6：fs 依赖改逐调用参数注入（原 __setProvidersRestoreDepsForTest）
      loadProviders(dir, {
        restoreFs: {
          writeMain: () => {
            throw new Error('ENOSPC: 模拟写回失败')
          },
        },
      })
    } catch (e) {
      err = e
    }
    const msg = String(err)
    expect(msg).toContain('备份恢复亦失败')
    expect(msg).toContain('ENOSPC')

    const siblings = corruptSiblings()
    expect(siblings).toHaveLength(1)
    const corruptFp = join(dir, siblings[0]!)
    expect(readFileSync(corruptFp, 'utf8')).toBe(CORRUPT) // 原字节留证，不无痕丢失
    expect(msg).toContain(corruptFp) // 文案含留证路径（用户可据此手动回填）
    expect(existsSync(FP())).toBe(false) // 留证改名已移走主文件，写回失败 → 原名无文件
    expect(readFileSync(BAK())).toEqual(bakBytes) // bak 只读不动，仍是恢复通道
  })

  it('③ 写锁被占 → 本轮跳过（主文件原封不动、无恢复写入），释放后下次 load 自愈', () => {
    seedCorruptWithBak()
    const bakBytes = readFileSync(BAK())
    const release = tryAcquireCrossProcessLock(LOCK())
    expect(release).not.toBeNull() // 同进程持锁即「他方在写」形态（活 pid 判 held、不接管）

    try {
      let err: unknown
      try {
        loadProviders(dir)
      } catch (e) {
        err = e
      }
      expect(String(err)).toContain('备份恢复亦失败')
      expect(String(err)).toContain('写锁被占用') // 跳过原因如实透出（非「文件损坏）」
      // 主文件未被清、bak 未被写回（无交错覆盖）
      expect(readFileSync(FP(), 'utf8')).toBe(CORRUPT)
      expect(corruptSiblings()).toEqual([])
      expect(readFileSync(BAK())).toEqual(bakBytes)
    } finally {
      release!()
    }

    // 本轮跳过 ≠ 永久失败：锁释放后下次 load 照常自愈
    const loaded = loadProviders(dir)
    expect(loaded.providers).toEqual([])
    expect(existsSync(FP())).toBe(true)
    expect(corruptSiblings()).toHaveLength(1)
  })

  it('④ 锁内复核：取值窗口内主文件已被并发写方修复 → 不覆盖（bak 旧快照不落位）', () => {
    seedCorruptWithBak()
    const FIXED = JSON.stringify({ providers: [], currentId: 'fixed-by-other-writer' })
    // R0916-7-P3-6：注入的 readBak 在「读 bak 期间并发写方已把主文件修复」窗口内改盘
    const loaded = loadProviders(dir, {
      restoreFs: {
        readBak: (p) => {
          writeFileSync(FP(), FIXED, 'utf8')
          return readFileSync(p)
        },
      },
    })
    expect(loaded.providers).toEqual([])
    expect(loaded.currentId).toBe('fixed-by-other-writer') // 读到的是并发写方的版本
    expect(readFileSync(FP(), 'utf8')).toBe(FIXED) // 未被旧 bak 快照整态覆盖
    expect(corruptSiblings()).toEqual([]) // 未走留证（没销毁并发写方的文件）
  })
})
