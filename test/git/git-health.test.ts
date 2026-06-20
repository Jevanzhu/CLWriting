/**
 * git 健康检查测试 —— #16 第 2 节 4 异常 + 干净对照。
 *
 * 工单施工序 2 验证点：git 异常样本库（半提交/冲突/锁/网盘副本）各命中、出人话。
 * fixture 经 test/helpers/book.ts 的 makeGitBook 造，再注入各类异常。
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBook } from '../helpers/book.js'
import { gitHealthCheck, git } from '../../src/git/exec.js'

/** 跑 git（fixture 注入异常用）：参数数组避免 Windows shell 差异。 */
function mustGit(args: string[], cwd: string): string {
  const r = git(args, cwd)
  if (!r.ok) throw new Error(r.humanMsg)
  return r.stdout
}

test('gitHealthCheck: 干净书仓库 → clean', () => {
  const root = makeGitBook()
  const report = gitHealthCheck(root)
  expect(report.clean).toBe(true)
  expect(report.issues).toHaveLength(0)
  expect(report.warnings).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: 配置 remote → 只报安全提醒，不阻断 clean', () => {
  const root = makeGitBook()
  mustGit(['remote', 'add', 'origin', 'https://example.invalid/private-novel.git'], root)

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(true)
  expect(report.issues).toHaveLength(0)
  expect(report.warnings).toHaveLength(1)
  expect(report.warnings[0]?.kind).toBe('remoteConfigured')
  expect(report.warnings[0]?.humanMsg).toContain('小说正文')
  expect(report.warnings[0]?.remotes).toEqual(['origin'])
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: 半提交（staged 残留）→ halfCommit 命中出人话', () => {
  const root = makeGitBook()
  // 改文件后 git add 但不 commit → staged 残留
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'), '改了内容', 'utf-8')
  mustGit(['add', '-A'], root)

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(false)
  const half = report.issues.find((i) => i.kind === 'halfCommit')
  expect(half).toBeDefined()
  expect(half?.humanMsg).toContain('没收尾')
  expect(half?.fix).toContain('续跑')
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: 合并冲突（MERGE_HEAD + 冲突标记）→ mergeConflict 命中', () => {
  const root = makeGitBook()
  const baseBranch = mustGit(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim()
  // 制造一个冲突：两边改同一行
  mustGit(['checkout', '-b', 'feature'], root)
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'), 'feature 分支改的', 'utf-8')
  mustGit(['add', '-A'], root)
  mustGit(['commit', '-m', 'feature 改'], root)
  mustGit(['checkout', baseBranch], root)
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-031-灭门真凶.md'), '主干改的', 'utf-8')
  mustGit(['add', '-A'], root)
  mustGit(['commit', '-m', '主干改'], root)
  // 合并 feature，产生冲突
  try {
    mustGit(['merge', 'feature'], root)
  } catch {
    // 合并冲突会让 git 返回非零，预期内
  }

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(false)
  const conflict = report.issues.find((i) => i.kind === 'mergeConflict')
  expect(conflict).toBeDefined()
  expect(conflict?.humanMsg).toContain('撞车')
  expect(conflict?.fix).toContain('<<<<<<<')
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: 僵死锁（index.lock 存在无活跃进程）→ staleLock 命中', () => {
  const root = makeGitBook()
  // 造一个僵死锁文件
  writeFileSync(join(root, '.git', 'index.lock'), '', 'utf-8')

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(false)
  const lock = report.issues.find((i) => i.kind === 'staleLock')
  expect(lock).toBeDefined()
  expect(lock?.humanMsg).toContain('锁')
  expect(lock?.fix).toContain('index.lock')
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: 网盘副本残留（文件 2.md）→ cloudCopy 命中', () => {
  const root = makeGitBook()
  // 模拟 Dropbox/OneDrive 风格冲突副本 + AppleDouble
  writeFileSync(join(root, '定稿', '正文', '伏笔-031-灭门真凶 2.md'), '副本内容', 'utf-8')
  writeFileSync(join(root, '大纲', '伏笔', '._伏笔-031.md'), 'AppleDouble', 'utf-8')

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(false)
  const copy = report.issues.find((i) => i.kind === 'cloudCopy')
  expect(copy).toBeDefined()
  expect(copy?.humanMsg).toContain('同步盘副本')
  expect(copy?.files?.some((f) => f.includes('2.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: .cache 内 AppleDouble 副本不阻断写作', () => {
  const root = makeGitBook()
  writeFileSync(join(root, '.cache', '._index.db'), 'AppleDouble', 'utf-8')

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(true)
  expect(report.issues.find((i) => i.kind === 'cloudCopy')).toBeUndefined()
  rmSync(root, { recursive: true, force: true })
})

test('gitHealthCheck: 多异常同时存在 → 全部入 issues', () => {
  const root = makeGitBook()
  // 半提交 + 锁 + 网盘副本
  writeFileSync(join(root, '大纲', '伏笔', '伏笔-099.md'), '新增', 'utf-8')
  mustGit(['add', '-A'], root)
  writeFileSync(join(root, '.git', 'index.lock'), '', 'utf-8')
  writeFileSync(join(root, '定稿', '正文', '某章 2.md'), '副本', 'utf-8')

  const report = gitHealthCheck(root)
  expect(report.clean).toBe(false)
  const kinds = report.issues.map((i) => i.kind)
  expect(kinds).toContain('halfCommit')
  expect(kinds).toContain('staleLock')
  expect(kinds).toContain('cloudCopy')
  rmSync(root, { recursive: true, force: true })
})

// 附：git 执行器基础行为
test('git(): 成功返回 stdout，失败返回人话', () => {
  const root = makeGitBook()
  const ok = git(['log', '--oneline'], root)
  expect(ok.ok).toBe(true)
  if (ok.ok) expect(ok.stdout).toContain('init')

  const fail = git(['log'], join(root, '不存在子目录'))
  expect(fail.ok).toBe(false)
  if (!fail.ok) expect(fail.humanMsg.length).toBeGreaterThan(0)
  rmSync(root, { recursive: true, force: true })
})
