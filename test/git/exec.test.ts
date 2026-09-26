/**
 * git/exec.ts 存活面测试（去 git 清理后）。
 *
 * exec.ts 已删 addCommit / findChapterCommit / gitHealthCheck / lastCommitMsg
 * （零生产调用方的死代码）；仍存活：git() / statusPorcelain（migrate 反推用）/
 * scanCloudCopies（状态机进门检查）。本文件覆盖后两者的行为契约。
 */
import { test, expect, vi, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { git, gitAsync, hardenGitArgs, scanCloudCopies, statusPorcelain } from '../../src/git/exec.js'
import { makeGitBook } from '../helpers/book.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})

// P2-30：包装 spawnSync 记录调用参数（真实实现保留——现有测试零感知），
// 断言 git()/statusPorcelain 每次调用都带 timeout（防挂起永久阻塞）。
// RC 源码重审 A-2：spawn 同款包装（argv 加固断言用，真实实现保留）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync), spawn: vi.fn(actual.spawn) }
})
import { spawn } from 'node:child_process'
const mockSpawnArgv = vi.mocked(spawn)
const mockSpawn = vi.mocked(spawnSync)

test('scanCloudCopies: Dropbox/OneDrive 风格「名 2.md」与 Google Drive「名 (1).md」命中（需同名母本）', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第1章.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 2.md'), '副本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 (1).md'), '副本', 'utf-8')
  try {
    const copies = scanCloudCopies(root)
    expect(copies.some((f) => f.includes('2.md'))).toBe(true)
    expect(copies.some((f) => f.includes('(1).md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-20: 合法标题名「第 2.md」不再误报（无同名母本不算网盘副本）', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第 2.md'), '合法章节文件', 'utf-8')
  try {
    expect(scanCloudCopies(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-20: .版本 与 .trash 目录不扫', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  // AppleDouble 形态一旦被扫必命中——用它证明目录确实被跳过
  for (const d of [join('工作区', '.版本'), '.trash']) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, '._残留.md'), 'x', 'utf-8')
  }
  try {
    expect(scanCloudCopies(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanCloudCopies: AppleDouble ._ 与 conflicted copy 命中；正常文件不命中', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(join(root, '布线', '悬念', '._悬念-031.md'), 'AppleDouble', 'utf-8')
  writeFileSync(join(root, '布线', '悬念', '悬念-031-conflicted copy-2026.md'), '冲突副本', 'utf-8')
  writeFileSync(join(root, '布线', '悬念', '悬念-031.md'), '正常文件', 'utf-8')
  try {
    const copies = scanCloudCopies(root)
    expect(copies.some((f) => f.includes('._悬念'))).toBe(true)
    expect(copies.some((f) => f.includes('conflicted'))).toBe(true)
    expect(copies.includes(join(root, '布线', '悬念', '悬念-031.md'))).toBe(false) // 精确路径不误伤（._悬念-031.md 后缀相同但路径不同）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanCloudCopies: .git / node_modules / .cache 内部不扫', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  for (const d of ['.git', 'node_modules', '.cache']) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, '._index.db'), 'x', 'utf-8')
  }
  try {
    expect(scanCloudCopies(root)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statusPorcelain: 中文路径原样输出（core.quotepath=false）+ 行首状态码保留', () => {
  const root = makeGitBook()
  try {
    writeFileSync(join(root, '布线', '悬念', '悬念-999-测试.md'), '---\n---\n内容', 'utf-8')
    const out = statusPorcelain(root)
    expect(out).not.toBeNull() // 成功路径返回 string
    expect(out!).toContain('悬念-999-测试.md') // 不被八进制转义
    expect(out!).not.toContain('\\351') // 未启用 quotepath=false 时的转义形态
    // 行首格式：XY<空格>path（untracked 为 "?? "）
    expect(out!.split('\n').some((l) => l.startsWith('?? ') && l.includes('悬念-999'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('RB-IF-P1-1: git 不可用/执行失败 → statusPorcelain 返回 null（与干净 "" 区分，不 fail-open）', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '.git'), { recursive: true }) // 空 .git：git status 报 not a git repository
  try {
    expect(statusPorcelain(root)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P2-30: git()/statusPorcelain 调 spawnSync 必带 timeout（防仓库锁/交互提示永久阻塞）', () => {
  const root = makeGitBook()
  try {
    mockSpawn.mockClear()
    git(['status'], root)
    expect(mockSpawn).toHaveBeenCalled()
    const opts = mockSpawn.mock.calls[0]![2] as { timeout?: number }
    expect(opts.timeout).toBe(15000)

    mockSpawn.mockClear()
    statusPorcelain(root)
    expect(mockSpawn).toHaveBeenCalled()
    const opts2 = mockSpawn.mock.calls[0]![2] as { timeout?: number }
    expect(opts2.timeout).toBe(15000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R77-3: 坚果云「冲突副本」命中（全角/半角形态，需同名母本）；无母本不误报', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第1章.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章（冲突副本 2026-08-30 11-22-33）.md'), '副本-全角', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 (冲突副本 2026-08-30).md'), '副本-半角', 'utf-8')
  // 无母本的冲突副本形态：不报（母本收紧，同 X-P2-20 口径——合法标题可能含该字样）
  writeFileSync(join(root, '写作', '正文', '番外（冲突副本 2026-08-30）.md'), '孤儿副本', 'utf-8')
  try {
    const copies = scanCloudCopies(root)
    expect(copies.some((f) => f.includes('第1章（冲突副本'))).toBe(true)
    expect(copies.some((f) => f.includes('第1章 (冲突副本'))).toBe(true)
    expect(copies.some((f) => f.includes('番外'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R77-3/复审-0913-mac适配 P3-5: git 可执行缺失（ENOENT）→ 人话引导装 Git，按平台分支', () => {
  const enoent = {
    pid: -1,
    output: [],
    stdout: '',
    stderr: '',
    status: null,
    error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
  }
  // 三臂全测（r45 platform mock 惯例）：本机真实平台只占其一，另两臂经注入跑满
  const expectations: Record<'darwin' | 'linux' | 'win32', (msg: string) => void> = {
    darwin: (msg) => {
      expect(msg).toContain('xcode-select --install')
      expect(msg).not.toContain('Git for Windows')
    },
    linux: (msg) => {
      expect(msg).toContain('包管理器')
      expect(msg).not.toContain('Git for Windows')
    },
    win32: (msg) => expect(msg).toContain('Git for Windows'),
  }
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    mockSpawn.mockImplementationOnce(() => enoent as unknown as ReturnType<typeof spawnSync>)
    const r = git(['status'], tmpdir())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.humanMsg).toContain('未检测到 Git')
      expectations[platform](r.humanMsg)
    }
  }
})

test('R0913-win P3-9: 资源管理器「名 - Copy.md」/「名 - 副本.md」命中（需母本）；无母本不误报', () => {
  const root = join(tmpdir(), `clw-exec-${Date.now()}`)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第1章.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 - Copy.md'), '副本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 - 副本.md'), '副本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第1章 - 副本 (2).md'), '副本', 'utf-8')
  // 无母本的资源管理器副本形态：不报（母本收紧，同 X-P2-20 口径）
  writeFileSync(join(root, '写作', '正文', '孤儿 - Copy.md'), '无母本副本', 'utf-8')
  try {
    const copies = scanCloudCopies(root)
    expect(copies.some((f) => f.includes('第1章 - Copy.md'))).toBe(true)
    expect(copies.some((f) => f.includes('第1章 - 副本.md'))).toBe(true)
    expect(copies.some((f) => f.includes('第1章 - 副本 (2)'))).toBe(true)
    expect(copies.some((f) => f.includes('孤儿'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── RC 源码重审 A-2（Opus-5.5 轮）：仓库内 fsmonitor/hooks 配置不可信 ──────────

const fwd = (p: string): string => p.replace(/\\/g, '/')

/** 装置：造一个「仓库内 .git/config 带 core.fsmonitor = <脚本>」的裸仓；
 *  脚本被执行即在仓根留 ran.txt（证明该配置确实是一条约会执行任意命令的面）。 */
function makeFsmonRepo(): { root: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), 'clw-gitsec-'))
  const g = (a: string[]): void => {
    spawnSync('git', a, { cwd: root, stdio: 'pipe', encoding: 'utf-8' })
  }
  g(['init'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(root, 'a.md'), 'x', 'utf-8')
  g(['add', 'a.md'])
  const marker = join(root, 'ran.txt')
  const script = join(root, 'fsm.sh')
  writeFileSync(script, `#!/bin/sh\necho ran >> "${fwd(marker)}"\n`, 'utf-8')
  chmodSync(script, 0o755)
  // 直写配置文件（不经 git config 命令面，模拟「随书目录流入的仓库配置」）
  appendFileSync(join(root, '.git', 'config'), `\n[core]\n\tfsmonitor = ${fwd(script)}\n`, 'utf-8')
  return { root, marker }
}

test('RC 源码重审 A-2: 仓库内 core.fsmonitor 命令经统一执行器不被执行（裸 git 对照支证明害面为真）', () => {
  const probe = makeFsmonRepo()
  const subject = makeFsmonRepo()
  try {
    // 对照支：无加固的裸 git status → 命令被执行。证明本环境（git 版本/平台）上这条害面是活的；
    // 若此支不活（老 git 不认外部 fsmonitor 命令），本用例无法证伪修复有效性——直接红，不假绿。
    spawnSync('git', ['status', '--porcelain'], { cwd: probe.root, stdio: 'pipe' })
    expect(
      existsSync(probe.marker),
      '前置对照支未触发：本环境裸 git 未执行 core.fsmonitor 命令，用例需按 git 版本复核',
    ).toBe(true)

    // 受试支：同款仓库经统一执行器（-c core.fsmonitor=false 前置）→ 命令不执行、status 仍正常返回
    expect(statusPorcelain(subject.root)).not.toBeNull()
    expect(existsSync(subject.marker)).toBe(false)
  } finally {
    for (const r of [probe, subject]) rmSync(r.root, { recursive: true, force: true })
  }
})

test('RC 源码重审 A-2: hardenGitArgs 平台分支——fsmonitor 恒关，hooksPath 按平台落 NUL//dev/null', () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  expect(hardenGitArgs(['status'])).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', 'status'])
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  expect(hardenGitArgs(['status'])).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'status'])
})

test('RC 源码重审 A-2: git()/gitAsync() 子进程 argv 均带加固前置；失败信封不外露 -c 噪音', async () => {
  const root = makeGitBook()
  const expectPrefix = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  ]
  try {
    mockSpawn.mockClear()
    git(['status'], root)
    expect(mockSpawn.mock.calls[0]![1]).toEqual([...expectPrefix, 'status'])

    mockSpawnArgv.mockClear()
    await gitAsync(['for-each-ref', '--format=%(refname)', 'refs/ai/'], root)
    expect(mockSpawnArgv).toHaveBeenCalled()
    expect(mockSpawnArgv.mock.calls[0]![1]).toEqual([
      ...expectPrefix,
      'for-each-ref',
      '--format=%(refname)',
      'refs/ai/',
    ])

    // 失败信封用调用方原 args 拼装（作者可见文案里不出现加固参数）
    const r = git(['cat-file', '-p', 'refs/ai/不存在'], root)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.humanMsg).toContain('cat-file -p refs/ai/不存在')
      expect(r.humanMsg).not.toContain('core.fsmonitor')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
