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
import { clearFalsePositiveMarksForDoc } from '../stores/check'
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
import { parseChapterFileName, chapterFilePrefix } from '../shared/words'
import {
  chapterTemplate,
  chapterOutlineTemplate,
  volumeOutlineTemplate,
  synopsisTemplate,
  worldviewTemplate,
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
  // isPiece 标记短篇正文（3 位补零）；N-8（第十二轮）：bookName 开弹窗时捕获——
  // 弹窗滞留期间切书后提交，deps.bookName() 是新书而 docId 属旧书（错书写入）
  const metaEditing = ref<{
    docId: string
    标题: string
    num: number | null
    isPiece: boolean
    bookName: string
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
        bookName: deps.bookName(),
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
      // R64-2（十二轮）：批量定稿逐章 git 提交可达数秒——在途切书后不刷 B 书树、
      // toast 不落 B 书界面（同文件其余 9 个动作均有「已切书」复检，唯独此处漏）
      if (deps.bookName() !== bookName) return // 已切书：定稿已落 A 书盘，树由切书链自刷
      const done = r.results.filter((x) => x.ok && !x.skipped).length
      const skipped = r.results.filter((x) => x.ok && x.skipped).length
      const failed = r.results.filter((x) => !x.ok).length
      const total = r.results.length
      ui.toast(`已定稿 ${done}/${total} 章${skipped ? `（${skipped} 章已定稿）` : ''}${failed ? `，${failed} 章失败` : ''}`, failed ? 'error' : 'success')
      void tree.load(bookName, true)
    } catch (err) {
      // R71-28（七十一轮）：catch 补切书复检（对齐 success 分支 R64-2 写法）——批量
      // 定稿请求失败时若已切书，A 书的失败 toast 会弹在 B 书界面
      if (deps.bookName() !== bookName) return
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
    // N-8（第十二轮）：书名取开弹窗时的捕获值（同 doDelete FE-1 口径）——弹窗滞留期间
    // 切书后提交，deps.bookName() 已是 B 书而 docId 属 A 书，会错书落 fm/rename
    const book = e.bookName
    try {
      await updateChapterMetaDoc(book, e.docId, { 标题: meta.标题, 章号: meta.num })
      if (deps.bookName() !== book) return // 已切书：不动 B 书界面
      await tree.load(book)
      // 路径可能变（长篇/短篇文件名）→ 同步 doc entry.path
      const entry = doc.get(e.docId)
      if (entry) {
        const fresh = tree.byDocId.get(e.docId)
        if (fresh) entry.path = fresh.path
        // Y-8（第五十七轮）：服务端 op=meta 写 fm + rename → revision 已变，打开中的
        // 文档不 refresh 重对齐基线的话，下一次 autosave/⌘S 必收 REVISION_CONFLICT
        //（重载丢本地编辑 / 覆盖静默回退标题章号）——对齐 EditorDocHead 的 refresh 口径
        await doc.refresh(e.docId)
      }
    } catch (err) {
      // R34D-21（三十四轮）：catch 补切书守卫（对齐 doBatchFinalize 的 R71-28 先例）——
      // 请求失败落 catch 时若已切书，A 书的报错不得写进 B 书界面（静默丢弃旧书报错）
      if (deps.bookName() !== book) return
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
      // M-8（第十一轮）：单例新建补初始模板——骨架模板删除后 createDoc 不传 content
      // 落全空文件，新书总纲/世界观无处供给骨架（既有缺口，非删除批回归）
      const template =
        relPath === '大纲/总纲.md' ? synopsisTemplate() : relPath === '设定/世界观.md' ? worldviewTemplate() : undefined
      await createDoc(bookName, { relPath, ...(template !== undefined ? { content: template } : {}) })
      if (deps.bookName() !== bookName) return // N-9（第十二轮）：已切书——文件已落 A 书，不动 B 界面
      await tree.load(bookName)
      const fresh = tree.byPath.get(relPath)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      if (deps.bookName() !== bookName) return
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
        // R34D-26：种子补零走 chapterFilePrefix 单源（按本书宽度口径）——原完全不补零
        ? `${chapterFilePrefix(nextChapterNo(), bodyPadKind())}未命名`
        : kind === 'volume-outline'
          ? `卷纲_第${volumeCount() + 1}卷`
          : ''
    creating.value = { kind, renderDir, fsDir, seed }
    const next = new Set(ws.treeExpanded)
    next.add(renderDir)
    if (ancestors) for (const a of ancestors) next.add(a)
    // E-3（二十九轮）：新建自动展开随用户动作置「已操作」位（挡迟到 prefs 回填覆盖）
    ws.setTreeExpanded([...next])
  }
  async function onCreateCommit(value: string): Promise<void> {
    const c = creating.value
    if (!c) return
    const name = sanitizeName(value)
    if (!name) {
      // R71-30（七十一轮）：文案补 Windows 保留名拒收项（sanitizeName 新增校验段）
      deps.openError.value = '名称不能为空，或含 / \\ 或以 . 开头，或是 Windows 保留名（CON/NUL/COM1 等）'
      return
    }
    creating.value = null
    const relPath =
      c.kind === 'volume'
        // R34D-26：卷内首章文件名补零走单源（原完全不补零）。卷名目录段 ${name}/ 不可丢
        //（e2e tree-ops 实证：丢段后首章落正文根、卷节点永不出现——树按目录派生卷）
        ? `${c.fsDir}/${name}/${chapterFilePrefix(nextChapterNo(), bodyPadKind())}未命名.md`
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
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      if (deps.bookName() !== book) return
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
    // Z-25（第五十八轮）：书名入口捕获——await 后再求 bookName() 会是 B 书，
    // 对 B 书发起冗余全树重扫（git status + 字数统计，大书较重）
    const book = deps.bookName()
    try {
      await renameDoc(book, node.docId, `${name}.md`)
      // B-10（第六十轮）：await 后活源复检（对齐 doDelete/doCopy 双点守卫）——重命名
      // 在途切书后 tree.load(旧书) 会把 A 书整树覆盖进 B 书工作台（后调者胜写入）
      if (deps.bookName() !== book) return
      await tree.load(book)
      // Y-29（第五十七轮）：doc 缓存 path 回填——不回填则后续 doc.refresh 按旧路径
      // 404 被静默吞、save 后的树字数更新成 no-op（onSaveMeta/EditorDocHead 均有回填）
      const entry = doc.get(node.docId)
      if (entry) {
        const fresh = tree.byDocId.get(node.docId)
        if (fresh) entry.path = fresh.path
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      if (deps.bookName() !== book) return
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
      // E-10（二十九轮）：删章成功即清该章误报灰显键——同路径重建新章复用 legacy docId，
      // 残留键会把旧章灰显态/禁用按钮带给新章
      clearFalsePositiveMarksForDoc(book, node.docId)
      if (deps.bookName() === book) await tree.load(book)
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      if (deps.bookName() !== book) return
      deps.openError.value = friendlyError(e)
    }
  }

  // --- 移动（菜单 + 拖拽共用）---
  async function doMove(docId: string, toDir: string): Promise<void> {
    // Z-25：同 onRenameCommit——书名入口捕获
    const book = deps.bookName()
    try {
      await moveDoc(book, docId, toDir)
      // B-10（第六十轮）：同 onRenameCommit——await 后活源复检，在途切书不再加载旧书树
      if (deps.bookName() !== book) return
      await tree.load(book)
      // Y-29：同 onRenameCommit——doc 缓存 path 随移动回填
      const entry = doc.get(docId)
      if (entry) {
        const fresh = tree.byDocId.get(docId)
        if (fresh) entry.path = fresh.path
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      if (deps.bookName() !== book) return
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
    // M-4（第十一轮）：补零宽度走 chapterFilePrefix 单源（与服务端草稿新建/改名同口径）；
    // R34D-26（三十四轮）：宽度按本书口径推断（原硬编码 'chapter'——短篇书副本也 4 位）
    const no = chapterFilePrefix(nextChapterNo(), bodyPadKind(node))
    const relPath = `写作/正文/${no}${title} 副本.md`
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
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      if (deps.bookName() !== book) return
      deps.openError.value = friendlyError(e)
    }
  }

  // --- 树数据便捷取值（grouped/raw 就地取）---

  /**
   * R34D-26（三十四轮）：本书正文文件名的补零宽度口径（M-4 权威口径：长篇 4 位 /
   * 短篇 3 位，写侧一律经 chapterFilePrefix 单源）。服务端 wire 不产 'piece-body'
   * role（layout.ts 口径注记，勿依赖 role 判短篇），前端以正文目录既有文件名的实际
   * 补零宽度反推本书口径：被操作文件自身优先（doCopy 的源文件），否则扫全树——
   * 见 3 位补零（001-）→ 短篇 piece；见 4 位（0001-）→ 长篇 chapter（两态并存时
   * 长篇优先，混用属 legacy 病态）；全无补零（空书/legacy 无补零）→ 回落长篇
   * chapter（维持 M-4 既有行为）。章号 ≥1000 时两种宽度产物相同，误推无实害。
   * 此前 doCopy 硬编码 'chapter'（短篇书副本也 4 位）、新建种子（startCreate/
   * onCreateCommit 卷内首章）完全不补零，三口径并存（评审 R34D-26）。
   */
  function bodyPadKind(src?: TreeNode): 'chapter' | 'piece' {
    if (src) {
      if (/^0\d{3}-/.test(src.name)) return 'chapter'
      if (/^0\d{2}-/.test(src.name)) return 'piece'
    }
    let sawPiece = false
    let sawChapter = false
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        if (!n.isDirectory && n.path.startsWith('写作/正文/')) {
          if (/^0\d{3}-/.test(n.name)) sawChapter = true
          else if (/^0\d{2}-/.test(n.name)) sawPiece = true
        }
        if (n.children.length) walk(n.children)
      }
    }
    walk(tree.grouped)
    return sawPiece && !sawChapter ? 'piece' : 'chapter'
  }

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

  /** N-13（第十二轮）：清内联编辑态（新建命名/重命名/篇章弹窗/拖拽）——切书时由
   *  ChapterTreePanel 调用：这些 ref 挂的是旧书路径/docId，留着会在新书的树上
   *  渲染出指向不存在节点的输入框/弹窗（重则旧书 docId 提交进新书，N-8/N-9 同族）。 */
  function resetInlineState(): void {
    creating.value = null
    renamePath.value = null
    metaEditing.value = null
    draggedPath.value = null
  }

  return {
    // 状态（模板绑定）
    creating,
    renamePath,
    metaEditing,
    draggedPath,
    resetInlineState,
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
