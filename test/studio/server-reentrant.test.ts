import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const servers: http.Server[] = []
const roots: string[] = []

function makeWorkDir(book: string): string {
  const workDir = mkdtempSync(join(tmpdir(), 'clwriting-reentrant-'))
  roots.push(workDir)
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: book, path: book, kind: 'long' }) + '\n',
  )
  return workDir
}

async function listen(server: http.Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('startServer 路由表隔离', () => {
  it('两个 server 同时存在时各自使用自己的 workDir', async () => {
    const a = await listen(startServer({ port: 0, workDir: makeWorkDir('甲书') }))
    const b = await listen(startServer({ port: 0, workDir: makeWorkDir('乙书') }))

    const da = (await (await fetch(`${a}/api/books`)).json()) as { books: { name: string }[] }
    const db = (await (await fetch(`${b}/api/books`)).json()) as { books: { name: string }[] }

    expect(da.books.map((x) => x.name)).toEqual(['甲书'])
    expect(db.books.map((x) => x.name)).toEqual(['乙书'])
  })
})
