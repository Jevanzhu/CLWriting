/**
 * R37-14（三十七轮）回归：doTrash 删源失败回滚回收站侧。
 *
 * 背景：软删链「先登记后移文件」（GG-P2-6）——appendTrashEntryAsync 写条目 +
 * linkOrRenameExclusive 落位 .trash 后，rmSync 删源失败（win EBUSY/EPERM 瞬时占用）
 * 原先直接上抛，回收站已落位的副本与条目不清理，留下「回收站有条目但源文件还在」的
 * 双份状态（restore 撞源位 OCCUPIED、purge 把仍在原位的文件按不可逆语义清掉）。
 *
 * 修复后行为（本文件锁定，对齐 doMoveOrRename R33-43 删源失败回收新位范式）：
 * 1. 正常软删：源删、.trash 落位、条目在案（基线回归）；
 * 2. 删源失败（mock rmSync 注入 EPERM，r35-27 同款先例）：回收站副本删除 + 条目
 *    移除 + WRITE_ERROR 上抛，源文件原地未动、清单条目保留（可重试）；
 * 3. 重评-13（全库代码重评审 2026-09-05）：回滚删回收站副本收编 rmWithRetry——
 *    回滚首删撞瞬时 EPERM 退避后回收干净；退避耗尽仍失败照旧 warn 留双份残留。
 *
 * 2026-09-26 终扫并入 r1w3-trash-rollback.test.ts（R1W-3，win 平台专项复审 R1）：
 * 同一回滚行为的真实 OS 占用臂——PowerShell 子进程以 FileShare.Read 持源句柄（编辑器
 * 占用真实形态），删源 rmSync 撞 EPERM 触发回滚分支；win 专属（posix 不可构造）+
 * CI 环境门（GH win runner 上该夹具触发 vitest worker 原生崩溃，阶段 44 记档，根因
 * 定位后撤门），win 本机 L2 行使；posix 对照臂证明夹具 happy path 不受影响。断言
 * 逐条保留、零去重（与 mock 注入臂互为观察层）。
 */
import { test, expect, afterEach, describe, it, vi } from 'vitest'
import { rmSync, mkdirSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'
import { listTrash } from '../../src/document/trash.js'
import { readManifest } from '../../src/document/manifest.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// actual 经 hoisted 容器带出——用例内 mockImplementation 需要真实现做 pass-through
const actualFs = vi.hoisted(() => ({
  rmSync: undefined as unknown as typeof import('node:fs').rmSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  actualFs.rmSync = actual.rmSync
  return { ...actual, rmSync: vi.fn(actual.rmSync) }
})

import { rmSync as rmSyncMocked } from 'node:fs'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

const roots: string[] = []
afterEach(() => {
  vi.mocked(rmSyncMocked).mockReset()
  vi.mocked(rmSyncMocked).mockImplementation((...args) => actualFs.rmSync(...args))
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 造书 + 一章正文（经 createDocument 落清单） */
async function makeBookWithChapter(): Promise<{ root: string; svc: DocumentService; docId: string; bodyAbs: string }> {
  const root = mkdtempTracked(join(tmpdir(), 'r37-trash-'))
  roots.push(root)
  mkdirSync(join(root, '工作区'), { recursive: true })
  const svc = new DocumentService({ bookRoot: root })
  const c = await svc.createDocument({
    relPath: '写作/正文/0001-开篇.md',
    content: '---\n章号: 1\n标题: 开篇\n---\n\n正文内容。',
  })
  if (!c.ok) throw new Error('prereq create 失败')
  const bodyAbs = join(root, '写作', '正文', '0001-开篇.md')
  if (!existsSync(bodyAbs)) throw new Error('prereq 正文缺失')
  return { root, svc, docId: c.docId, bodyAbs }
}

test('R37-14: 正常软删——源删、.trash 落位、条目在案（基线回归）', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(true)

  expect(existsSync(bodyAbs)).toBe(false) // 源已删
  const trashDir = join(root, '工作区', '.trash')
  expect(readdirSync(trashDir).filter((f) => f.endsWith('.md'))).toHaveLength(1) // 副本落位
  expect(listTrash(root).some((t) => t.id === docId)).toBe(true) // 条目在案
})

test('R37-14: 删源失败（rmSync EPERM）→ 回收站回滚 + WRITE_ERROR，源与清单原地未动', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  // 仅对正文源路径注入 EPERM（win 文件被占用形态）；其余 rmSync（含回滚删回收站副本）照常。
  // 按目录段+文件名匹配——resolveSafePath 走 realpath 归一（mac 上 /var → /private/var），
  // 全等对不上；回收站副本文件名带 docId 前缀，不含该正文文件名，不误伤。
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('正文') && p.endsWith('0001-开篇.md')) throw errOf('EPERM')
    return actualFs.rmSync(...args)
  })

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR') // 原错误上抛收口，可重试

  // 源文件原地未动、内容无损
  expect(existsSync(bodyAbs)).toBe(true)
  expect(readFileSync(bodyAbs, 'utf-8')).toContain('正文内容。')
  // 回收站侧回滚干净：无 .trash 副本残留、无条目残留（修复前双份状态污染 restore/purge）
  const trashDir = join(root, '工作区', '.trash')
  const leftovers = existsSync(trashDir) ? readdirSync(trashDir).filter((f) => f.endsWith('.md')) : []
  expect(leftovers).toHaveLength(0)
  expect(listTrash(root).some((t) => t.id === docId)).toBe(false)
  // 清单条目保留（manifest 删除在删源之后，未执行）——文件未删则登记不除名，状态一致
  expect(readManifest(join(root, '项目', '文档清单.jsonl')).entries.has(docId)).toBe(true)
})

// ── 重评-13（全库代码重评审 2026-09-05）：回滚删回收站副本收编退避删 ──

test('重评-13: 回滚删回收站副本撞瞬时 EPERM → 退避后回收干净（无副本/条目残留）', async () => {
  const { root, svc, docId, bodyAbs } = await makeBookWithChapter()

  // 删源（正文源路径）持续 EPERM → rmWithRetry 耗尽进回滚；回滚删 .trash 副本首删
  // EPERM（瞬时锁形态，一次后放行）。匹配口径：正文源按目录段+文件名；回收站副本按
  // .trash 目录段 + .md 后缀（登记/条目文件是 .jsonl、原子写 tmp 是 .tmp，均不误伤）。
  let trashCopyRmCalls = 0
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && p.includes('正文') && p.endsWith('0001-开篇.md')) throw errOf('EPERM')
    if (typeof p === 'string' && p.includes('.trash') && p.endsWith('.md')) {
      trashCopyRmCalls++
      if (trashCopyRmCalls === 1) throw errOf('EPERM')
    }
    return actualFs.rmSync(...args)
  })

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR')

  // 回滚经退避后收净（收编前裸 rmSync 首删直败 → 回滚不净 warn：副本+条目双残留）
  expect(trashCopyRmCalls).toBe(2) // 首删 EPERM + 退避重试成功——退避链确被走
  const trashDir = join(root, '工作区', '.trash')
  const leftovers = existsSync(trashDir) ? readdirSync(trashDir).filter((f) => f.endsWith('.md')) : []
  expect(leftovers).toHaveLength(0)
  expect(listTrash(root).some((t) => t.id === docId)).toBe(false)
  // 源与清单原地未动（可重试）
  expect(existsSync(bodyAbs)).toBe(true)
  expect(readManifest(join(root, '项目', '文档清单.jsonl')).entries.has(docId)).toBe(true)
})

test('重评-13: 回滚删回收站副本持续 EPERM → 重试耗尽 warn 留双份残留（与裸删时代一致）', async () => {
  const { svc, docId, bodyAbs } = await makeBookWithChapter()
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

  // 删源与回滚删回收站副本均持续占用（非瞬时形态）
  vi.mocked(rmSyncMocked).mockImplementation((...args) => {
    const p = args[0]
    if (typeof p === 'string' && ((p.includes('正文') && p.endsWith('0001-开篇.md')) || (p.includes('.trash') && p.endsWith('.md')))) {
      throw errOf('EPERM')
    }
    return actualFs.rmSync(...args)
  })

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
  // 回滚退避耗尽仍失败 → 照旧 warn 留痕：源未删、回收站有残留（重试软删按后缀链保双份）
  expect(existsSync(bodyAbs)).toBe(true)
  expect(warn).toHaveBeenCalledWith('document', expect.stringContaining('回滚不净'))
})

// ── R1W-3（win 平台专项复审 R1，2026-09-26 终扫自 r1w3-trash-rollback.test.ts 并入）：
// doTrash 删源失败回滚——真实 OS 占用臂 ─────────────────────────────────────────
// win 夹具：PowerShell 子进程以 FileShare.Read 持源文件句柄（编辑器占用的真实形态——
// 允许他人读/建链、禁删）。此时 doTrash 链的 readDoc/硬链接落位照常成功，恰在删源
// rmSync 上撞 EPERM → 回滚分支触发。断言：WRITE_ERROR 人话原因 + 源文件未动 + .trash
// 落位副本已回滚。
// （只读属性会被 libuv 清位重试、icacls 拒删 ACL 连读都拦，两者均构造不出该形态；
// Node 自身句柄带 share-delete 也不行。posix 上该故障不可构造 → it.skipIf 限定 win，
// J3 范式；posix 对照臂证明 happy path 不受影响。）
// 阶段 44：加 CI 环境门——GH win runner 上该 PowerShell 夹具触发 vitest worker 原生
// 崩溃（exit 3221226505 = 0xC0000409，Desktop 首轮两 attempt 同件确定性复现；本机
// win 三连绿，判 runner 环境特有而非产品回归）。CI 跳过、win 本机 L2 行使；根因
// 定位后撤门。
describe('doTrash 删源失败回滚（R1W-3，真实 OS 占用夹具，win 专属）', () => {
  function makeR1w3Svc(): { root: string; svc: DocumentService } {
    const root = mkdtempSync(join(tmpdir(), 'clw-r1w3-trash-'))
    return { root, svc: new DocumentService({ bookRoot: root }) }
  }

  it.skipIf(process.platform !== 'win32' || Boolean(process.env.CI))(
    '源被编辑器形态句柄占用（可读可建链禁删）→ WRITE_ERROR + 源未动 + 落位副本回滚',
    async () => {
      const { root, svc } = makeR1w3Svc()
      const relPath = '设定/伏笔/神秘印记.md'
      const fp = join(root, relPath)
      const marker = join(root, 'r1w3-lock-marker')
      let child: ChildProcess | null = null
      try {
        mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
        writeFileSync(fp, '---\n标题: 神秘印记\n---\n正文', 'utf-8')
        // PowerShell 持句柄（FileShare.Read = 他人可读、禁写禁删），开妥后落 marker
        child = spawn(
          'powershell',
          ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${fp.replace(/'/g, "''")}','Open','Read','Read'); Set-Content -Path '${marker}' -Value '1'; Start-Sleep 15; $f.Close()`],
          { windowsHide: true, stdio: 'ignore' },
        )
        // 轮询等句柄就绪（powershell 冷启动 ~1s）
        const deadline = Date.now() + 10_000
        while (!existsSync(marker) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        expect(existsSync(marker), 'PowerShell 占位句柄 10s 内未就绪').toBe(true)

        const r = await svc.trashDocument({ docId: legacyId(relPath) })
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.code).toBe('WRITE_ERROR')
          expect(r.reason).toContain('被占用')
        }
        // 源文件未动（可重试）
        expect(existsSync(fp)).toBe(true)
        expect(readFileSync(fp, 'utf-8')).toContain('正文')
        // 落位副本已回滚：.trash 内除回收站清单（. 开头）外零残留
        const trashDir = join(root, '工作区', '.trash')
        expect(existsSync(trashDir)).toBe(true)
        const leftovers = readdirSync(trashDir).filter((n) => !n.startsWith('.'))
        expect(leftovers).toEqual([])
      } finally {
        child?.kill() // 杀掉持句柄子进程，句柄随进程关闭，清理才能落地
        const deadline = Date.now() + 5_000
        while (child && Date.now() < deadline) {
          try {
            if (!existsSync(fp)) break
            rmSync(fp, { force: true })
            break
          } catch {
            await new Promise((r) => setTimeout(r, 100))
          }
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'posix 对照：同夹具正常软删，happy path 不受影响',
    async () => {
      const { root, svc } = makeR1w3Svc()
      try {
        mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
        const relPath = '设定/伏笔/神秘印记.md'
        const fp = join(root, relPath)
        writeFileSync(fp, '---\n标题: 神秘印记\n---\n正文', 'utf-8')
        const r = await svc.trashDocument({ docId: legacyId(relPath) })
        expect(r.ok).toBe(true)
        expect(existsSync(fp)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
