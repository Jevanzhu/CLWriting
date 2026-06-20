import { test, expect, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareCommand } from '../../src/cli/prepare.js'
import { rebookCommand } from '../../src/cli/rebook.js'
import { makeGitBook } from '../helpers/book.js'

function captureCli(run: () => void): { stdout: string; exitCode: string | null } {
  const out: string[] = []
  let exitCode: string | null = null
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = String(code ?? '')
    throw new Error(`process.exit ${exitCode}`)
  }) as typeof process.exit)
  try {
    run()
  } catch {
    // process.exit 抛出
  } finally {
    log.mockRestore()
    err.mockRestore()
    exit.mockRestore()
  }
  return { stdout: out.join('\n'), exitCode }
}

async function captureCliAsync(run: () => Promise<void>): Promise<{ stdout: string; exitCode: string | null }> {
  const out: string[] = []
  let exitCode: string | null = null
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')))
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = String(code ?? '')
    throw new Error(`process.exit ${exitCode}`)
  }) as typeof process.exit)
  try {
    await run()
  } catch {
    // process.exit 抛出
  } finally {
    log.mockRestore()
    err.mockRestore()
    exit.mockRestore()
  }
  return { stdout: out.join('\n'), exitCode }
}

test('prepare CLI: 从细纲推进/场景生成本章写作材料', async () => {
  const root = makeGitBook()
  try {
    mkdirSync(join(root, '文风', '样章库', '对话'), { recursive: true })
    writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n禁用废话', 'utf-8')
    writeFileSync(join(root, '文风', '样章库', '对话', '对话-001.md'), [
      '---',
      '场景: 对话',
      '来源: 作者原作',
      '---',
      '他说话像刀背压在桌上。',
    ].join('\n'), 'utf-8')
    writeFileSync(join(root, '工作区', '细纲.md'), [
      '---',
      '章号: 2',
      '标题: 来信',
      '场景: 对话',
      '推进: [伏笔-031]',
      '---',
      '本章继续追灭门真凶。',
    ].join('\n'), 'utf-8')

    const { exitCode, stdout } = await captureCliAsync(() => prepareCommand([root]))
    expect(exitCode).toBeNull()
    expect(stdout).toContain('本章写作材料.md')
    const material = readFileSync(join(root, '工作区', '本章写作材料.md'), 'utf-8')
    expect(material).toContain('本章推进的账本')
    expect(material).toContain('伏笔-031')
    expect(material).toContain('文风样章')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rebook CLI: 默认只报告，--yes 才补登 commit', () => {
  const root = makeGitBook()
  try {
    const leadPath = join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md')
    writeFileSync(leadPath, `${readFileSync(leadPath, 'utf-8')}\n作者补了一句说明。\n`, 'utf-8')

    const report = captureCli(() => rebookCommand([root]))
    expect(report.exitCode).toBeNull()
    expect(report.stdout).toContain('clwriting rebook --yes')
    const before = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim()

    const committed = captureCli(() => rebookCommand(['--yes', root]))
    expect(committed.exitCode).toBeNull()
    expect(committed.stdout).toContain('手改已补登')
    const after = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim()
    expect(after).not.toBe(before)
    const files = execSync('git -c core.quotepath=false show --name-only --format= HEAD', { cwd: root, encoding: 'utf-8' })
    expect(files).toContain('伏笔-031-灭门真凶.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
