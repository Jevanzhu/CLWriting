/**
 * R0913-win P3（2026-09-13 全库源码重评 win 适配修复批）：doCreate 深层路径超长的
 * 错误分诊回归——ENAMETOOLONG 收 BAD_INPUT 人话（客户端可修），其余写错误维持
 * WRITE_ERROR 信封。
 *
 * 平台性：>260 单位深路径在长路径启用的卷（libuv \\?\ 前缀）上可正常建——用例先做
 * 同深度运行时探测（R71-8 惯例：不假设宿主配置），按探测结果分支断言，三腿 CI 与
 * 长路径开/关的本机都确定。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'

let bookRoot: string
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r0913-longpath-'))
  mkdirSync(join(bookRoot, '笔记'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

/** 同深度运行时探测：宿主盘是否允许该深度落盘（长路径启用 → true）。 */
function hostAllowsDeepPaths(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'r0913-lp-probe-'))
  try {
    const deep = join(probe, ...Array.from({ length: 40 }, (_, i) => `层级目录段${i}`), 'probe.md')
    mkdirSync(dirname(deep), { recursive: true })
    writeFileSync(deep, 'x', 'utf-8')
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

describe('R0913-win P3：doCreate 深层路径超长分诊', () => {
  it('40 层深 relPath：宿主允许深路径 → 正常建；超限盘 → BAD_INPUT 人话（非裸 errno WRITE_ERROR）', async () => {
    const deepRel = ['笔记', ...Array.from({ length: 40 }, (_, i) => `层级目录段${i}`), '0001-x.md'].join('/')
    const r = await svc.createDocument({ relPath: deepRel, content: '' })
    if (hostAllowsDeepPaths()) {
      expect(r.ok).toBe(true)
    } else {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('BAD_INPUT')
        expect(r.reason).toContain('路径过长')
      }
    }
  })
})
