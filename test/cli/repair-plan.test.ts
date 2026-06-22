import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairPlanCommand } from '../../src/cli/repair-plan.js'
import { writePiece } from '../../src/format/pieces.js'
import { writePieceList } from '../../src/format/manifest.js'

describe('repair-plan CLI', () => {
  let root: string
  let stdout = ''
  let stderr = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clwriting-repair-plan-cli-'))
    stdout = ''
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.map(String).join(' ') + '\n'
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${String(code)}`)
    }) as typeof process.exit)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('短篇书输出重修计划', () => {
    writeFileSync(
      join(root, 'book.yaml'),
      [
        'spec_version: 1',
        'kind: short',
        '',
        'book:',
        '  title: 返修样本',
        '  genre: 悬疑',
        '',
        'budget:',
        '  calls_per_chapter: 8',
        '',
        'style:',
        '  injection: light',
        '',
        'short:',
        '  profile: 悬疑反转',
        '  word_min: 6000',
        '  word_max: 16000',
      ].join('\n'),
      'utf-8',
    )
    const dir = join(root, '篇', '001-薄反转')
    mkdirSync(dir, { recursive: true })
    writePiece(join(dir, '正文.md'), {
      篇号: 1,
      标题: '薄反转',
      目标情绪: '惊悚',
      核心反转: '待补',
    }, '很短的正文')
    writePieceList(join(dir, '清单.md'), {
      反转线索表: {
        核心反转: '待补',
        铺垫点: [{ 位置: '开头', 内容: '脚印' }],
      },
      情绪曲线: [{ 段落: '反转', 情绪: '震惊', 强度: 5 }],
      伏笔回收: [{ 伏笔: '脚印', 回收位置: '', 未回收: true }],
    })

    repairPlanCommand([root])

    expect(stdout).toContain('短篇重修计划')
    expect(stdout).toContain('【高】第 1 篇「薄反转」')
    expect(stdout).toContain('先重写一句核心反转')
  })

  it('非短篇书拒绝运行', () => {
    writeFileSync(
      join(root, 'book.yaml'),
      'spec_version: 1\n\nbook:\n  title: 长篇\n  genre: 玄幻\n',
      'utf-8',
    )

    expect(() => repairPlanCommand([root])).toThrow(/process.exit 1/)
    expect(stderr).toContain('repair-plan 目前只支持短篇书')
  })
})
