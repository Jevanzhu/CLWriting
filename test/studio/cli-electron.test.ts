import { describe, it, expect } from 'vitest'
import { resolveSpawnTarget } from '../../src/studio/server/api/cli.js'

describe('clwriting CLI spawn 双模式（#electron）', () => {
  it('studio 模式：cliJs = process.argv[1]，不开 RUN_AS_NODE', () => {
    const r = resolveSpawnTarget(false, '/proj/dist', '/proj/dist/cli.js')
    expect(r.cliJs).toBe('/proj/dist/cli.js')
    expect(r.useRunAsNode).toBe(false)
  })

  it('Electron 模式：server 打进 dist/chunk-*.js 时定位 dist/cli.js', () => {
    const r = resolveSpawnTarget(true, '/app/dist', '/app/dist/desktop/main.js')
    expect(r.cliJs).toBe('/app/dist/cli.js')
    expect(r.useRunAsNode).toBe(true)
  })

  it('Electron 模式：cliJs = here/../cli.js（定位 dist/cli.js），开 RUN_AS_NODE', () => {
    // here=dist/desktop/（main.js 所在）→ ../cli.js = dist/cli.js
    const r = resolveSpawnTarget(true, '/app/dist/desktop', '/app/dist/desktop/main.js')
    expect(r.cliJs).toBe('/app/dist/cli.js')
    expect(r.useRunAsNode).toBe(true)
  })

  it('Electron chunk 模式：here=dist/chunks/ → ../cli.js = dist/cli.js', () => {
    const r = resolveSpawnTarget(true, '/app/dist/chunks', '/app/dist/desktop/main.js')
    expect(r.cliJs).toBe('/app/dist/cli.js')
  })
})
