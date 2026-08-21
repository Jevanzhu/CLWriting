/**
 * 章节树 CRUD 动作（Z-P2-10 自 ChapterTreePanel 拆出）。
 *
 * 覆盖：inline 新建（八类模板）/ 重命名 / 删除 / 移动（菜单+拖拽共用）/ 复制 /
 * 章节·篇章信息 / 单章与批量定稿 / 右键菜单动作分发。共享惯例：成功后刷树、
 * 需要时打开新 tab；失败统一走 openError / ui.toast。
 */
import { ref, type Ref } from 'vue'
import { useTreeStore } from '../stores/tree'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore, type CreateKind } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import type { TreeNode } from '../types/tree'
import {
  createDoc,
  renameDoc,
  moveDoc,
  copyDoc,
  deleteDoc,
  updateChapterMetaDoc,
  batchFinalizeDocs,
} from '../api/documents'
import { parseChapterFileName } from '../shared/words'
import {
  chapterTemplate,
  chapterOutlineTemplate,
  volumeOutlineTemplate,
  characterTemplate,
  itemTemplate,
  foreshadowTemplate,
} from '../shared/templates'
import { friendlyError } from '../shared/error'
import {
  sanitizeName,
  extractChapterNo,
  collectAncestors,
  lastVolumePathIn,
  volumeCountIn,
  nextChapterNoIn,
  pendingChaptersUpToIn,
} from '../shared/chapter-tree'

export type CreatingKind =
  | 'chapter'
  | 'chapter-outline'
  | 'volume-outline'
  | 'character'
  | 'item'
  | 'foreshadow'
  | 'volume'
  | 'doc'

type Creating = {
  kind: CreatingKind
  renderDir: string
  fsDir: string
  seed: string
} | null

/** 新建类 key → 标准落盘目录（空白处 / 找不到右键目录时用）。正文/卷原地建不在此表（依赖右键目标或正文区惯例）。 */
const NEW_DEFAULT_DIRS: Record<string, { renderDir: string; fsDir: string }> = {
  'new-chapter-outline': { renderDir: '大纲', fsDir: '大纲/章纲' },
  'new-volume-outline': { renderDir: '大纲', fsDir: '大纲/卷纲' },
  'new-character': { renderDir: '设定', fsDir: '设定/角色' },
  'new-item': { renderDir: '设定', fsDir: '设定/物品' },
  'new-foreshadow': { renderDir: '设定', fsDir: '设定/伏笔' },
}
/** 新建类 key → startCreate kind（与菜单 NEW_* 常量的 key 一一对应）。 */
const NEW_KIND_BY_KEY: Record<string, 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow'> = {
  'new-chapter-outline': 'chapter-outline',
  'new-volume-outline': 'volume-outline',
  'new-character': 'character',
  'new-item': 'item',
  'new-foreshadow': 'foreshadow',
}

export function useChapterTreeActions(deps: {
  bookName: () => string
  openError: Ref<string | null>
}) {
  const tree = useTreeStore()
  const doc = useDocStore()
  const ws = useWorkspaceStore()
  const ui = useUiStore()

  const creating = ref<Creating>(null)
  const renamePath = ref<string | null>(null)
  // 块2.2 篇章信息弹窗：编辑 标题 + 章号（落 fm + 路径同步 rename；长篇改文件名 / 短篇改文件名）
  // isPiece 标记短篇正文（3 位补零）
  const metaEditing = ref<{
    docId: string
    标题: string
    num: number | null
    isPiece: boolean
  } | null>(null)
  const draggedPath = ref<string | null>(null)

  // --- 菜单动作分发 ---
  function onMenuSelect(key: string, node: TreeNode | null): void {
    // ── 不依赖右键目标的动作（空白处/节点右键均可触发）──
    if (key === 'new-volume') return startCreate('volume', '写作', '写作/正文')
    if (key === 'new-chapter-root') {
      const vol = lastVolumePath()
      return startCreate('chapter', vol ?? '写作', vol ?? '写作/正文')
    }
    if (key === 'new-synopsis') return void createSingleton('大纲/总纲.md', '总纲')
    if (key === 'new-worldview') return void createSingleton('设定/世界观.md', '世界观')
    // 章纲/卷纲/角色/物品/伏笔：子目录右键就地建；空白处落到标准目录（对齐 dispatchCreate）
    const def = NEW_DEFAULT_DIRS[key]
    if (def) {
      const kind = NEW_KIND_BY_KEY[key]!
      if (node && node.isDirectory && !node.path.startsWith('写作/')) {
        // 子目录右键：章纲/卷纲在大纲根落标准子目录，其余就地建
        const fsDir =
          key === 'new-chapter-outline' || key === 'new-volume-outline'
            ? node.path === '大纲'
              ? def.fsDir
              : node.path
            : node.path
        return startCreate(kind, node.path, fsDir)
      }
      return startCreate(kind, def.renderDir, def.fsDir)
    }
    if (key.startsWith('move:')) {
      if (node?.docId) void doMove(node.docId, key.slice('move:'.length))
      return
    }
    if (!node) return
    if (key === 'new-chapter') startCreate('chapter', node.path, node.path)
    else if (key === 'new-doc') startCreate('doc', node.path, node.path)
    else if (key === 'rename') renamePath.value = node.path
    else if (key === 'finalize') {
      if (node.docId) void doc.finalize(node.docId)
    }
    else if (key === 'batch-finalize') {
      const docIds = pendingChaptersUpTo(node)
      if (docIds.length) void doBatchFinalize(docIds)
    }
    else if (key === 'meta') {
      const isPiece = node.role === 'piece-body'
      // 短篇/长篇均从文件名提取编号+标题（短篇 写作/正文/N-标题.md，长篇 写作/正文/[卷/]N-标题.md）
      // 注意：TreeNode.path 是完整相对路径（写作/正文/N-标题.md），章号只能从 name 提取（与 pendingChaptersUpTo 一致）
      const m = parseChapterFileName(node.name)
      metaEditing.value = {
        docId: node.docId ?? '',
        标题: m?.标题 ?? node.name,
        num: m?.章号 ?? null,
        isPiece,
      }
    } else if (key === 'copy') void doCopy(node)
    else if (key === 'copy-path') void onCopyPath(node)
    else if (key === 'reveal-in-folder') void onRevealInFolder(node)
    else if (key === 'delete') void doDelete(node)
  }

  /** 批量定稿：逐个 finalizeRevision（后端串行，无锁冲突）→ 汇总 toast + 刷树。 */
  async function doBatchFinalize(docIds: string[]): Promise<void> {
    const bookName = deps.bookName()
    try {
      const r = await batchFinalizeDocs(bookName, docIds)
      const done = r.results.filter((x) => x.ok && !x.skipped).length
      const skipped = r.results.filter((x) => x.ok && x.skipped).length
      const failed = r.results.filter((x) => !x.ok).length
      const total = r.results.length
      ui.toast(`已定稿 ${done}/${total} 章${skipped ? `（${skipped} 章已定稿）` : ''}${failed ? `，${failed} 章失败` : ''}`, failed ? 'error' : 'success')
      void tree.load(bookName, true)
    } catch (err) {
      ui.toast(friendlyError(err), 'error')
    }
  }

  /** 桌面版：在系统文件管理器中打开文件所在文件夹（shell.showItemInFolder 跨平台，传入 node.path）。 */
  async function onRevealInFolder(node: TreeNode): Promise<void> {
    const show = window.clwritingDesktop?.showInFolder
    if (!show) return
    try {
      await show(deps.bookName(), node.path)
    } catch {
      /* 桌面 IPC 异常静默 */
    }
  }

  async function onCopyPath(node: TreeNode): Promise<void> {
    try {
      await navigator.clipboard.writeText(node.path)
    } catch {
      /* 浏览器限制静默 */
    }
  }

  // --- 篇章信息（块2.2）---
  // 长/短篇统一用「章号」（后端一律落 fm 章号 + 路径 rename）
  async function onSaveMeta(meta: { 标题: string; num: number }): Promise<void> {
    const e = metaEditing.value
    if (!e) return
    metaEditing.value = null
    try {
      await updateChapterMetaDoc(deps.bookName(), e.docId, { 标题: meta.标题, 章号: meta.num })
      await tree.load(deps.bookName())
      // 路径可能变（长篇/短篇文件名）→ 同步 doc entry.path
      const entry = doc.get(e.docId)
      if (entry) {
        const fresh = tree.byDocId.get(e.docId)
        if (fresh) entry.path = fresh.path
      }
    } catch (err) {
      deps.openError.value = friendlyError(err)
    }
  }

  // --- 新建 ---
  function onNewChapter(): void {
    const vol = lastVolumePath()
    startCreate('chapter', vol ?? '写作', vol ?? '写作/正文')
  }
  /** 单文件类型（总纲/世界观）：固定路径，检测存在性，不走 inline 命名。 */
  async function createSingleton(relPath: string, label: string): Promise<void> {
    const bookName = deps.bookName()
    const existing = tree.byPath.get(relPath)
    if (existing?.docId) {
      await doc.open(existing)
      ws.openTab(existing.docId)
      ui.toast(`${label}已存在，已为你打开`, 'info')
      return
    }
    try {
      await createDoc(bookName, { relPath })
      await tree.load(bookName)
      const fresh = tree.byPath.get(relPath)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      deps.openError.value = friendlyError(e)
    }
  }
  /** TabBar 新建信号分派（按 createKind 路由到 startCreate / createSingleton）。 */
  function dispatchCreate(kind: CreateKind): void {
    switch (kind) {
      case 'chapter':
        return onNewChapter()
      case 'chapter-outline':
        return startCreate('chapter-outline', '大纲', '大纲/章纲')
      case 'volume-outline':
        return startCreate('volume-outline', '大纲', '大纲/卷纲')
      case 'character':
        return startCreate('character', '设定', '设定/角色')
      case 'item':
        return startCreate('item', '设定', '设定/物品')
      case 'foreshadow':
        return startCreate('foreshadow', '设定', '设定/伏笔')
      case 'synopsis':
        return void createSingleton('大纲/总纲.md', '总纲')
      case 'worldview':
        return void createSingleton('设定/世界观.md', '世界观')
    }
  }
  function startCreate(kind: CreatingKind, renderDir: string, fsDir: string): void {
    const ancestors = collectAncestors(tree.grouped, renderDir)
    if (!ancestors && !tree.grouped.some((n) => n.path === renderDir)) {
      deps.openError.value = '当前书库无该区域，无法在此新建'
      return
    }
    const seed =
      kind === 'chapter' || kind === 'chapter-outline'
        ? `${nextChapterNo()}-未命名`
        : kind === 'volume-outline'
          ? `卷纲_第${volumeCount() + 1}卷`
          : ''
    creating.value = { kind, renderDir, fsDir, seed }
    const next = new Set(ws.treeExpanded)
    next.add(renderDir)
    if (ancestors) for (const a of ancestors) next.add(a)
    ws.treeExpanded = [...next]
  }
  async function onCreateCommit(value: string): Promise<void> {
    const c = creating.value
    if (!c) return
    const name = sanitizeName(value)
    if (!name) {
      deps.openError.value = '名称不能为空，或含 / \\ 或以 . 开头'
      return
    }
    creating.value = null
    const relPath =
      c.kind === 'volume'
        ? `${c.fsDir}/${name}/${nextChapterNo()}-未命名.md`
        : `${c.fsDir}/${name}.md`
    // 按类型给初始模板（C5，降低空白页阻力）；volume=建卷即建首章，首章空正文即可
    const content = buildCreateContent(c.kind, name, c.seed)
    // L-F2（第八轮）：await 前捕获书名——创建在途切书后 openTab 会在 B 书树命中同路径
    const book = deps.bookName()
    try {
      const r = await createDoc(book, { relPath, ...(content ? { content } : {}) })
      if (deps.bookName() !== book) return // 已切书：文档已落 A 书，不动 B 界面
      await tree.load(book)
      const fresh = tree.byPath.get(r.path)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      deps.openError.value = friendlyError(e)
    }
  }

  /** 按新建类型组装初始模板内容（无模板类型返回 undefined → 后端默认空 front matter）。 */
  function buildCreateContent(kind: CreatingKind, name: string, seed: string): string | undefined {
    switch (kind) {
      case 'chapter': {
        const no = extractChapterNo(`${nextChapterNo()}-${name}`) ?? extractChapterNo(seed) ?? 1
        return chapterTemplate(no, name)
      }
      case 'chapter-outline': {
        const no = extractChapterNo(seed) ?? 1
        return chapterOutlineTemplate(no, name)
      }
      case 'volume-outline': {
        const m = seed.match(/第(\d+)卷/)
        const vol = m ? Number(m[1]) : volumeCount() + 1
        return volumeOutlineTemplate(vol)
      }
      case 'character':
        return characterTemplate(name)
      case 'item':
        return itemTemplate(name)
      case 'foreshadow':
        return foreshadowTemplate(nextChapterNo())
      // volume / doc：建卷自带首章（空正文）；通用文档无模板
      default:
        return undefined
    }
  }
  function onCreateCancel(): void {
    creating.value = null
  }

  // --- 重命名 ---
  async function onRenameCommit(path: string, value: string): Promise<void> {
    // 守卫：Enter 提交后设 renamePath=null → input 卸载触发 blur 二次 emit，此时跳过防重复 renameDoc API
    if (renamePath.value !== path) return
    const name = sanitizeName(value)
    if (!name) {
      renamePath.value = null
      return
    }
    renamePath.value = null
    const node = tree.byPath.get(path)
    if (!node?.docId) return
    try {
      await renameDoc(deps.bookName(), node.docId, `${name}.md`)
      await tree.load(deps.bookName())
    } catch (e) {
      deps.openError.value = friendlyError(e)
    }
  }
  function onRenameCancel(): void {
    renamePath.value = null
  }

  // --- 删除 ---
  async function doDelete(node: TreeNode): Promise<void> {
    if (!node.docId) return
    // FE-1（第七轮）：书名入口捕获（M-8 类横向收敛）——legacy docId 纯路径派生不分书，
    // 弹窗滞留期间跨窗切书后，A 书的确认会命中 B 书同路径文件（错书删除）
    const book = deps.bookName()
    const ok = await ui.ask({
      title: '删除章节',
      message: `确认删除「${node.name}」？可从回收站恢复。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    if (deps.bookName() !== book) return
    try {
      await deleteDoc(book, node.docId)
      if (deps.bookName() === book) await tree.load(book)
    } catch (e) {
      deps.openError.value = friendlyError(e)
    }
  }

  // --- 移动（菜单 + 拖拽共用）---
  async function doMove(docId: string, toDir: string): Promise<void> {
    try {
      await moveDoc(deps.bookName(), docId, toDir)
      await tree.load(deps.bookName())
    } catch (e) {
      deps.openError.value = friendlyError(e)
    }
  }
  async function onDrop(targetPath: string): Promise<void> {
    const src = draggedPath.value
    draggedPath.value = null
    if (!src) return
    const node = tree.byPath.get(src)
    if (!node?.docId) return
    await doMove(node.docId, targetPath)
  }

  // --- 复制（E3.3：新章号 + 「副本」标题；后端复制内容到新 path）---
  async function doCopy(node: TreeNode): Promise<void> {
    if (!node.docId) return
    // 同 meta：章号/标题从 name 提取（path 是完整相对路径）
    const parsed = parseChapterFileName(node.name)
    const title = parsed?.标题 ?? node.name
    const no = String(nextChapterNo()).padStart(4, '0')
    const relPath = `写作/正文/${no}-${title} 副本.md`
    // L-F2（第八轮）：同 onCreateCommit——await 前捕获书名 + 守卫
    const book = deps.bookName()
    try {
      const r = await copyDoc(book, node.docId, relPath)
      if (deps.bookName() !== book) return
      await tree.load(book)
      const fresh = tree.byPath.get(r.path)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      deps.openError.value = friendlyError(e)
    }
  }

  // --- 树数据便捷取值（grouped/raw 就地取）---
  function nextChapterNo(): number {
    return nextChapterNoIn(tree.grouped)
  }
  function volumeCount(): number {
    return volumeCountIn(tree.grouped)
  }
  function lastVolumePath(): string | null {
    return lastVolumePathIn(tree.grouped)
  }
  function pendingChaptersUpTo(target: TreeNode): string[] {
    return pendingChaptersUpToIn(target, tree.raw)
  }

  return {
    // 状态（模板绑定）
    creating,
    renamePath,
    metaEditing,
    draggedPath,
    // 动作
    onMenuSelect,
    doBatchFinalize,
    onRevealInFolder,
    onCopyPath,
    onSaveMeta,
    onNewChapter,
    createSingleton,
    dispatchCreate,
    startCreate,
    onCreateCommit,
    onCreateCancel,
    onRenameCommit,
    onRenameCancel,
    doDelete,
    doMove,
    onDrop,
    doCopy,
  }
}
