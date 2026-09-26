/**
 * R71-8 / R71-12（总七十一轮）改名端点回归：
 * - R71-8：纯大小写改名（同名不同大小写）——大小写不敏感 FS（mac/win）上 newRoot 与
 *   oldRoot 是同一物理目录，原「已存在且非空」检查恒拒；修复后走同目录原位分支
 *   （不搬目录，登记名/path/title 等注册面全量同步）
 * - R71-12：改名目标为已存在**空**目录 → 400（原先放行，POSIX rename 原子替换成功而
 *   Windows renameSync EPERM/EEXIST → 跨平台分叉）；文案区分空/非空
 * - R0911-G-P1-1a（2026-09-11 CI 修复批）：R71-8 的「物理目录不动」是大小写不敏感
 *   FS（mac/win 常态）的平台假设——大小写敏感 FS（ubuntu ext4）上 existsSync(newRoot)
 *   为假，不进同目录原位分支而走全量 renameSync 真改名（旧 case 路径消失）。物理
 *   断言改为运行时 FS 大小写敏感性探测（probeFsCaseInsensitive）驱动，不按
 *   process.platform 硬编码；两分支各断言产品实际行为，注册面断言两分支同口径。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const MIXED_OLD = 'CaseBook甲'
const MIXED_NEW = 'CASEBOOK甲'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

// R0911-G-P1-1a（2026-09-11 CI 修复批）：运行时 FS 大小写敏感性探测结果——true =
// 大小写不敏感（mac APFS 默认 / win NTFS 常态），false = 大小写敏感（ubuntu ext4）。
// 纯大小写改名的物理结果在这两类 FS 上分叉（见文件头 R71-8 注记），断言据此分支。
let fsCaseInsensitive = false

/** R0911-G-P1-1a：在 dir 写一个小写探针文件后以大写名 existsSync——命中即大小写
 *  不敏感。不按 process.platform 硬编码（同一 OS 可挂大小写敏感 APFS 卷等变体），
 *  以实际盘行为准；探针自清理不留残档。 */
function probeFsCaseInsensitive(dir: string): boolean {
  const probe = join(dir, 'r0911-case-probe.tmp')
  writeFileSync(probe, '')
  try {
    return existsSync(join(dir, 'R0911-CASE-PROBE.TMP'))
  } finally {
    rmSync(probe, { force: true })
  }
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

function bookYaml(title: string): string {
  return `spec_version: 1\nkind: long\nbook:\n  title: ${title}\n  genre: 玄幻\nhost: cc\n`
}

/** 建书（登记 + 目录 + book.yaml + 一份正文），返回书根 */
function makeBook(name: string): string {
  const reg = join(workDir, '.clwriting', 'books.jsonl')
  writeFileSync(reg, readFileSync(reg, 'utf8') + JSON.stringify({ name, path: `长篇/${name}`, kind: 'long' }) + '\n')
  const root = join(workDir, '长篇', name)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), bookYaml(name))
  writeFileSync(join(root, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文。\n')
  return root
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r71-rename-'))
  // R0911-G-P1-1a：对实际承载本书目录的同一盘探测（workDir 即 tmpdir 卷）
  fsCaseInsensitive = probeFsCaseInsensitive(workDir)
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
  makeBook(MIXED_OLD)
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R71-8: 纯大小写改名（物理结果按 FS 大小写敏感性分叉，R0911-G-P1-1a）', () => {
  it('仅改大小写 → 200 + 登记/path/title 全量同步（不再 400「已存在且非空」）', async () => {
    const root = join(workDir, '长篇', MIXED_OLD)
    expect(existsSync(root)).toBe(true)

    const r = await req('POST', `/api/books/${encodeURIComponent(MIXED_OLD)}/rename`, { name: MIXED_NEW })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, renamed: true, name: MIXED_NEW, path: `长篇/${MIXED_NEW}` })
    // 事件库钥匙跟随语义：测试服务未接 userDataPath，migrateBookSession 恒成功 →
    // 响应不带 eventsMigrationFailed（两类 FS 同口径；R0911-G-P1-1a 补核）
    expect(r.json).not.toHaveProperty('eventsMigrationFailed')

    // 注册面全量同步：登记名/path（大小写不敏感 FS 上盘目录名保留原大小写，登记互访不受影响）
    const entries = readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const entry = entries.find((e) => e.name === MIXED_NEW)
    expect(entry).toBeDefined()
    expect(entry!.path).toBe(`长篇/${MIXED_NEW}`)
    expect(entries.find((e) => e.name === MIXED_OLD)).toBeUndefined()
    // book.yaml title 同步到新名——物理路径按 FS 大小写敏感性分叉（R0911-G-P1-1a）：
    // 大小写不敏感 → 同目录原位分支，目录名保留原大小写（旧 case 路径可读）；
    // 大小写敏感 → 全量 renameSync 真改名，book.yaml 落新 case 路径。
    const yamlRoot = join(workDir, '长篇', fsCaseInsensitive ? MIXED_OLD : MIXED_NEW)
    const yaml = readFileSync(join(yamlRoot, 'book.yaml'), 'utf8')
    expect(yaml).toContain(`title: ${MIXED_NEW}`)
    if (fsCaseInsensitive) {
      // 大小写不敏感 FS（mac/win 常态）：原位分支——物理目录名不动
      expect(existsSync(join(workDir, '长篇', MIXED_OLD))).toBe(true)
    } else {
      // 大小写敏感 FS（ubuntu ext4）：真改名——旧 case 路径 ENOENT、新 case 路径在位
      expect(existsSync(join(workDir, '长篇', MIXED_OLD))).toBe(false)
      expect(existsSync(join(workDir, '长篇', MIXED_NEW))).toBe(true)
    }
    // 旧名 404、新名 200（身份接口按登记名命中）
    expect((await req('GET', `/api/books/${encodeURIComponent(MIXED_OLD)}`)).status).toBe(404)
    const nb = await req('GET', `/api/books/${encodeURIComponent(MIXED_NEW)}`)
    expect(nb.status).toBe(200)
    expect((nb.json as { title: string }).title).toBe(MIXED_NEW)
  })
})

describe('R71-12: 改名目标目录存在即拒（空/非空文案区分）', () => {
  it('目标为已存在空目录 → 400 带「空目录」文案', async () => {
    makeBook('空靶书')
    const emptyDir = join(workDir, '长篇', '空目录靶')
    mkdirSync(emptyDir, { recursive: true }) // 不放任何文件
    const r = await req('POST', `/api/books/${encodeURIComponent('空靶书')}/rename`, { name: '空目录靶' })
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toContain('空目录')
    // 目标目录原样保留（未被吞并/删除）
    expect(existsSync(emptyDir)).toBe(true)
  })

  it('目标为已存在非空目录 → 400 带「且非空」文案（原口径不回归）', async () => {
    makeBook('非空靶书')
    const dir = join(workDir, '长篇', '非空目录靶')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.md'), 'x')
    const r = await req('POST', `/api/books/${encodeURIComponent('非空靶书')}/rename`, { name: '非空目录靶' })
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toContain('且非空')
  })
})
