/**
 * R1W-3（win 平台专项复审 R1）：doTrash 删源失败回滚——半完成软删收口。
 *
 * win 夹具：PowerShell 子进程以 FileShare.Read 持源文件句柄（编辑器占用的真实
 * 形态——允许他人读/建链、禁删）。此时 doTrash 链的 readDoc/硬链接落位照常成功，
 * 恰在删源 rmSync 上撞 EPERM → 回滚分支触发。断言：WRITE_ERROR 人话原因 +
 * 源文件未动 + .trash 落位副本已回滚。
 * （只读属性会被 libuv 清位重试、icacls 拒删 ACL 连读都拦，两者均构造不出该形态；
 * Node 自身句柄带 share-delete 也不行。posix 上该故障不可构造 → it.skipIf 限定 win，
 * J3 范式；posix 对照臂证明 happy path 不受影响。）
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'

function makeSvc(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'clw-r1w3-trash-'))
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

describe('doTrash 删源失败回滚（R1W-3，win 专属夹具）', () => {
  it.skipIf(process.platform !== 'win32')(
    '源被编辑器形态句柄占用（可读可建链禁删）→ WRITE_ERROR + 源未动 + 落位副本回滚',
    async () => {
      const { root, svc } = makeSvc()
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
      const { root, svc } = makeSvc()
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
