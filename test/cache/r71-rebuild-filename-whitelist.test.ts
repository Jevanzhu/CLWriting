/**
 * R71-37（十九轮）回归：摘要文件名 Number() 过宽——`.md`→0、`0x10.md`→16、
 * `1e2.md`→100、`-3.md`→-3 此前都 Number.isFinite 入表（错章号/负章号污染摘要
 * 联查）；改 /^\d+$/ 严格白名单，不匹配计入 errors（对齐 R62-32 口径）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

function makeBareRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'r71-rebuild-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, book: { title: '书', genre: '玄幻' } })
  return root
}

test('R71-37: 十六进制/科学计数/负数/空名摘要文件 → 拒入表并计入 errors', () => {
  const root = makeBareRoot()
  try {
    const dir = join(root, '定稿', '摘要', '章摘要')
    mkdirSync(dir, { recursive: true })
    // 修复前：0x10→16、1e2→100、-3→-3 都 Number.isFinite 错误入表；`.md`→0 照样入
    for (const bad of ['0x10.md', '1e2.md', '-3.md', '.md']) {
      writeFileSync(join(dir, bad), '内容', 'utf-8')
    }
    writeFileSync(join(dir, '7.md'), '合法摘要', 'utf-8')
    const r = rebuild(root, join(root, '.cache', 'index.db'))
    expect(r.summaryCount).toBe(1) // 只有 7.md 入表
    const badErrors = r.errors.filter((e) => e.message.includes('摘要文件名'))
    expect(badErrors.length).toBe(4)
    for (const bad of ['0x10', '1e2', '-3', '.md']) {
      expect(badErrors.some((e) => e.message.includes(bad === '.md' ? '「.md」' : bad))).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
