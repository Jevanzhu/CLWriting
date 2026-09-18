/**
 * 0918二轮修复批（D105）：SPA fallback 404 文案按运行形态分叉回归——原 404 文案
 * 恒为「请先运行 npm --prefix src/studio/web-next run build」，打包态用户遇 dist
 * 丢失看到开发者视角指引且泄漏内部路径。修复：src 形态（.ts，tsx dev / vitest）
 * 保留 npm 指引；打包形态（tsup 内联 .js）给通用文案「前端资源缺失，请重新安装应用」。
 * 判据/文案单源 spaMissingUiMessage（devForm 注入口仅测试用，readJson 先例）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStaticHandler, spaMissingUiMessage } from '../../src/studio/server/static.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const DEV_MESSAGE = '前端尚未构建。请先运行：npm --prefix src/studio/web-next run build'
const PACKED_MESSAGE = '前端资源缺失，请重新安装应用'

describe('D105：SPA 入口缺失 404 文案按形态分叉', () => {
  it('开发态（src .ts 形态）：保留 npm 构建指引（r47/r50 既有钉值文案不回退）', () => {
    expect(spaMissingUiMessage(true)).toBe(DEV_MESSAGE)
  })

  it('打包态：通用文案，不含 npm 命令与内部路径（防泄漏面）', () => {
    expect(spaMissingUiMessage(false)).toBe(PACKED_MESSAGE)
    expect(PACKED_MESSAGE).not.toContain('npm')
    expect(PACKED_MESSAGE).not.toContain('src/')
  })

  it('缺省参数取本模块形态：vitest 以 .ts 运行 → 落开发分支', () => {
    expect(spaMissingUiMessage()).toBe(DEV_MESSAGE)
  })

  it('handler 级：入口页缺失时 404 信封 error 文案与当前形态一致（开发态锁行为）', async () => {
    // 空目录（无 index.html）→ SPA fallback 读失败 → 404 信封
    const root = mkdtempTracked(join(tmpdir(), 'clw-d105-static-'))
    const server = http.createServer(createStaticHandler(root))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/missing-spa-route`)
      expect(res.status).toBe(404)
      expect(JSON.parse(await res.text())).toEqual({ code: 'NOT_FOUND', error: spaMissingUiMessage() })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
