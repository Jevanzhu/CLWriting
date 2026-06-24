import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { openBrowser, parseArgs } from '../../src/studio/server/studio-cli.js'

afterEach(() => {
  vi.restoreAllMocks()
  spawnMock.mockReset()
})

test('parseArgs rejects invalid studio ports', () => {
  expect(parseArgs([])).toEqual({ port: 7878 })
  expect(parseArgs(['--port', '17878', '--book', '/tmp/book'])).toEqual({
    port: 17878,
    book: '/tmp/book',
  })
  expect(() => parseArgs(['--port', '-1'])).toThrow('端口必须是 1-65535 的整数')
  expect(() => parseArgs(['--port=bad'])).toThrow('端口必须是 1-65535 的整数')
  expect(() => parseArgs(['--port'])).toThrow('--port 需要端口值')
})

test('parseArgs accepts --workdir (空间隔/等号/缺省/共存)', () => {
  expect(parseArgs(['--workdir', '/my/library']).workdir).toBe('/my/library')
  expect(parseArgs(['--workdir=/lib']).workdir).toBe('/lib')
  expect(parseArgs([]).workdir).toBeUndefined()
  // --workdir 后无值不越界
  expect(parseArgs(['--workdir']).workdir).toBeUndefined()
  // 与 --port / --book 共存
  expect(parseArgs(['--port', '9000', '--workdir', '/lib', '--book', '书'])).toEqual({
    port: 9000,
    workdir: '/lib',
    book: '书',
  })
})

test('openBrowser tolerates missing opener command', () => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void }
  child.unref = vi.fn()
  spawnMock.mockReturnValue(child)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})

  openBrowser('http://127.0.0.1:7878')
  child.emit('error', new Error('missing opener'))

  expect(child.unref).toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith('请在浏览器手动打开：http://127.0.0.1:7878')
})
