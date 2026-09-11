/**
 * 书级上下文读取（P1-8 架构下沉：readKind 已下沉 src/format/kind.ts）。
 * 本文件保留为兼容层，re-export 内核实现，既有 import 方零感知。
 *
 * resolveBook：解析书 entry → bookRoot（health / files / documents 及各 docId 线端点共用，
 * 消除「workDir 判空 + readBooks().find + 404」复制粘贴）。
 * resolveDocEntry：docId → 文档清单条目（check / review / rewrite / analysis 等直读线共用，
 * 消除 readManifest(join(...,'文档清单.jsonl')).entries.get(docId) 样板）。
 */
import { join } from 'node:path'
import { readBooks, type BookEntry } from '../../install/books.js'
import { readManifest, type ManifestEntry } from '../../document/manifest.js'

export { readKind } from '../../format/kind.js'

/** 解析书：找 entry → bookRoot；workDir 缺 / 书不存在 → error 联合。
 *  hh §八-12：error 分支带机器码（调用方直送 replyError，信封统一 {code,error}）。 */
export function resolveBook(
  workDir: string | null,
  name: string | undefined,
): { bookRoot: string; entry: BookEntry } | { error: string; status: number; code: string } {
  if (!workDir) return { error: '未定位到工作目录', status: 400, code: 'NO_WORKDIR' }
  if (!name) return { error: '缺少书名', status: 400, code: 'BAD_INPUT' }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404, code: 'NOT_FOUND' }
  return { bookRoot: join(workDir, entry.path), entry }
}

/** docId → 文档清单条目；未登记 / 清单缺失 → null（调用方按 NOT_FOUND 语义回复）。 */
export function resolveDocEntry(bookRoot: string, docId: string): ManifestEntry | null {
  return readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId) ?? null
}

// ── R0912-B-P3-2（2026-09-12 第十篇独立重评修复批）：书注册重验单源 ─────────────
// documents / style / knowledge / config 四个写端点族各持一份同构 bookMovedFailure
// 本地拷贝（R1010b-SRV-P2-1 / R0911-B-P3-4 分头落地），判定口径与人话文案面临漂移
//（documents 版多一个 ok:false 形状）。收敛到本文件（与 resolveBook 同址，四消费方
// ctx 均含 workDir），四处头注的时序说明合并如下（先例 revision-guard.ts X-25 样板）：
//
// 【为什么需要重验】handler 入口 resolveBook 捕获的 bookRoot 只是请求入口快照——
// 随后的 await readJson / 伏笔链排队 / 批量落盘的周期让出可跨过 books.ts 删书
//（rmSync 入墓地）/改名（renameSync 搬目录）的 drain 时点（drain 是快照式，快照后
// 新进单元不被 drain 等待），单元体真正执行时书目录已被搬走/删除，后续写盘
//（svc.save / atomicWriteFile / addEntry / commitSamples 等）会对旧捕获路径 mkdir
// recursive 重建目录树成孤儿文件（无 book.yaml，repairBooks 不认领）。
// 【防线形态】写盘临界段首行（或每次让出后）重验 name→bookRoot 注册：只有执行时刻
// 的注册态才贴近真实落盘时刻。已删（解析失败）或 bookRoot 变化（改名/搬目录）→
// 409 BOOK_MOVED；注册未变 → null 放行。重验只判 book 级注册，不动 docId/docPath
// 语义；文档 rename/move 操作本身不改书注册，不受影响。
// 【信封口径】409 经 replyError 单一出口，code='BOOK_MOVED'，reason 人话各端点一致；
// documents.ts 链单元返回联合以 ok 判别，调用点以「核心对象 + ok:false」组合保持
// 其响应契约逐字节不变。

/** 书注册重验：已删（解析失败）或 bookRoot 变化（改名/搬目录）→ 409 结构化失败；
 *  注册未变 → null（放行写盘）。竞态时序与防线形态见上方 R0912-B-P3-2 头注。 */
export function bookMovedFailure(
  workDir: string | null,
  name: string | undefined,
  capturedRoot: string,
): { code: 'BOOK_MOVED'; reason: string } | null {
  const rNow = resolveBook(workDir, name)
  if ('error' in rNow || rNow.bookRoot !== capturedRoot) {
    return { code: 'BOOK_MOVED', reason: '书已改名或已删除，本次操作已取消——请重新打开本书后再试' }
  }
  return null
}
