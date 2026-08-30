/**
 * C-6（二十九轮）回归：migrateVersionsDir rename 失败不再静默（warn 留痕 + 返回 false）。
 *
 * 失败（权限/占用）时保留旧目录、读取方仍兼容——行为不变；本回归验证失败路径的
 * 返回值与两侧目录状态（留痕本身不重复断言日志内容，遵循「日志只加观测不改语义」）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// renameSync 定点失败注入：只对 .snapshots → .版本 的迁移 rename 抛错（不误伤夹具自身写入）
const FAIL = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: ((from: string, to: string) => {
      if (FAIL.enabled && from.endsWith('.snapshots') && to.endsWith('.版本')) {
        throw Object.assign(new Error('模拟迁移失败（EBUSY 形态）'), { code: 'EBUSY' })
      }
      return (actual.renameSync as typeof renameSync)(from, to)
    }) as typeof renameSync,
  }
})

import { migrateVersionsDir, LEGACY_SNAPSHOTS_DIR_NAME, VERSIONS_DIR_NAME } from '../../src/document/version.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r29-vermig-'))
  FAIL.enabled = false
})

afterEach(() => {
  FAIL.enabled = false
  rmSync(root, { recursive: true, force: true })
})

describe('C-6 / migrateVersionsDir 失败留痕', () => {
  it('rename 失败 → 返回 false，旧目录原样保留、目标未建（读取方仍兼容旧位）', () => {
    const legacy = join(root, '工作区', LEGACY_SNAPSHOTS_DIR_NAME)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '01JXYZ.md'), '---\n---\n\n旧快照\n', 'utf-8')
    FAIL.enabled = true
    expect(migrateVersionsDir(root)).toBe(false)
    expect(existsSync(join(legacy, '01JXYZ.md'))).toBe(true)
    expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME))).toBe(false)
  })

  it('无失败 → 照常迁移成功（对照，不回归）', () => {
    const legacy = join(root, '工作区', LEGACY_SNAPSHOTS_DIR_NAME)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '01JXYZ.md'), '---\n---\n\n旧快照\n', 'utf-8')
    expect(migrateVersionsDir(root)).toBe(true)
    expect(existsSync(join(root, '工作区', VERSIONS_DIR_NAME, '01JXYZ.md'))).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })
})
