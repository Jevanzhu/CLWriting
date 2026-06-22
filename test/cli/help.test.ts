import { test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkCommand } from '../../src/cli/check.js'
import { confirmCommand } from '../../src/cli/confirm.js'
import { enterCommand } from '../../src/cli/enter.js'
import { finalizeCommand } from '../../src/cli/finalize.js'
import { healthCommand } from '../../src/cli/health.js'
import { knowledgeCommand } from '../../src/cli/knowledge.js'
import { revertCommand } from '../../src/cli/revert.js'
import { reviewCommand } from '../../src/cli/review.js'
import { rolesCommand } from '../../src/cli/roles.js'
import { sessionStartCommand } from '../../src/cli/session-start.js'

function captureHelp(run: () => void): string {
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit ${String(code)}`)
  }) as typeof process.exit)

  try {
    run()
    expect(exit).not.toHaveBeenCalled()
    return lines.join('\n')
  } finally {
    log.mockRestore()
    error.mockRestore()
    exit.mockRestore()
  }
}

test('CLI 子命令 --help 只打印用法，不误当业务参数', () => {
  const cases: [string, () => void][] = [
    ['enter', () => enterCommand(['--help'])],
    ['health', () => healthCommand(['--help'])],
    ['revert', () => revertCommand(['--help'])],
    ['confirm', () => confirmCommand(['--help'])],
    ['check', () => checkCommand(['--help'])],
    ['finalize', () => finalizeCommand(['--help'])],
    ['roles', () => rolesCommand(['--help'])],
    ['knowledge', () => knowledgeCommand(['--help'])],
    ['review', () => reviewCommand(['--help'])],
    ['review plan', () => reviewCommand(['plan', '--help'])],
    ['review run', () => reviewCommand(['run', '--help'])],
    ['review collect', () => reviewCommand(['collect', '--help'])],
    ['review batch', () => reviewCommand(['batch', '--help'])],
    ['session-start', () => sessionStartCommand(['--help'])],
  ]

  for (const [name, run] of cases) {
    const output = captureHelp(run)
    expect(output, name).toContain('用法')
  }
})

test('CLI 主帮助露出 health 体检子模式', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf-8')
  expect(source).toContain('health [书目录] [--metrics|--style|--report]')
  expect(source).toContain('record-call <章号|篇号>')
  expect(source).toContain('auto [N] [--resume]   连写 N 章/篇')
})
