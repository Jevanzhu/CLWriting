import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { runClwritingCli } from '../../src/studio/server/cli-runner.js'

afterEach(() => {
  spawnMock.mockReset()
})

function mockChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  spawnMock.mockReturnValue(child)
  return child
}

test('runClwritingCli spawns current node with cli target and cwd', async () => {
  const child = mockChild()
  const result = runClwritingCli(['prepare', '2'], '/tmp/book')

  child.stdout.emit('data', Buffer.from('ok\n'))
  child.stderr.emit('data', Buffer.from('warn\n'))
  child.emit('close', 0)

  await expect(result).resolves.toEqual({ ok: true, code: 0, stdout: 'ok\n', stderr: 'warn\n' })
  expect(spawnMock).toHaveBeenCalledTimes(1)
  const [command, args, options] = spawnMock.mock.calls[0]!
  expect(command).toBe(process.execPath)
  expect(args).toEqual([expect.any(String), 'prepare', '2'])
  expect(options).toMatchObject({ cwd: '/tmp/book', env: process.env })
})

test('runClwritingCli reports spawn errors as failed CLI result', async () => {
  const child = mockChild()
  const result = runClwritingCli(['check'], '/tmp/book')

  child.emit('error', new Error('spawn failed'))

  await expect(result).resolves.toEqual({ ok: false, code: -1, stdout: '', stderr: 'spawn failed' })
})
