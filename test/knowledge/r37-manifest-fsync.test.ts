/**
 * R37-43（三十七轮）：knowledge manifest 落盘显式 fsync 回归。
 * _manifest.json 是知识层对账单源——崩溃窗口丢清单 = 知识目录与清单失配。登记
 * 路径（commitKnowledgeFile）的 atomicWriteFile 必须显式传 { fsync: true }（对齐
 * metrics/style.ts N-12 等高价值落盘口径；atomicWriteFile 缺省亦 true（T2-5），
 * 本断言防未来缺省漂移——fs 本体的 fsync 行为已由 test/fs/atomic.test.ts T2-5 覆盖，
 * 此处只锁 update 调用点的传参）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashFileSha256 } from '../../src/knowledge/manifest.js'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// R37-43：透传记录器——捕获 update 路径全部 atomicWriteFile 实参（filePath/opts），
// 落盘仍走真实实现（mock 只旁路记录，validateKnowledgeManifest 照常对账通过）
const atomicCalls = vi.hoisted(() => [] as Array<{ filePath: string; opts: unknown }>)
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...mod,
    atomicWriteFile: (
      filePath: string,
      data: string | Uint8Array,
      opts?: Parameters<typeof mod.atomicWriteFile>[2],
    ) => {
      atomicCalls.push({ filePath, opts })
      return mod.atomicWriteFile(filePath, data, opts)
    },
  }
})

describe('R37-43: knowledge manifest 落盘显式 fsync', () => {
  it('commitKnowledgeFile：_manifest.json 写入显式传 { fsync: true }', () => {
    const root = mkdtempTracked(join(tmpdir(), 'knowledge-r37-43-'))
    try {
      mkdirSync(join(root, '知识层'), { recursive: true })
      writeFileSync(join(root, '知识层', '存量.md'), '---\nsource: 旧来源\nlicense: MIT\n---\n\n# 存量\n', 'utf8')
      writeFileSync(
        join(root, '知识层', '_manifest.json'),
        JSON.stringify(
          {
            version: 1,
            generated_at: '2026-08-15T00:00:00+08:00',
            summary: { migrated: 1, deferred: 0, review_assets: 0 },
            entries: [
              {
                target: '知识层/存量.md',
                source: '旧来源',
                license: 'MIT',
                sha256: hashFileSha256(join(root, '知识层', '存量.md')),
                category: '索引',
              },
            ],
          },
          null,
          2,
        ) + '\n',
        'utf8',
      )
      const finalRel = '知识层/新规律.md'
      writeFileSync(join(root, finalRel), '# 新规律\n## body-parts\n作者归纳……\n', 'utf8')

      atomicCalls.length = 0
      const report = commitKnowledgeFile(root, { target: finalRel, now: '2026-09-02T12:00:00+08:00' })
      expect(report.ok, report.issues.map((i) => i.message).join(';')).toBe(true)

      // manifest 写入点：显式 { fsync: true }（修复前不传 opts——依赖缺省，意图不自明）
      const manifestWrite = atomicCalls.find((c) => c.filePath.endsWith('_manifest.json'))
      expect(manifestWrite).toBeDefined()
      expect(manifestWrite!.opts).toEqual({ fsync: true })

      // 对照：登记链的 fm 注入写（定稿文件）不扩面断言，但清单写必须带 fsync——
      // 至少存在一次带 { fsync: true } 的落盘调用且指向 manifest
      expect(atomicCalls.some((c) => c.filePath.endsWith('_manifest.json') && (c.opts as { fsync?: boolean })?.fsync === true)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
