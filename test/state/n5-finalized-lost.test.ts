/**
 * N5（五十九轮）回归：已定稿文件被外部删除 → 归入态 1 issues「已定稿文件丢失」。
 *
 * 旧实现 detectHandEdits 对 rev===null（文件不在盘）静默跳过、无任何健康出口
 * （静默丢章：章号推算只看盘上文件，缺章无感知）。
 */
import { test, expect } from 'vitest'
import { rmSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBookWithChapters } from '../helpers/book.js'
import { detectState, routeState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

const FAST_CHAPTER_FIXTURE = { commitEach: false }

test('N5: 已定稿章文件被外部删除 → 态 1（finalizedLost issue，先于态 3/7 判定）', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  unlinkSync(join(root, '写作', '正文', '0002-第2章.md'))
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state !== 1) return
  const lost = d.issues.find((i) => i.kind === 'finalizedLost')
  expect(lost).toBeDefined()
  expect(lost?.humanMsg).toContain('0002-第2章.md')
  expect(lost?.fix).toContain('版本历史')
  // 路由人话可读（交作者裁决）
  const route = routeState(d)
  expect(route.humanMsg).toContain('已定稿文件')
  rmSync(root, { recursive: true, force: true })
})

test('N5: 定稿条目 path 被篡改为越出书仓库 → 同样报 finalizedLost（不静默）', () => {
  const root = makeGitBookWithChapters(2, FAST_CHAPTER_FIXTURE)
  // 篡改清单：某定稿条目 path 指向书仓库外（safeManifestPath 拒 → abs===null 分支）
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const lines = readFileSync(manifestPath, 'utf8').split('\n').filter((l: string) => l.trim())
  const rewritten = lines.map((l: string) => {
    if (l.includes('0001-')) {
      const obj = JSON.parse(l) as { path: string }
      obj.path = '写作/正文/../../../outside.md'
      return JSON.stringify(obj)
    }
    return l
  })
  writeFileSync(manifestPath, rewritten.join('\n') + '\n', 'utf8')
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state !== 1) return
  expect(d.issues.some((i) => i.kind === 'finalizedLost' && i.files?.includes('写作/正文/../../../outside.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('N5: 全部定稿文件在盘 → 无 finalizedLost（不误报）', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  const d = detectState(root, DEFAULT_CONFIG)
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'finalizedLost')).toBe(false)
  } else {
    expect([2, 3, 4, 5, 7]).toContain(d.state)
  }
  rmSync(root, { recursive: true, force: true })
})
