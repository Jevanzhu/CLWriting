/**
 * R0912-5（2026-09-11 重评-0911c 修复批）：版本列表 ULID 排序改字节序比较。
 *
 * 修复前：listVersions 用 `id.localeCompare`——排序规则随运行环境 ICU/locale 漂移，
 * 「时间序 = 列表序」依赖 locale 行为。修复后改字节序比较（`a < b` 形态）：ULID 是
 * 26 字符 Crockford base32（全大写 ASCII，0-9 在前 A-Z 在后），字节序即编码序，
 * 高位在前 ⇒ 字节序降序 = 时间降序，与 locale 无关。
 *
 * 性质锚定：任意 id 集合上，列表相邻对满足「字节序降序」且「decodeUlidTime 降序」；
 * 同毫秒并生（随机段不同）时时间相等仍按字节序确定收敛。
 */
import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listVersions } from '../../src/document/version.js'
import { ulid, decodeUlidTime } from '../../src/document/stable-id.js'

const versionsDir = join(tmpdir(), 'r0912-sort-versions')
const DOC = 'doc_sortcheck'

function plantVersion(id: string): void {
  const dir = join(versionsDir, DOC)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.md`),
    `---\n版本ID: ${id}\n时间: ${new Date(decodeUlidTime(id)).toISOString()}\n来源: manual\n---\n\n内容\n`,
    'utf-8',
  )
}

test('R0912-5: 列表序 = 字节序降序 = 时间降序（不依赖 locale）', () => {
  try {
    // 跨毫秒多版本 + 同毫秒并生（随机段不同）混排
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push(ulid())
      ids.push(ulid()) // 一半概率与上一枚同 ms（时间相等，字节序仍须确定收敛）
    }
    for (const id of ids) plantVersion(id)
    const list = listVersions(versionsDir, DOC)
    expect(list).toHaveLength(ids.length)
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i]!.id
      const next = list[i + 1]!.id
      // 字节序降序（R0912-5 判据本体：不允许 localeCompare 的环境等价类扰动）
      expect(cur > next || cur < next).toBe(true) // 无相等对（id 唯一）
      expect(cur > next).toBe(true)
      // 时间不升（decodeUlidTime 单调；同 ms 相等允许）
      expect(decodeUlidTime(cur)).toBeGreaterThanOrEqual(decodeUlidTime(next))
    }
  } finally {
    rmSync(versionsDir, { recursive: true, force: true })
  }
})
