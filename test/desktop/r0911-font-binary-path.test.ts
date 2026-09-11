/**
 * R0911-A-P2-1/A-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：darwin 自管 spawn 的
 * fontlist 二进制路径解析直测（font-cache.ts darwinFontListCommand——PM-12 接线的
 * 路径半面）。三个形态：
 * - dev/直跑：bundle 同伴（dist/desktop/fontlist），路径原样；
 * - 打包态：dist/** 进 asar，spawn 不认 asar 内路径 → asarUnpack 外置同相对位改写
 *   （app.asar/ → app.asar.unpacked/）；
 * - 误替换防：路径恰含「app.asar」文件名前缀（app.asar.bak）无分隔符跟随 → 不改写。
 * 纯函数注入路径，平台无关（sep 已内化为平台分隔符，期望值同用 join 构造）。
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { darwinFontListCommand } from '../../src/desktop/font-cache.js'

describe('R0911-A-P2-1：darwinFontListCommand（bundle 同伴 + asar 外置改写）', () => {
  it('dev 形态：bundleDir 无 asar → fontlist 同伴路径原样、args 空（自管 spawn 直接可用）', () => {
    const dir = join('/repo', 'dist', 'desktop')
    expect(darwinFontListCommand(dir)).toEqual({ command: join(dir, 'fontlist'), args: [] })
  })

  it('打包态：路径含 app.asar 段 → 同相对位改写为 app.asar.unpacked（spawn 可执行真文件）', () => {
    const resources = join('/Applications/CLWriting.app/Contents/Resources')
    const inAsar = join(resources, 'app.asar', 'desktop')
    const unpacked = join(resources, 'app.asar.unpacked', 'desktop')
    expect(darwinFontListCommand(inAsar)).toEqual({ command: join(unpacked, 'fontlist'), args: [] })
    // 深层嵌套（asar 内多级目录）同样只改写 app.asar 段，余段原样
    expect(darwinFontListCommand(join(resources, 'app.asar', 'a', 'b')).command).toBe(
      join(resources, 'app.asar.unpacked', 'a', 'b', 'fontlist'),
    )
  })

  it('防误替换：app.asar 仅作文件名前缀（app.asar.bak，无分隔符跟随）→ 不改写', () => {
    const dir = join('/somewhere', 'app.asar.bak', 'desktop')
    expect(darwinFontListCommand(dir)).toEqual({ command: join(dir, 'fontlist'), args: [] })
  })
})
