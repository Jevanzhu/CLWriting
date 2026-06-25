import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { doInit } from '../../src/install/init.js'
import { readBooks, readActive, findWorkDir } from '../../src/install/books.js'
import { enter } from '../../src/state/state.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { readRealmDoc } from '../../src/format/realms.js'

const ORIG_CWD = process.cwd()

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || `git ${args.join(' ')} failed`)
  return r.stdout
}

beforeEach(() => {
  process.chdir(ORIG_CWD)
})

afterEach(() => {
  process.chdir(ORIG_CWD)
})

function samePath(path: string): string {
  return realpathSync.native(path)
}

test('init: 非交互一条命令装出工作目录 + 建书', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-'))
  const r = doInit({ workDir: wd, name: '北境往事', genre: '玄幻', leads: ['成长线', '设定线'] })

  expect(r.ok).toBe(true)
  if (!r.ok) return

  // 工作目录层：.clwriting/ + 角色源种子 + 壳
  expect(existsSync(join(wd, '.clwriting', 'roles'))).toBe(true)
  expect(existsSync(join(wd, '.clwriting', 'dist'))).toBe(true)
  expect(existsSync(join(wd, '.clwriting', 'dist', 'cli.js'))).toBe(true)
  expect(existsSync(join(wd, '.claude', 'SKILL.md'))).toBe(true)
  expect(existsSync(join(wd, '.codex', 'AGENTS.md'))).toBe(true)
  expect(existsSync(join(wd, 'AGENTS.md'))).toBe(true) // 通用壳

  // 角色源种子 7 个（4 长篇 reader/editor/continuity/writer + 3 短篇 hook/emotion/payoff，M8 #28）
  const roleFiles = readdirSync(join(wd, '.clwriting', 'roles')).filter((f) => f.endsWith('.md'))
  expect(roleFiles.length).toBe(7)
  expect(existsSync(join(wd, '.clwriting', 'templates.manifest.json'))).toBe(true)
  const templatesManifest = JSON.parse(readFileSync(join(wd, '.clwriting', 'templates.manifest.json'), 'utf-8'))
  expect(templatesManifest.records).toHaveLength(7)
  expect(templatesManifest.records[0]!.installed_hash).toMatch(/^sha256:/)

  // 书仓库层：独立 git + book.yaml + 6.2 目录 + 初始 commit
  const bookRoot = r.bookRoot
  expect(existsSync(join(bookRoot, '.git'))).toBe(true)
  expect(existsSync(join(bookRoot, '.git', 'hooks', 'pre-push'))).toBe(true)
  expect(existsSync(join(bookRoot, 'book.yaml'))).toBe(true)
  expect(existsSync(join(bookRoot, 'AGENTS.md'))).toBe(true)
  expect(existsSync(join(bookRoot, '.gitignore'))).toBe(true)
  // 基础三类恒建
  expect(existsSync(join(bookRoot, '大纲', '伏笔'))).toBe(true)
  expect(existsSync(join(bookRoot, '大纲', '悬念'))).toBe(true)
  expect(existsSync(join(bookRoot, '大纲', '感情线'))).toBe(true)
  // 扩展类按 leadsEnabled 建
  expect(existsSync(join(bookRoot, '大纲', '成长线'))).toBe(true)
  expect(existsSync(join(bookRoot, '大纲', '设定线'))).toBe(true)
  expect(existsSync(join(bookRoot, '大纲', '局线'))).toBe(false) // 未启用不建
  // 文风冷启动
  expect(existsSync(join(bookRoot, '文风', '样章库', '战斗'))).toBe(true)
  expect(existsSync(join(bookRoot, '文风', '文风铁律.md'))).toBe(true)
  // 定稿区
  expect(existsSync(join(bookRoot, '定稿', '正文'))).toBe(true)
  const realms = readRealmDoc(join(bookRoot, '定稿', '设定', '境界体系.md'))
  expect(realms.ok).toBe(true)
  if (realms.ok) {
    expect(realms.doc.体系[0]?.序列).toContain('炼气一层')
    expect(realms.doc.体系[0]?.序列).toContain('金丹')
  }

  // book.yaml 内容正确
  const cfg = readBookConfig(join(bookRoot, 'book.yaml')).config
  expect(cfg.book.title).toBe('北境往事')
  expect(cfg.book.genre).toBe('玄幻')
  expect(cfg.leads.enabled).toEqual(['成长线', '设定线'])

  // 初始 commit 存在（git 有 HEAD）
  const head = git(['rev-parse', 'HEAD'], bookRoot).trim()
  expect(head.length).toBe(40)
  const pushHook = readFileSync(join(bookRoot, '.git', 'hooks', 'pre-push'), 'utf-8')
  expect(pushHook).toContain('CLWRITING_ALLOW_BOOK_PUSH=1')
  expect(pushHook).toContain('Push is blocked by default')

  // books.jsonl 登记 + 设为活动书
  const books = readBooks(wd)
  expect(books).toHaveLength(1)
  expect(books[0]!.name).toBe('北境往事')
  expect(books[0]!.path).toBe('长篇/北境往事')
  expect(books[0]!.kind).toBe('long')
  expect(existsSync(join(wd, '长篇', '北境往事'))).toBe(true)
  expect(readActive(wd)).toBe('北境往事')

  rmSync(wd, { recursive: true, force: true })
})

test('init: 题材驱动 leads 推荐（玄幻 → 设定线+成长线）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init2-'))
  const r = doInit({ workDir: wd, name: '仙缘', genre: '仙侠修仙' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const cfg = readBookConfig(join(r.bookRoot, 'book.yaml')).config
  expect(cfg.leads.enabled).toEqual(['设定线', '成长线'])
  rmSync(wd, { recursive: true, force: true })
})

test('init: targetWords 落 book.yaml target_words + 读回（决策 14 完成度链路）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-tw-'))
  const r = doInit({ workDir: wd, name: '目标书', genre: '玄幻', targetWords: 300000 })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const cfg = readBookConfig(join(r.bookRoot, 'book.yaml')).config
  expect(cfg.book.target_words).toBe(300000)
  rmSync(wd, { recursive: true, force: true })
})

test('init: targetWords 缺省不写 target_words（可选字段，向后兼容）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-tw2-'))
  const r = doInit({ workDir: wd, name: '无目标', genre: '玄幻' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const cfg = readBookConfig(join(r.bookRoot, 'book.yaml')).config
  expect(cfg.book.target_words).toBeUndefined()
  rmSync(wd, { recursive: true, force: true })
})

test('init: brief 落 简介.md（GUI 新增 5.1）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-brief-'))
  const r = doInit({ workDir: wd, name: '简介书', genre: '玄幻', brief: '一个少年的修真之路。' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(readFileSync(join(r.bookRoot, '简介.md'), 'utf-8')).toBe('一个少年的修真之路。')
  rmSync(wd, { recursive: true, force: true })
})

test('init: brief 缺省不写 简介.md（向后兼容）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-brief2-'))
  const r = doInit({ workDir: wd, name: '无简介', genre: '玄幻' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(existsSync(join(r.bookRoot, '简介.md'))).toBe(false)
  rmSync(wd, { recursive: true, force: true })
})

test('init: 工作目录不能位于 git 仓库内', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init-git-'))
  git(['init'], wd)
  const r = doInit({ workDir: wd, name: '误装书', genre: '玄幻' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toContain('工作目录不能放在 git 仓库里')
  rmSync(wd, { recursive: true, force: true })
})

test('init: 空 .git 目录不是有效仓库祖先，不应误拦', () => {
  const parent = mkdtempSync(join(tmpdir(), 'init-empty-git-parent-'))
  mkdirSync(join(parent, '.git'))
  const wd = join(parent, 'work')
  mkdirSync(wd)

  const r = doInit({ workDir: wd, name: '空Git目录测试', genre: '玄幻' })
  expect(r.ok).toBe(true)
  rmSync(parent, { recursive: true, force: true })
})

test('init: 冷门题材仅基础三类（leads.enabled 空）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init3-'))
  const r = doInit({ workDir: wd, name: '都市职场', genre: '都市' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const cfg = readBookConfig(join(r.bookRoot, 'book.yaml')).config
  expect(cfg.leads.enabled).toEqual([])
  rmSync(wd, { recursive: true, force: true })
})

test('init: 幂等——工作目录复用，同名书冲突拒绝', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init4-'))
  // 第一次建
  expect(doInit({ workDir: wd, name: '书A', genre: '玄幻' }).ok).toBe(true)
  // 第二次同名 → 拒绝
  const dup = doInit({ workDir: wd, name: '书A', genre: '玄幻' })
  expect(dup.ok).toBe(false)
  if (!dup.ok) expect(dup.reason).toContain('书A')
  // 换个名字建第二本 → 成功
  expect(doInit({ workDir: wd, name: '书B', genre: '悬疑' }).ok).toBe(true)
  const books = readBooks(wd)
  expect(books).toHaveLength(2)
  // 第二本成为活动书
  expect(readActive(wd)).toBe('书B')
  rmSync(wd, { recursive: true, force: true })
})

test('init 出的空书: enter 干净落态 7（起草新章）—— M5 核心出口', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init5-'))
  const r = doInit({ workDir: wd, name: '空书测试', genre: '玄幻' })
  expect(r.ok).toBe(true)
  if (!r.ok) return

  // 进空书：enter 应干净通过到态 7
  const result = enter(r.bookRoot)
  expect(result.route.state).toBe(7) // 起草新章
  expect(result.route.humanMsg).toContain('第 1 章')

  rmSync(wd, { recursive: true, force: true })
})

test('接缝闭环: 工作目录内裸命令经活动书定位到书仓库（R1 验证）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init6-'))
  const r = doInit({ workDir: wd, name: '活动书测试', genre: '玄幻' })
  expect(r.ok).toBe(true)
  if (!r.ok) return

  // chdir 到工作目录（非书仓库），裸命令应经活动书定位
  process.chdir(wd)
  expect(samePath(findWorkDir(process.cwd())!)).toBe(samePath(wd))
  // readActive 应返回书名
  expect(readActive(wd)).toBe('活动书测试')

  process.chdir(ORIG_CWD)
  rmSync(wd, { recursive: true, force: true })
})

test('init: 角色源种子用方括号 tools 语法（P4 修复验证）', () => {
  const wd = mkdtempSync(join(tmpdir(), 'init7-'))
  const r = doInit({ workDir: wd, name: 'P4验证', genre: '玄幻' })
  expect(r.ok).toBe(true)
  if (!r.ok) return

  const writer = readFileSync(join(wd, '.clwriting', 'roles', 'writer.md'), 'utf-8')
  expect(writer).toContain('tools: [Read, Write]')
  expect(writer).toContain('record-call <章号|篇号>')
  expect(writer).toContain('front matter 使用 `篇号`')
  expect(writer).toContain('工作区/清单.md')
  // 不应是裸逗号写法
  expect(writer).not.toMatch(/^tools: Read,\s*Write$/m)

  rmSync(wd, { recursive: true, force: true })
})
