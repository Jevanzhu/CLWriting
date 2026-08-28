/**
 * 清单检文件链（批 3）：短篇写稿后同步 AI 章纲。
 *
 * 覆盖 syncChapterOutline：
 * - 短篇 + 有 细纲.md → 同步到大纲/章纲/<正文basename>
 * - 长篇 → 跳过
 * - 无细纲 → 跳过
 * - 非标准正文文件名 → 跳过
 */
import { test, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncChapterOutline } from '../../src/process/draft-pipeline.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeBook(kind: 'long' | 'short'): string {
  const root = mkdtempTracked(join(tmpdir(), 'sync-outline-'))
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '大纲'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: ' + kind + '\nbook:\n  title: 测试\nhost: cc\n',
    'utf-8',
  )
  writeFileSync(join(root, '工作区', '细纲.md'), '## 反转线索表\n- 核心反转：来客就是死者\n- [开头] 尸体敲门\n', 'utf-8')
  return root
}

test('syncChapterOutline: 短篇 + 有细纲 → 同步到大纲/章纲/<正文basename>', () => {
  const root = makeBook('short')
  try {
    const ok = syncChapterOutline(root, '写作/正文/001-夜访者.md')
    expect(ok).toBe(true)
    const target = join(root, '大纲', '章纲', '001-夜访者.md')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf-8')).toContain('来客就是死者')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncChapterOutline: 长篇 → 跳过（不落章纲）', () => {
  const root = makeBook('long')
  try {
    const ok = syncChapterOutline(root, '写作/正文/001-开篇.md')
    expect(ok).toBe(false)
    expect(existsSync(join(root, '大纲', '章纲', '001-开篇.md'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncChapterOutline: 无细纲 → 跳过', () => {
  const root = makeBook('short')
  try {
    rmSync(join(root, '工作区', '细纲.md'))
    expect(syncChapterOutline(root, '写作/正文/001-夜访者.md')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncChapterOutline: 非标准正文文件名（无章号前缀）→ 跳过', () => {
  const root = makeBook('short')
  try {
    expect(syncChapterOutline(root, '写作/正文/前言.md')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RB-IF-P2-4: 章纲已存在且内容不同（作者手改）→ 不覆盖', () => {
  const root = makeBook('short')
  try {
    // 首次同步创建章纲
    expect(syncChapterOutline(root, '写作/正文/001-夜访者.md')).toBe(true)
    const target = join(root, '大纲', '章纲', '001-夜访者.md')
    // 作者手改章纲
    writeFileSync(target, '## 反转线索表\n- 核心反转：作者亲手改过的版本\n', 'utf-8')
    // 再次保存草稿 → 不得把手改内容覆盖回细纲
    expect(syncChapterOutline(root, '写作/正文/001-夜访者.md')).toBe(false)
    expect(readFileSync(target, 'utf-8')).toContain('作者亲手改过的版本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RB-IF-P2-4: 章纲已存在且内容相同 → no-op 返回 true（幂等语义保留）', () => {
  const root = makeBook('short')
  try {
    expect(syncChapterOutline(root, '写作/正文/001-夜访者.md')).toBe(true)
    expect(syncChapterOutline(root, '写作/正文/001-夜访者.md')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
