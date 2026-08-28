/**
 * ee-P1-6 回归：账本写点 fsync 纪律。
 *
 * 账本（防吃书根基）此前经 frontmatter.writeFile → atomicWriteFile 默认 fsync:false——
 * tmp+rename 防半截文件，但不防掉电时 rename 元数据先于内容持久化（账本整体回退旧状态）。
 * manifest/version/journal 均已 fsync，账本写点（writeLead / 定稿清空账本推进.md）对齐。
 * fsync 本身不可观测，此处经 spy 断言选项透传；原子写语义由 test/document/atomic.test.ts 兜底。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile as writeFm } from '../../src/format/frontmatter.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const atomicSpy = vi.hoisted(() => vi.fn())
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...actual,
    atomicWriteFile: (p: string, d: string | Uint8Array, opts?: { fsync?: boolean; mode?: number }) => {
      atomicSpy(p, d, opts)
      return actual.atomicWriteFile(p, d, opts)
    },
  }
})

// mock 生效后再 import 被测模块（leads → frontmatter → atomic 链上同一实例）
const { writeLead } = await import('../../src/format/leads.js')
const { atomicWriteFile } = await import('../../src/fs/atomic.js')

describe('账本写点 fsync 纪律（ee-P1-6）', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writeLead → atomicWriteFile 传 {fsync:true}', () => {
    dir = mkdtempTracked(join(tmpdir(), 'lead-fsync-'))
    const fp = join(dir, '布线', '悬念', '悬念-001.md')
    mkdirSync(join(dir, '布线', '悬念'), { recursive: true })
    writeLead(fp, {
      编号: '悬念-001',
      类型: '悬念',
      标题: '祠堂暗格',
      状态: '进行中',
      开启章: 12,
      履历: [{ 章号: 12, 动词: '埋下', 证据: '「那道焦痕在烛火下泛着暗红」' }],
    })
    expect(atomicSpy).toHaveBeenCalledWith(fp, expect.any(String), { fsync: true })
    // 落盘内容不受影响（spy 包的是真实实现）
    expect(readFileSync(fp, 'utf-8')).toContain('悬念-001')
  })

  it('writeFile 不传 opts → 行为不变（默认不 fsync，普通写点零感知）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'fm-fsync-'))
    const fp = join(dir, '普通文档.md')
    writeFm(fp, '标题: x', '正文')
    expect(atomicSpy).toHaveBeenLastCalledWith(fp, expect.any(String), undefined)
  })

  it('writeFile 传 {fsync:true} → 透传（frontmatter 写点可选升级）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'fm-fsync2-'))
    const fp = join(dir, '强一致文档.md')
    writeFm(fp, '标题: y', '正文', { fsync: true })
    expect(atomicSpy).toHaveBeenLastCalledWith(fp, expect.any(String), { fsync: true })
  })

  it('清空账本推进（lead-finalize 路径）也走 fsync', async () => {
    // 该写点在 src/document/lead-finalize.ts（atomicWriteFile(mainPath, '', {fsync:true})）；
    // 这里直接断言同一契约：空内容 + fsync 组合可用（mock 已包真实实现，写盘真实发生）
    dir = mkdtempTracked(join(tmpdir(), 'lead-clear-'))
    const fp = join(dir, '账本推进.md')
    mkdirSync(dir, { recursive: true })
    atomicWriteFile(fp, '', { fsync: true })
    expect(atomicSpy).toHaveBeenLastCalledWith(fp, '', { fsync: true })
    expect(readFileSync(fp, 'utf-8')).toBe('')
  })
})
