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
