/**
 * cli-runner existsSync 向上查找命中分支（cli-electron 假路径只测回退,本测试覆盖打包真实路径）。
 * Electron 打包 cli-runner 进 dist/chunk-*.js(here=dist),向上查找命中 dist/cli.js。
 * dev cli-runner 进 src/studio/server(here=src/...),向上到根命中 dist/cli.js。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSpawnTarget } from '../../src/studio/server/api/cli.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-cli-resolve-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('resolveSpawnTarget existsSync 向上查找命中', () => {
  it('Electron: here=dist/chunks → 向上命中根/dist/cli.js（chunk 模式）', () => {
    mkdirSync(join(root, 'dist', 'chunks'), { recursive: true })
    writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node', 'utf8')
    const r = resolveSpawnTarget(true, join(root, 'dist', 'chunks'), '/app/dist/desktop/main.js')
    expect(r.cliJs).toBe(join(root, 'dist', 'cli.js'))
    expect(r.useRunAsNode).toBe(true)
  })

  it('dev: here=src/studio/server → 向上到根命中 dist/cli.js', () => {
    mkdirSync(join(root, 'src', 'studio', 'server'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node', 'utf8')
    const r = resolveSpawnTarget(false, join(root, 'src', 'studio', 'server'), '/proj/scripts/dev-api.ts')
    expect(r.cliJs).toBe(join(root, 'dist', 'cli.js'))
    expect(r.useRunAsNode).toBe(false)
  })

  it('Electron: here=dist 直接命中（main.js 内联,无 chunks 子层）', () => {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node', 'utf8')
    const r = resolveSpawnTarget(true, join(root, 'dist'), '/app/dist/desktop/main.js')
    expect(r.cliJs).toBe(join(root, 'dist', 'cli.js'))
    expect(r.useRunAsNode).toBe(true)
  })

  it('dist 不存在(electronic script 调用) → 兜底非 electron 跟随 argv[1]', () => {
    // 只造 src 不造 dist → existsSync 全 false → 回退
    mkdirSync(join(root, 'src'), { recursive: true })
    const r = resolveSpawnTarget(false, join(root, 'src'), '/proj/dist/cli.js')
    expect(r.cliJs).toBe('/proj/dist/cli.js')
    expect(r.useRunAsNode).toBe(false)
  })
})
