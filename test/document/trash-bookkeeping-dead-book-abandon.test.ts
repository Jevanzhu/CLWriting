/**
 * H502（七轮修复复核批）：restore/purge 的清单写回段隔着跨进程清单锁 await——书可在
 * 「端点入口守卫已过、锁等待窗」内被整目录删除。修复后写回锁回调首行做回收站清单
 * 在位复评（入口必在 → 写回时不在 = 外部整删；合法 RMW 对空清单是 0b 重写、从不删
 * 文件，零误伤），死书弃写回（Y-17 best-effort catch / 条目写回 silent catch 留痕），
 * 不在死书残骸上重建清单与回收站条目文件。
 * 死书写回面有两道放大器（判据为何不是 bookRoot 目录/读抛错——见
 * trash.ts throwIfTrashManifestGone 头注）：①锁原语取锁自建 mkdir(dirname) 会把
 * bookRoot 祖先链整个复活；②「文件缺失按合法空」的读口径（readTrashManifestStrict
 * 缺失返 [] / 主清单读走 existsSync 空清单分支）让复活树上两条写回都会「成功」
 * （实证：修复前锁回调写出 134b 孤儿文档清单 + 0b 空回收站清单）。
 * 手法：预持清单锁（本进程 pid 锁文件——活性探测恒存活，journal-cross-process-lock
 * 测试先例）造确定性等待窗；物理搬运/删除完成（锁前同步段收口）即窗内时点，此时
 * rmSync bookRoot——.lock 随书目录一起消失即释放等待者，写回段在死书面上开跑。
 * 断言口径：root/项目 空壳目录由取锁 mkdir 复活（机制固有、先于本修复），孤儿断言
 * 落在**文件面**（清单文件不得重建）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { waitFor } from '../helpers/wait-for.js'
import { DocumentService } from '../../src/document/service.js'
import { restoreTrash, purgeTrash } from '../../src/document/trash.js'

function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempTracked(join(tmpdir(), 'clw-trash-deadbook-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', {
    cwd: root,
    stdio: 'pipe',
  })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"draft"}',
    ].join('\n') + '\n',
  )
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

/** 预持清单锁（本进程 pid → 活性探测恒存活，等待者持续轮询）。 */
function holdLock(target: string): void {
  writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, bootTime: 0 }))
}

describe('trash 写回段死书弃收口（H502）', () => {
  it('restore：清单锁等待窗内书被整删 → 弃写回，不重建孤儿文档清单', async () => {
    const { root, svc } = makeBookWithChapter()
    const trashed = await svc.trashDocument({ docId: 'doc_ch01' })
    expect(trashed.ok).toBe(true)

    holdLock(join(root, '项目', '文档清单.jsonl'))
    const restoring = restoreTrash(root, 'doc_ch01')

    // 物理搬运（锁前同步段）完成 = 正卡在清单锁等待窗：原位文件已回
    const origAbs = join(root, '写作', '正文', '第一卷', '0001-开篇.md')
    await waitFor(() => existsSync(origAbs), 4000, 10, 'restore 到达清单锁等待窗')

    // 窗内整删书目录（.lock 随目录消失 = 释放等待者）
    rmSync(root, { recursive: true })
    const r = await restoring
    expect(r.ok).toBe(true) // 物理恢复已发生，收口段弃写回不反悔

    // 修复前：锁回调在死书残骸上写孤儿文档清单（134b：头 + doc 条目）+ 0b 空回收站清单
    // 修复后：回调首行书身份锚复评（book.yaml ENOENT-only）弃写回，两个清单文件都不得重建
    expect(existsSync(join(root, '项目', '文档清单.jsonl'))).toBe(false)
    expect(existsSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'))).toBe(false)
  })

  it('purge：条目写回锁窗内书被整删 → strict 读先弃，不重建回收站清单', async () => {
    const { root, svc } = makeBookWithChapter()
    const trashed = await svc.trashDocument({ docId: 'doc_ch01' })
    expect(trashed.ok).toBe(true)

    const trashFile = join(root, '工作区', '.trash', 'doc_ch01-0001-开篇.md')
    expect(existsSync(trashFile)).toBe(true)

    holdLock(join(root, '工作区', '.trash', '.trash-manifest.jsonl'))
    const purging = purgeTrash(root, 'doc_ch01')

    // 物理删除（锁前同步段）完成 = 正卡在条目写回锁等待窗
    await waitFor(() => !existsSync(trashFile), 4000, 10, 'purge 到达条目写回锁等待窗')

    rmSync(root, { recursive: true })
    const r = await purging
    expect(r.ok).toBe(true)
    // 修复前实证：缺失按合法空读（[]）+ 取锁 mkdir 复活祖先链 → 死书面「成功」写出 0b
    // 空清单；修复后回调首行书身份锚复评弃写——回收站清单文件不得重建
    expect(existsSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'))).toBe(false)
  })
})
