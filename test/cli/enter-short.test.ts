import { test, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doInit } from '../../src/install/init.js'
import { enterCommand } from '../../src/cli/enter.js'

test('enter CLI short: 起草新篇时生成细纲和清单骨架', () => {
  const wd = mkdtempSync(join(tmpdir(), 'enter-short-'))
  const init = doInit({ workDir: wd, name: '夜语集', genre: '悬疑', kind: 'short' })
  expect(init.ok).toBe(true)
  if (!init.ok) return

  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    enterCommand([init.bookRoot])

    const outlinePath = join(init.bookRoot, '工作区', '细纲.md')
    const manifestPath = join(init.bookRoot, '工作区', '清单.md')
    expect(existsSync(outlinePath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)

    const outline = readFileSync(outlinePath, 'utf-8')
    expect(outline).toContain('篇号: 1')
    expect(outline).toContain('核心反转: 待定')
    expect(outline).toContain('## 开头钩子')
    expect(outline).toContain('## 余韵')

    const manifest = readFileSync(manifestPath, 'utf-8')
    expect(manifest).toContain('## 反转线索表')
    expect(manifest).toContain('- [开头钩子] 待补')
    expect(manifest).toContain('## 情绪曲线')
    expect(manifest).toContain('- [反转] 待定 9/10：待补')
    expect(manifest).toContain('## 伏笔回收')

    expect(lines.join('\n')).toContain('已生成短篇起草骨架')
    expect(lines.join('\n')).toContain('【起草新篇】')
    expect(lines.join('\n')).not.toContain('【起草新章】')
  } finally {
    log.mockRestore()
    rmSync(wd, { recursive: true, force: true })
  }
})
