/**
 * R57-H-1（五十七轮）：knowledge 登记写入链（读 manifest → 注入 fm → 实算哈希 → 写
 * manifest）的回滚/信封保护此前只盖「manifest 写失败」一点（R73-13）——fm 注入写失败
 * 与注入后哈希读失败两个失败点仍裸抛穿透 KnowledgeManifestReport 信封（R48-39 同款
 * 契约破坏：调用方拿到未声明异常而非 {ok:false}），且哈希读失败时文件已注入 fm、
 * manifest 无条目（R73-13 同款跨文件不一致窗口）。
 *
 * 观测面：两失败点均以 {ok:false, issues[]} 信封返回；注入写失败时零变更（两文件原态，
 * 无半程可回滚）；哈希读失败时回滚 fm 使文件回旧态（幂等可重试）；正常路径不误伤。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 失败注入闸：failInjectWrite 拦定稿 md 的注入写（文件名锚定，manifest 写放行）；
// failHashRead 拦注入后的哈希实算（模拟注入与哈希之间文件不可读）。
const gates = vi.hoisted(() => ({ failInjectWrite: false, failHashRead: false }))

vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...mod,
    atomicWriteFile: (filePath: string, data: string | Uint8Array, opts?: Parameters<typeof mod.atomicWriteFile>[2]) => {
      if (gates.failInjectWrite && filePath.endsWith('机检误报规律-R57.md')) {
        throw new Error('模拟 fm 注入写失败（R57-H-1 注入）')
      }
      return mod.atomicWriteFile(filePath, data, opts)
    },
  }
})

vi.mock('../../src/knowledge/manifest.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/knowledge/manifest.js')>()
  return {
    ...mod,
    hashFileSha256: (filePath: string) => {
      if (gates.failHashRead) throw new Error('模拟注入后哈希读失败（R57-H-1 注入）')
      return mod.hashFileSha256(filePath)
    },
  }
})

import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { hashFileSha256 } from '../../src/knowledge/manifest.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const FINAL = '知识层/机检误报规律-R57.md'
const ORIGINAL = '# 机检误报规律\n## body-parts\n作者归纳……\n'

/** 最小知识层夹具：存量条目 manifest + 定稿文件由各用例自写（对齐 update.test.ts 惯例） */
function fixture(): string {
  const root = mkdtempTracked(join(tmpdir(), 'knowledge-r57-'))
  mkdirSync(join(root, '知识层'), { recursive: true })
  writeFileSync(join(root, '知识层', '存量.md'), '---\nsource: 旧来源\nlicense: MIT\n---\n\n# 存量\n', 'utf8')
  const entries = [
    {
      target: '知识层/存量.md',
      source: '旧来源',
      license: 'MIT',
      sha256: hashFileSha256(join(root, '知识层', '存量.md')),
      category: '索引' as const,
    },
  ]
  writeFileSync(
    join(root, '知识层', '_manifest.json'),
    JSON.stringify({ version: 1, generated_at: '2026-08-15T00:00:00+08:00', summary: { migrated: 1, deferred: 0, review_assets: 0 }, entries }, null, 2) + '\n',
    'utf8',
  )
  return root
}

describe('R57-H-1：登记写入链前置失败点的信封收口', () => {
  it('fm 注入写失败 → {ok:false} 信封返回（修复前裸抛穿透），文件未注入、manifest 零写入（无残留）', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, FINAL), ORIGINAL, 'utf8')
      const manifestBefore = readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')

      gates.failInjectWrite = true
      let report!: ReturnType<typeof commitKnowledgeFile>
      expect(() => {
        report = commitKnowledgeFile(root, { target: FINAL, now: '2026-09-06T12:00:00+08:00' })
      }).not.toThrow()
      gates.failInjectWrite = false

      expect(report.ok).toBe(false)
      expect(report.issues).toHaveLength(1)
      expect(report.issues[0]!.path).toBe(FINAL)
      expect(report.issues[0]!.message).toContain('front matter 注入失败')
      expect(report.issues[0]!.message).toContain('可重试')
      // 无残留：定稿保持原文（未注入 source/license）、manifest 无新条目
      expect(readFileSync(join(root, FINAL), 'utf8')).toBe(ORIGINAL)
      expect(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')).toBe(manifestBefore)
    } finally {
      gates.failInjectWrite = false
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('注入后哈希读失败 → 回滚 fm 注入（文件恢复原文）、manifest 零写入，报错可读可重试', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, FINAL), ORIGINAL, 'utf8')
      const manifestBefore = readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')

      gates.failHashRead = true
      const report = commitKnowledgeFile(root, { target: FINAL, now: '2026-09-06T12:00:00+08:00' })
      gates.failHashRead = false

      expect(report.ok).toBe(false)
      expect(report.issues).toHaveLength(1)
      expect(report.issues[0]!.message).toContain('哈希')
      expect(report.issues[0]!.message).toContain('已回滚 front matter 注入')
      // 回滚后两文件同回旧态（对齐 R73-13 回滚语义），幂等可重试
      expect(readFileSync(join(root, FINAL), 'utf8')).toBe(ORIGINAL)
      expect(readFileSync(join(root, '知识层', '_manifest.json'), 'utf8')).toBe(manifestBefore)
    } finally {
      gates.failHashRead = false
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不误伤：注入与哈希均正常 → 照常登记成功（守卫只收口失败路径）', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, FINAL), ORIGINAL, 'utf8')
      const report = commitKnowledgeFile(root, { target: FINAL, now: '2026-09-06T12:00:00+08:00' })
      expect(report.ok, report.issues.map((i) => i.message).join(';')).toBe(true)
      expect(readFileSync(join(root, FINAL), 'utf8')).toContain('source: 语料回归域')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
