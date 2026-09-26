/**
 * 阶段 24 章节结构操作（合并/拆分/撤销合并）——编排层（+）。
 *
 * 设计口径 = 《章节结构操作-设计方案-》（v3，已拍板）：
 * - 留洞制：章号 append-only 永不改指；被合并章软删进回收站，去向记录在目标章
 *   fm `并入: number[]`（写侧链式折叠单跳化——11 并 12,13 时源 13 直接重指向 11）。
 * - 文件本位：真实存储文件是唯一权威，事件库只做审计副录（undo 定位主路径）。
 * - 崩溃不变量：「并入 所指章不得存活于正文」。合并两步（①目标章写入 ②源章软删）
 *   顺序执行各取各放（锁序：不自造并行持双 docId 锁的编排——svc.save 自取目标
 *   save 锁、trashDocument 自取源 save 锁 + 内嵌清单/trash RMW，天然无环）；undo 顺序
 *   （①目标章版本回滚 ②还原源章）保证中途态永不违反不变量。
 * - 写入通道 = svc.save origin 'external-merge'（白名单既有 + 强制留底快照 =
 *   rollbackSnapshotId；禁止绕开它裸 atomicWriteFile——会失去保存锁/锁内复核
 *   /journal 闭环三件套）。
 *
 * 干跑（plan）只读：encodingSuspect 预检 + 拼接摘要 + 履历引文命中率预演 +
 * RAG 清除预估 + plan 指纹（apply 复核防 TOCTOU）。apply 幂等续跑：目标 fm 已含
 * 源章号且回收站在档 = ①后崩溃半成态，跳过写入直续 ②③④⑤。
 *
 * ── 拆分沿革（⑤④产品巨件拆分波2）────────────────
 * 本文件三缝一体纯移动拆分（零行为变化；消费方 import 面不动——下方 re-export 桥
 * 逐名保既有导出面）：
 * - structure-core.ts：公共形状（StructureFailure/StructureRagPort）+ 单读派生/plan
 *   指纹/折叠拼接/事件副录/取号底座（ChapterDiskState/readChapterState/mergePlanHash/
 *   splitPlanHash/foldMergedInto/concatChapterBody/bodyStartOffset/recordStructureEvents/
 *   maxUsedChapter/finalizedChapterNumbers/skipFinalized/splitOrderMid/newestVersionWithoutSource）。
 * - structure-merge.ts：合并编排 + 撤销合并（planChapterMerge/applyChapterMerge/
 *   finishMerge/undoChapterMerge + undo 三级定位）。
 * - structure-split.ts：拆分编排（planChapterSplit/applyChapterSplit + 光标校验）。
 * 依赖方向 core←merge/split 单向无环；本残核保留崩溃不变量判定
 * detectStructureViolations（state.ts 消费）与模块级设计头注（设计方案口径正本
 * 仍在此处）。
 */
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readMdTextCached } from '../fs/md-text-cache.js'
import { walkMdEach } from '../fs/walk-md.js'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
import { parseMergedInto } from '../format/chapters.js'
import { chapterNoFromName } from '../format/filename.js'
import { BODY_PREFIX } from './structure-core.js'

// ── re-export 桥：逐名保 structure.ts 既有导出面，消费方零改动 ──

export type { StructureFailure, StructureRagPort } from './structure-core.js'
export { planChapterMerge, applyChapterMerge, undoChapterMerge } from './structure-merge.js'
export type { MergePlanView, MergeApplyResult, MergeUndoResult, MergeUndoHints } from './structure-merge.js'
export { planChapterSplit, applyChapterSplit } from './structure-split.js'
export type { SplitPlanView, SplitApplyResult } from './structure-split.js'

// ── 崩溃不变量判定（detectState 书内检查挂点，设计方案 §5.5）─────────

/** 结构半成态条目（healthCheck 报文素材；只读判定零副作用）。
 *  0918修复批（B007）：原 targetDocId 字段恒 null（检测走盘面扫描拿不到清单
 *  id，注释宣称的「清单 id」从未布线）——死字段连 health 消费侧死臂一并删除，报文
 *  统一用 targetPath 定位。 */
export interface StructureViolation {
  targetPath: string
  targetChapterNo: number
  targetTitle: string
  sourceChapterNo: number
}

/**
 * 崩溃不变量（repair 判定式）：`并入` 所指章**不得存活于正文**。扫描正文区各章 fm
 * `并入` 登记 × 正文章号全集，所指章号有存活文件即合并半成态（① 后崩溃：fm 已写、
 * 源章软删未起，内容暂重复可见）——收敛路径 = 重跑 apply 幂等续跑（finishMerge 补完
 * 收尾段）或 merge-undo 整体回退（正文盘面定位 + 还原段跳过），两形态见
 * applyChapterMerge / undoChapterMerge 的崩溃分支。正常完成态（源章在回收站/已撤销）
 * 与链式折叠多源态（仅最新源存活判 violation，历史源已在回收站）零误报。
 */
export function detectStructureViolations(bookRoot: string): StructureViolation[] {
  const bodyDir = join(bookRoot, BODY_PREFIX)
  const violations: StructureViolation[] = []
  if (!existsSync(bodyDir)) return violations
  const nos = new Set<number>()
  const registered: { no: number; title: string; path: string; mergedInto: number[] }[] = []
  walkMdEach(bodyDir, (fp, name) => {
    const n = chapterNoFromName(name)
    if (n === null) return
    nos.add(n)
    const raw = readMdTextCached(fp)
    const sp = raw === null ? null : splitFrontMatter(raw)
    if (!sp) return
    const fm = parseFlat(sp.fmRaw)
    const mergedInto = parseMergedInto(fm.get('并入')) ?? []
    if (mergedInto.length === 0) return
    const title = fm.get('标题')
    registered.push({
      no: n,
      title: typeof title === 'string' ? title : '',
      path: relative(bookRoot, fp).replaceAll('\\', '/'),
      mergedInto,
    })
  })
  for (const r of registered) {
    for (const src of r.mergedInto) {
      if (nos.has(src)) {
        // 0918修复批（B007）：targetDocId 恒 null 死字段删除——盘面扫描拿不到
        // 清单 id，报文定位统一走 targetPath
        violations.push({
          targetPath: r.path,
          targetChapterNo: r.no,
          targetTitle: r.title,
          sourceChapterNo: src,
        })
      }
    }
  }
  // 报文确定性：按目标章号 → 源章号排序（walkMdEach 的 readdir 序随文件系统波动）
  violations.sort((a, b) => a.targetChapterNo - b.targetChapterNo || a.sourceChapterNo - b.sourceChapterNo)
  return violations
}
