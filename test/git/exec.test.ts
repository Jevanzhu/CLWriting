/**
 * git/exec.ts 存活面测试（去 git 清理后）。
 *
 * exec.ts 已删 addCommit / findChapterCommit / gitHealthCheck / lastCommitMsg
 * （零生产调用方的死代码）；仍存活：git() / statusPorcelain（migrate 反推用）/
 * scanCloudCopies（状态机进门检查）。本文件覆盖后两者的行为契约。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCloudCopies, statusPorcelain } from '../../src/git/exec.js'
import { makeGitBook } from '../helpers/book.js'

// P2-30：包装 spawnSync 记录调用参数（真实实现保留——现有测试零感知），
// 断言 git()/statusPorcelain 每次调用都带 timeout（防挂起永久阻塞）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})
import { spawnSync } from 'node:child_process'
import { git } from '../../src/git/exec.js'
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

test('R77-3: git 可执行缺失（ENOENT）→ 人话引导装 Git，不落穿 spawn 英文报错', () => {
  const enoent = {
    pid: -1,
    output: [],
    stdout: '',
    stderr: '',
    status: null,
    error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
  }
  mockSpawn.mockImplementationOnce(() => enoent as unknown as ReturnType<typeof spawnSync>)
  const r = git(['status'], tmpdir())
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.humanMsg).toContain('未检测到 Git')
    expect(r.humanMsg).toContain('Git for Windows')
  }
})
