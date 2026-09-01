/**
 * R34D-11（三十四轮）回归：.md 扩展名匹配大小写不敏感。
 *
 * 修复背景：win 手工改名 `.MD` 文件对机检/树红点/账本扫描隐形。三处落点：
 * walk-md.ts（共享遍历核心）、leads.ts readLeadDir、draft.ts 同章号损坏旧文件守卫。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkMdFind, walkMdEach } from '../../src/fs/walk-md.js'
import { resolveDraftPath } from '../../src/format/draft.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('R34D-11: walkMdFind/walkMdEach 发现 .MD/.Md 大写扩展名文件', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r34d-walk-md-'))
  try {
    const body = join(root, '写作', '正文')
    mkdirSync(body, { recursive: true })
    writeFileSync(join(body, '12-灭门.MD'), 'x')
    writeFileSync(join(body, '13-余波.md'), 'x')
    writeFileSync(join(body, '14-追凶.Md'), 'x')
    writeFileSync(join(body, 'notes.txt'), 'x') // 非 md 负例

    // walkMdFind 契约：命中短路返回（realpath 命名空间，tmpdir 在 macOS 带 /private 前缀，
    // 只断言 truthy + 尾段文件名）
    const hit = walkMdFind(body, (_abs, name) => (name === '12-灭门.MD' ? name : undefined))
    expect(hit).toBe('12-灭门.MD')

    const names: string[] = []
    walkMdEach(body, (_abs, name) => names.push(name))
    expect(names).toContain('12-灭门.MD')
    expect(names).toContain('13-余波.md')
    expect(names).toContain('14-追凶.Md')
    expect(names).not.toContain('notes.txt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R34D-11: resolveDraftPath 对 .MD 损坏旧文件仍 fail-loud（防同章号双份并存）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'r34d-draft-md-'))
  try {
    const bodyDir = join(root, '写作', '正文')
    mkdirSync(bodyDir, { recursive: true })
    // 未闭合 front matter 的 .MD 旧文件 → readChapterDir errors（非「缺少 front matter」豁免）
    writeFileSync(join(bodyDir, '0003-雪夜.MD'), '---\n章号: 3\n标题: 雪夜\n', 'utf-8')
    // 修复前：`\.md$` 大小写敏感 → 守卫失守 → 静默走新章路径建第二份并存
    expect(() => resolveDraftPath(root, 3)).toThrow(/front matter 损坏/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
