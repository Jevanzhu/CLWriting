/**
 * startup-instance.ts 单测——多库多窗启动库解析（pre-setPath 同步链）与
 * relaunch argv 清洗。
 *
 * 回归靶：`--dir` > `<home>/workdir.json`.current > `findWorkDir(cwd)` > welcome 的
 * 优先级（instanceKey 的输入，错序 = 实例目录/key 落错库）；relaunch 不清 `--dir`
 * 会把切库目标顶回旧库（设计正本 §4.4）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirArg, resolveStartupLibraryDir, stripDirArg } from '../../src/desktop/startup-instance.js'

const tmpDirs: string[] = []
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
function cleanup(): void {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

describe('dirArg：--dir 取值（空格形态与 = 形态）', () => {
  it('空格形态取值；缺失值/未提供 → undefined；空白串视为未提供', () => {
    expect(dirArg(['x', '--dir', '/libs/A'])).toBe('/libs/A')
    expect(dirArg(['x', '--dir'])).toBeUndefined()
    expect(dirArg(['x'])).toBeUndefined()
    expect(dirArg(['x', '--dir', '   '])).toBeUndefined()
  })

  it('= 形态取值且优先于空格形态', () => {
    expect(dirArg(['--dir=/libs/A'])).toBe('/libs/A')
    expect(dirArg(['--dir=/libs/A', '--dir', '/libs/B'])).toBe('/libs/A')
    expect(dirArg(['--dir='])).toBeUndefined()
  })
})

describe('stripDirArg：切库 relaunch 的 argv 清洗', () => {
  it('摘掉 --dir 及值（两种形态），其余参数（--book 等）随行', () => {
    expect(stripDirArg(['.', '--dir', '/libs/A', '--book', '书A'])).toEqual(['.', '--book', '书A'])
    expect(stripDirArg(['.', '--dir=/libs/A', '--book', '书A'])).toEqual(['.', '--book', '书A'])
    expect(stripDirArg(['.', '--book', '书A'])).toEqual(['.', '--book', '书A'])
  })

  it('--dir 无值（末尾裸参数）只摘参数名本身', () => {
    expect(stripDirArg(['.', '--dir'])).toEqual(['.'])
  })
})

describe('resolveStartupLibraryDir：优先级链', () => {
  it('--dir 优先于 workdir.json.current 与 cwd 发现', () => {
    const home = mkTmp('clw-su-home-')
    writeFileSync(join(home, 'workdir.json'), JSON.stringify({ current: '/libs/Stored', recent: [] }))
    const cwdLib = mkTmp('clw-su-cwd-')
    mkdirSync(join(cwdLib, '.clwriting'), { recursive: true })
    const r = resolveStartupLibraryDir({ argv: ['--dir', '/libs/Arg'], homeDir: home, cwd: cwdLib })
    expect(r).toEqual({ dir: '/libs/Arg', source: 'arg' })
    cleanup()
  })

  it('无 --dir → 读 workdir.json.current（相对路径 resolve 为绝对）', () => {
    const home = mkTmp('clw-su-home-')
    writeFileSync(join(home, 'workdir.json'), JSON.stringify({ current: '/libs/Stored', recent: [] }))
    expect(resolveStartupLibraryDir({ argv: [], homeDir: home, cwd: tmpdir() })).toEqual({
      dir: '/libs/Stored',
      source: 'current',
    })
    cleanup()
  })

  it('current 缺失/损坏 → 回落 findWorkDir(cwd)；两处均无 → welcome', () => {
    const home = mkTmp('clw-su-home-')
    writeFileSync(join(home, 'workdir.json'), '{ 损坏 json')
    const lib = mkTmp('clw-su-lib-')
    mkdirSync(join(lib, '.clwriting'), { recursive: true })
    expect(resolveStartupLibraryDir({ argv: [], homeDir: home, cwd: lib })).toEqual({ dir: lib, source: 'cwd' })

    const bare = mkTmp('clw-su-bare-')
    expect(resolveStartupLibraryDir({ argv: [], homeDir: home, cwd: bare })).toEqual({ dir: null, source: 'welcome' })
    cleanup()
  })

  it('workdir.json 不存在（首启）不抛，按无存储回落', () => {
    const home = mkTmp('clw-su-home-')
    const bare = mkTmp('clw-su-bare-')
    expect(resolveStartupLibraryDir({ argv: [], homeDir: home, cwd: bare })).toEqual({ dir: null, source: 'welcome' })
    cleanup()
  })
})
