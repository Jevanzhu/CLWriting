/**
 * 章节树「章节结构操作」子 composable —— 自 useChapterTreeActions.ts 缝 structure 拆出。
 *
 * R0916-5h（2026-09-16，⑤④产品巨件拆分波4）：useChapterTreeActions.ts（901 行）按
 * 缝 structure + create 纯移动拆分。本文件承载缝 structure（阶段 24 S3+S4）：并入
 * 上一章 / 撤销并入 / 光标处拆分（干跑 → 确认/弹窗 → 携指纹执行）+ 共用尽力落盘
 * flushUnsaved（仅本族内部消费，保持私有）。状态 ref（splitEditing）与切书守卫
 * （stillIn/failScoped）仍由 useChapterTreeActions 装配后经 deps 传入（refs 与回调
 * 原样传递，响应式接线不变）；新建族见 useChapterTreeCreate.ts，其余动作留残核。
 * 纯移动：代码与注释逐字随迁，零行为变化、零逻辑改写。依赖方向单向（无环回引）：
 * 本文件不 import 残核与 useChapterTreeCreate；模块顶层求值常量零迁移。
 */
import type { Ref } from 'vue'
import { clearFalsePositiveMarksForDoc } from '../stores/check'
import type { useDocStore } from '../stores/doc'
import type { useTreeStore } from '../stores/tree'
import type { useUiStore } from '../stores/ui'
import type { useWorkspaceStore } from '../stores/workspace'
import type { TreeNode } from '../types/tree'
import { structurePlan, structureApply, structureMergeUndo, type MergePlanView, type SplitPlanView } from '../api/documents'
import { splitFrontmatter } from '../shared/words'
import { prevBodyChapterInDisplayOrder } from '../shared/chapter-tree'

type TreeStore = ReturnType<typeof useTreeStore>
type DocStore = ReturnType<typeof useDocStore>
type WorkspaceStore = ReturnType<typeof useWorkspaceStore>
type UiStore = ReturnType<typeof useUiStore>

export function useChapterTreeStructure(deps: {
  bookName: () => string
  openError: Ref<string | null>
  tree: TreeStore
  doc: DocStore
  ws: WorkspaceStore
  ui: UiStore
  stillIn: (book: string) => boolean
  failScoped: (book: string, e: unknown) => void
  splitEditing: Ref<{
    docId: string
    bookName: string
    cursorOffset: number
    plan: SplitPlanView
  } | null>
}) {
  const { tree, doc, ws, ui, stillIn, failScoped, splitEditing } = deps

  // --- 章节结构操作（阶段 24 S3+S4：并入上一章 / 撤销并入 / 光标拆分）---
  // 服务端为唯一真相（结构键/回收站/事件），动作前照 doDelete 范式先落盘脏内容——
  // 结构操作以盘上内容为准，脏内容不落盘就动结构会「合并了半章」。

  /** 尽力落盘单章未保存内容（waitInflightSave 落定在途保存 → dirty 则静默 autosave，
   *  origin 用 autosave 同 R48-88：内部步骤非作者动作，不弹「已保存」toast）。
   *  false = 冲突未决或保存失败，调用方中止并提示。 */
  async function flushUnsaved(docId: string): Promise<boolean> {
    await doc.waitInflightSave(docId)
    const cur = doc.get(docId)
    if (!cur) return true
    if (cur.conflict) return false
    if (cur.dirty) {
      const saved = await doc.save(docId, 'autosave')
      if (!saved && (doc.get(docId)?.dirty ?? false)) return false
    }
    return true
  }

  /** 并入上一章：显示序前一章为目标（prevBodyChapterInDisplayOrder，非章号−1）→
   *  干跑 → ui.ask 确认（.cp-modal 动线，引文预演/RAG 预估入 message）→ 携指纹执行。 */
  async function doMergeIntoPrev(node: TreeNode): Promise<void> {
    if (!node.docId) return
    // FE-1 同族：书名入口捕获——确认弹窗滞留期间切书后，docId 属旧书（错书结构操作）
    const book = deps.bookName()
    const prev = prevBodyChapterInDisplayOrder(node, tree.grouped)
    if (!prev?.docId) return
    // 两章都可能开着脏内容（源章 = 右键目标、目标章 = 前一章可能在别的 tab）——都先落盘
    for (const id of [prev.docId, node.docId]) {
      if (!(await flushUnsaved(id))) {
        ui.toast('有章节未保存的修改无法自动落盘（保存失败或版本冲突），请先处理后再并入', 'error')
        return
      }
    }
    let plan: MergePlanView
    try {
      const r = await structurePlan(book, prev.docId, { op: 'merge', sourceDocId: node.docId })
      plan = r.plan as MergePlanView
    } catch (e) {
      failScoped(book, e) // R34D-21：切书后旧书报错不写新书界面
      return
    }
    if (plan.op !== 'merge') return
    // 干跑即拦（apply 侧同款 400，提前到确认框前——不让作者确认后才被拒）
    if (plan.encodingSuspect) {
      deps.openError.value =
        '任一章是非 UTF-8 编码的存量文件（GBK 等旧档），并入会失真——请先在编辑器外转码为 UTF-8 再操作'
      return
    }
    const missCount = plan.leadPreviews.filter((x) => !x.willMatch).length
    const lines = [
      `将「${plan.sourceTitle}」（第 ${plan.sourceChapterNo} 章，约 ${plan.sourceWords} 字）并入「${plan.targetTitle}」？`,
      '',
      `· 源章移入回收站，可随时右键「撤销并入」还原`,
      `· 目标章 并入 记录：第 ${plan.mergedInto.join('、')} 章`,
    ]
    if (plan.leadPreviews.length) {
      lines.push(`· 履历引文预演：${plan.leadPreviews.length} 条中 ${missCount} 条合并后将失配（体检红）`)
    }
    if (plan.ragChunksToClear > 0) {
      lines.push(`· RAG 向量清理：约 ${plan.ragChunksToClear} 块（下轮索引重建）`)
    }
    if (plan.sourcePreview) lines.push(`· 拼接预览：「${plan.sourcePreview}」`)
    const ok = await ui.ask({
      title: '并入上一章',
      message: lines.join('\n'),
      confirmText: '并入',
    })
    if (!ok) return
    if (!stillIn(book)) return
    try {
      await structureApply(book, prev.docId, {
        op: 'merge',
        sourceDocId: node.docId,
        planHash: plan.planHash,
      })
      if (!stillIn(book)) return
      // 源章已软删：弃编辑器缓存条目 + 清误报灰显键（对齐 doDelete E-10/R33-13 口径）
      clearFalsePositiveMarksForDoc(book, node.docId)
      doc.discard(node.docId)
      await tree.load(book)
      if (!stillIn(book)) return
      // 目标章正文已变——打开中的编辑器重对齐基线（对齐 onSaveMeta Y-8，防下次保存
      // REVISION_CONFLICT：重载丢编辑 / 覆盖静默回退）
      if (doc.get(prev.docId)) await doc.refresh(prev.docId)
      ui.toast(`已并入「${plan.targetTitle}」（源章在回收站，可撤销并入）`, 'success')
    } catch (e) {
      failScoped(book, e) // R34D-21
    }
  }

  /** 撤销并入：目标章回滚到合并前版本 + 源章从回收站还原（服务端三级定位，恒发 {}）。 */
  async function doMergeUndo(node: TreeNode): Promise<void> {
    if (!node.docId) return
    const book = deps.bookName()
    const ok = await ui.ask({
      title: '撤销并入',
      message: [
        `确认撤销「${node.name}」最近一次并入？`,
        '',
        '· 目标章将回滚到合并前版本（合并后的新改动会丢失）',
        '· 源章从回收站还原为独立章节',
      ].join('\n'),
      confirmText: '撤销并入',
    })
    if (!ok) return
    if (!stillIn(book)) return
    // 复审-0913-源码 P1：undo 前置落盘（同节自留纪律——doMergeIntoPrev/doSplitHere
    // 均先 flushUnsaved）——dirty 目标章直接 undo，随后的 doc.refresh 走 dirty 分支
    // 保住本地合并后正文并与回滚基线对齐，下次保存零冲突把合并后内容写回；而源章已
    // 还原 → 两章内容重复且无提示
    if (!(await flushUnsaved(node.docId))) {
      ui.toast('该章未保存的修改无法自动落盘（保存失败或版本冲突），请先处理后再撤销并入', 'error')
      return
    }
    try {
      const r = await structureMergeUndo(book, node.docId)
      if (!stillIn(book)) return
      await tree.load(book)
      if (!stillIn(book)) return
      // 目标章已回滚——打开中的编辑器重对齐基线（Y-8 口径）
      if (doc.get(node.docId)) await doc.refresh(node.docId)
      ui.toast(`已还原第 ${r.sourceChapterNo} 章（目标章已回滚到合并前版本）`, 'success')
    } catch (e) {
      failScoped(book, e) // R34D-21
    }
  }

  /** 光标处拆分（只对当前打开章开放）：落盘脏内容 → 读编辑器光标（正文坐标 → 全文
   *  偏移）→ 干跑 → SplitChapterDialog 输入标题 → onSplitCommit 执行。 */
  async function doSplitHere(node: TreeNode): Promise<void> {
    if (!node.docId) return
    const book = deps.bookName()
    // 菜单已按 activeDocId 过滤，此处兜底复检（快捷路径/竞态窗口）
    if (ws.activeDocId !== node.docId) {
      ui.toast('仅对当前打开的章节可拆分（拆分点取编辑器光标）', 'info')
      return
    }
    if (!(await flushUnsaved(node.docId))) {
      ui.toast('该章未保存的修改无法自动落盘（保存失败或版本冲突），请先处理后再拆分', 'error')
      return
    }
    const readOffset = ws.editorGetCursorOffset
    const editorOffset = readOffset ? readOffset() : null
    if (editorOffset === null) {
      ui.toast('未获取到编辑器光标，请先打开该章再拆分', 'error')
      return
    }
    // 编辑器正文坐标 → 全文偏移（服务端拆分按含 fm 全文切片）：fm 段长 + 编辑器剥掉的
    // 分隔换行——EditorView body computed = splitFrontmatter(c).body 去首个 \n，此处
    // 同源换算（splitFrontmatter 单源，两端口径一致）
    const content = doc.get(node.docId)?.content ?? ''
    const split = splitFrontmatter(content)
    const bodyStart = split
      ? content.length - split.body.length + (split.body.startsWith('\n') ? 1 : 0)
      : 0
    const cursorOffset = bodyStart + editorOffset
    let plan: SplitPlanView
    try {
      const r = await structurePlan(book, node.docId, { op: 'split', cursorOffset })
      plan = r.plan as SplitPlanView
    } catch (e) {
      failScoped(book, e) // R34D-21
      return
    }
    if (plan.op !== 'split') return
    splitEditing.value = { docId: node.docId, bookName: book, cursorOffset, plan }
  }

  /** 拆分弹窗确认（标题必填已在弹窗侧校验）→ 携干跑指纹执行；成功后原章截断重对齐
   *  + 新章开 tab。 */
  async function onSplitCommit(title: string): Promise<void> {
    const s = splitEditing.value
    if (!s) return
    splitEditing.value = null
    const book = s.bookName
    try {
      const r = await structureApply(book, s.docId, {
        op: 'split',
        title,
        cursorOffset: s.cursorOffset,
        planHash: s.plan.planHash,
      })
      if (!stillIn(book)) return
      if (!('newDocId' in r)) return // 结构上不可达（split 请求只回 SplitApplyOk）
      // 原章已截断——打开中的编辑器（拆分前提即打开）重对齐基线，防下次保存 REVISION_CONFLICT
      if (doc.get(s.docId)) await doc.refresh(s.docId)
      await tree.load(book)
      if (!stillIn(book)) return
      const fresh = tree.byDocId.get(r.newDocId)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
      ui.toast(`已拆分：新章 第 ${r.newChapterNo} 章「${title}」`, 'success')
    } catch (e) {
      failScoped(book, e) // R34D-21
    }
  }

  return {
    doMergeIntoPrev,
    doMergeUndo,
    doSplitHere,
    onSplitCommit,
  }
}
