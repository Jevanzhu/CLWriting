import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doInit } from '../../src/install/init.js'
import { doUpdate } from '../../src/install/update.js'
import { readBooks } from '../../src/install/books.js'
import { checkRoleShellDrift } from '../../src/roles/shells.js'

const ORIG_CWD = process.cwd()

beforeEach(() => {
  process.chdir(ORIG_CWD)
})

afterEach(() => {
  process.chdir(ORIG_CWD)
})

function makeWorkDir(): string {
  const wd = mkdtempSync(join(tmpdir(), 'upd-'))
  doInit({ workDir: wd, name: '升级测试书', genre: '玄幻' })
  return wd
}

function testBookRoot(workDir: string): string {
  const book = readBooks(workDir).find((b) => b.name === '升级测试书')
  if (!book) throw new Error('missing test book')
  return join(workDir, book.path)
}

test('update: 幂等——重跑无副作用', () => {
  const wd = makeWorkDir()
  // 第一次 update
  const r1 = doUpdate({ workDir: wd, detail: 'brief' })
  expect(r1.ok).toBe(true)
  // 第二次 update（同版本）应也成功、无报错
  const r2 = doUpdate({ workDir: wd, detail: 'brief' })
  expect(r2.ok).toBe(true)
  rmSync(wd, { recursive: true, force: true })
})

test('update: 重生壳后 drift 校验绿', () => {
  const wd = makeWorkDir()
  doUpdate({ workDir: wd, detail: 'brief' })
  const drift = checkRoleShellDrift(wd)
  expect(drift.ok).toBe(true)
  rmSync(wd, { recursive: true, force: true })
})

test('update: 角色源备份到 roles.bak', () => {
  const wd = makeWorkDir()
  // init 后 roles 有种子
  expect(existsSync(join(wd, '.clwriting', 'roles', 'writer.md'))).toBe(true)
  doUpdate({ workDir: wd, detail: 'brief' })
  // update 后 roles.bak 应存在并含种子
  expect(existsSync(join(wd, '.clwriting', 'roles.bak', 'writer.md'))).toBe(true)
  rmSync(wd, { recursive: true, force: true })
})

test('update: 当前包有 dist 时同步到工作目录 .clwriting/dist', () => {
  const wd = makeWorkDir()
  const sourceCli = join(ORIG_CWD, 'dist', 'cli.js')
  const r = doUpdate({ workDir: wd, detail: 'brief' })
  expect(r.ok).toBe(true)
  if (existsSync(sourceCli)) {
    expect(existsSync(join(wd, '.clwriting', 'dist', 'cli.js'))).toBe(true)
    if (r.ok) expect(r.report.join('\n')).toContain('已同步当前包 dist')
  }
  rmSync(wd, { recursive: true, force: true })
})

test('update: 不碰书仓库内容（book.yaml 不被改）', () => {
  const wd = makeWorkDir()
  const bookYaml = join(testBookRoot(wd), 'book.yaml')
  const before = readFileSync(bookYaml, 'utf-8')
  doUpdate({ workDir: wd, detail: 'brief' })
  const after = readFileSync(bookYaml, 'utf-8')
  expect(after).toBe(before) // 书仓库内容 update 永不碰
  rmSync(wd, { recursive: true, force: true })
})

test('update: 给已有书仓库补装推送保护 hook', () => {
  const wd = makeWorkDir()
  const hookPath = join(testBookRoot(wd), '.git', 'hooks', 'pre-push')
  writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', 'utf-8')

  const r = doUpdate({ workDir: wd, detail: 'brief' })
  expect(r.ok).toBe(true)
  const hook = readFileSync(hookPath, 'utf-8')
  expect(hook).toContain('Push is blocked by default')
  expect(hook).toContain('CLWRITING_ALLOW_BOOK_PUSH=1')
  if (r.ok) expect(r.report.join('\n')).toContain('书仓库推送保护')
  rmSync(wd, { recursive: true, force: true })
})

test('update: 作者改过的角色源被保留（不覆盖）', () => {
  const wd = makeWorkDir()
  // 模拟作者改了 writer.md
  const writerPath = join(wd, '.clwriting', 'roles', 'writer.md')
  const original = readFileSync(writerPath, 'utf-8')
  const authorModified = original + '\n<!-- 作者加的注释 -->\n'
  writeFileSync(writerPath, authorModified, 'utf-8')

  // 先建模板 manifest（让 update 知道 installed_hash）
  // 第一次 update 会写 manifest 记录当前为 installed
  // 但我们手改发生在 manifest 写入前——模拟「作者改过且有新版」
  // 简化：手写 manifest 记录原始 hash，再改文件，再 update
  doUpdate({ workDir: wd, detail: 'brief' }) // 写 manifest（记录当前=作者改过的版本）
  writeFileSync(writerPath, authorModified + '\n<!-- 又改一次 -->\n', 'utf-8')
  doUpdate({ workDir: wd, detail: 'full' })

  // 作者改过的内容应保留（update 不覆盖作者数据）
  const after = readFileSync(writerPath, 'utf-8')
  expect(after).toContain('作者加的注释')
  rmSync(wd, { recursive: true, force: true })
})

test('update: 作者改过的角色源不推进 installed_hash 到新版模板', () => {
  const wd = makeWorkDir()
  const manifestPath = join(wd, '.clwriting', 'templates.manifest.json')
  const before = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const writerRecord = before.records.find((r: { path: string }) => r.path.endsWith('/writer.md'))
  expect(writerRecord).toBeDefined()

  const writerPath = join(wd, '.clwriting', 'roles', 'writer.md')
  writeFileSync(writerPath, readFileSync(writerPath, 'utf-8') + '\n<!-- 作者改过 -->\n', 'utf-8')
  doUpdate({ workDir: wd, detail: 'brief' })

  const after = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const afterWriter = after.records.find((r: { path: string }) => r.path.endsWith('/writer.md'))
  expect(afterWriter.installed_hash).toBe(writerRecord.installed_hash)
  expect(readFileSync(writerPath, 'utf-8')).toContain('作者改过')
  rmSync(wd, { recursive: true, force: true })
})

test('update: templates.manifest.json 原子写入且不残留临时文件', () => {
  const wd = makeWorkDir()
  const r = doUpdate({ workDir: wd, detail: 'brief' })
  expect(r.ok).toBe(true)

  const manifestPath = join(wd, '.clwriting', 'templates.manifest.json')
  expect(JSON.parse(readFileSync(manifestPath, 'utf-8')).version).toBe(1)
  const leftovers = readdirSync(join(wd, '.clwriting'))
    .filter((f) => f.includes('templates.manifest.json') && f.endsWith('.tmp'))
  expect(leftovers).toEqual([])

  rmSync(wd, { recursive: true, force: true })
})

test('update: 新版已删除的模板仅提示并保留本地文件和 manifest 记录', () => {
  const wd = makeWorkDir()
  const oldPath = join(wd, '.clwriting', 'roles', 'old-role.md')
  writeFileSync(oldPath, '# 旧模板\n', 'utf-8')
  const manifestPath = join(wd, '.clwriting', 'templates.manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  manifest.records.push({
    path: '.clwriting/roles/old-role.md',
    installed_hash: 'sha256:old',
  })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  const r = doUpdate({ workDir: wd, detail: 'brief' })

  expect(r.ok).toBe(true)
  expect(existsSync(oldPath)).toBe(true)
  if (r.ok) expect(r.report.join('\n')).toContain('old-role.md')
  const after = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  expect(after.records.some((record: { path: string }) => record.path.endsWith('/old-role.md'))).toBe(true)

  rmSync(wd, { recursive: true, force: true })
})

test('update: 报告含三类文件分治信息', () => {
  const wd = makeWorkDir()
  const r = doUpdate({ workDir: wd, detail: 'brief' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const report = r.report.join('\n')
  expect(report).toContain('插件本体')
  expect(report).toContain('角色源备份') // 或 roles.bak
  expect(report).toContain('角色壳') // 重生
  rmSync(wd, { recursive: true, force: true })
})
