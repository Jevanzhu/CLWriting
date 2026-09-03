/**
 * probeCaseSensitive 单测（平台规范化批一 E，2026-09-03）：注入依赖直测三臂。
 *
 * 探测法 = 写小写探针文件、查大写形是否可见：不敏感卷 lookup 恒命中。生产路径
 * （node:fs）在 win/默认 mac 卷上恒走 false 臂——注入版可测 true/null，无需敏感卷宿主。
 */
import { describe, expect, it } from 'vitest'
import { probeCaseSensitive, type CaseProbeDeps } from '../../src/fs/case-probe.js'

/** 记录式假 fs：writes/existing 可编程。 */
function fakeDeps(opts: { upperVisible: boolean; throwOnWrite?: boolean }): CaseProbeDeps & { removed: string[]; written: string[] } {
  const written: string[] = []
  const removed: string[] = []
  return {
    written,
    removed,
    writeFile(p) {
      if (opts.throwOnWrite) throw new Error('EACCES: not writable')
      written.push(p)
    },
    exists(p) {
      // 大写形可见性可编程；小写探针自身恒可见（刚写入）
      return opts.upperVisible && p.includes('CLW-CASE-PROBE')
    },
    remove(p) {
      removed.push(p)
    },
  }
}

describe('probeCaseSensitive', () => {
  it('大写形不可见 → true（敏感卷，建议警告）', () => {
    const deps = fakeDeps({ upperVisible: false })
    expect(probeCaseSensitive('/mnt/case-sensitive', deps)).toBe(true)
    expect(deps.written).toHaveLength(1)
    // 探针自清理：两个形都尝试删（敏感卷上大写形本不存在，remove 兜底无副作用）
    expect(deps.removed.length).toBeGreaterThanOrEqual(1)
  })

  it('大写形可见 → false（不敏感卷，win/默认 mac 主流形态）', () => {
    const deps = fakeDeps({ upperVisible: true })
    expect(probeCaseSensitive('C:\\Books', deps)).toBe(false)
  })

  it('写探针失败（目录不可写）→ null（fail-open，探测不挡书库主流程）', () => {
    const deps = fakeDeps({ upperVisible: false, throwOnWrite: true })
    expect(probeCaseSensitive('/read-only', deps)).toBeNull()
  })
})
