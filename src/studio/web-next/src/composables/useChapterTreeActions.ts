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
  structurePlan,
  structureApply,
  structureMergeUndo,
  type MergePlanView,
  type SplitPlanView,
} from '../api/documents'
import { parseChapterFileName, chapterFilePrefix, splitFrontmatter } from '../shared/words'
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
  prevBodyChapterInDisplayOrder,
} from '../shared/chapter-tree'

type CreatingKind =
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

  // ── 切书守卫收敛（E3，复审-0914-优化修复批）──
  // `if (deps.bookName() !== book) return` 复检 + 「catch 里先查书名再落错」样板单源。
  // 红线沿革：R34D-21（catch 补切书守卫）/ R71-28（批量定稿 catch）/ B-10（await 后
  // 活源复检）/ R48-24 / R64-2 各轮均因漏配此守卫出过 bug——收敛只换写法，判定时机
  // 逐位不变（await 返回后先查书名，再决定落错/刷树/开 tab）。
  /** 仍在 book 书（await 窗口后未切书）？ */
  const stillIn = (book: string): boolean => deps.bookName() === book
  /** catch 尾款单源：已切书则静默丢弃旧书报错，仍在本书才落 openError（R34D-21 语义）。 */
  const failScoped = (book: string, e: unknown): void => {
    if (!stillIn(book)) return
    deps.openError.value = friendlyError(e)
  }

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
  // 阶段 24（S4）：拆分弹窗态——干跑视图 + 全文光标偏移（拆分标题输入是执行参数，
  // ui.ask 布尔确认不够用，走 SplitChapterDialog）。bookName 开弹窗时捕获（N-8 同族：
  // 弹窗滞留期间切书后提交，docId/plan 属旧书）。
  const splitEditing = ref<{
    docId: string
    bookName: string
    cursorOffset: number
    plan: SplitPlanView
  } | null>(null)

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
    else if (key === 'merge-into-prev') void doMergeIntoPrev(node)
    else if (key === 'merge-undo') void doMergeUndo(node)
    else if (key === 'split-here') void doSplitHere(node)
  }

  /** 批量定稿：逐个 finalizeRevision（后端串行，无锁冲突）→ 汇总 toast + 刷树。 */
  async function doBatchFinalize(docIds: string[]): Promise<void> {
    const bookName = deps.bookName()
    try {
      const r = await batchFinalizeDocs(bookName, docIds)
      // R64-2（十二轮）：批量定稿逐章 git 提交可达数秒——在途切书后不刷 B 书树、
      // toast 不落 B 书界面（同文件其余 9 个动作均有「已切书」复检，唯独此处漏）
      if (!stillIn(bookName)) return // 已切书：定稿已落 A 书盘，树由切书链自刷
      const done = r.results.filter((x) => x.ok && !x.skipped).length
      const skipped = r.results.filter((x) => x.ok && x.skipped).length
      const failed = r.results.filter((x) => !x.ok).length
      const total = r.results.length
      ui.toast(`已定稿 ${done}/${total} 章${skipped ? `（${skipped} 章已定稿）` : ''}${failed ? `，${failed} 章失败` : ''}`, failed ? 'error' : 'success')
      void tree.load(bookName, true)
    } catch (err) {
      // R71-28（七十一轮）：catch 补切书复检（对齐 success 分支 R64-2 写法）——批量
      // 定稿请求失败时若已切书，A 书的失败 toast 会弹在 B 书界面（落错收口走 failScoped
      // 同款判定，toast 面（非 openError）保持原样）
      if (!stillIn(bookName)) return
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
      // R-P2-1（评审修复批）：op=meta 落 fm + 路径同步 rename（服务端按 docId 自愈
      // legacy 身份，旧路径派生 id 孤儿化）——成功即弃旧身份脏镜像，同 onRenameCommit
      // 取舍：直接丢弃不迁移，防同路径重建文档复用同 id 时误复活旧镜像。
      // book 用开弹窗时捕获的 e.bookName（N-8），清理不随切书落空。
      await updateChapterMetaDoc(book, e.docId, { 标题: meta.标题, 章号: meta.num })
      doc.clearDirtyMirror(book, e.docId)
      if (!stillIn(book)) return // 已切书：不动 B 书界面
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
      // 请求失败落 catch 时若已切书，A 书的报错不得写进 B 书界面（静默丢弃旧书报错）；
      // E3：判定收口 stillIn/failScoped（时机不变：先查书名再落错）
      failScoped(book, err)
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
      if (!stillIn(bookName)) return // N-9（第十二轮）：已切书——文件已落 A 书，不动 B 界面
      await tree.load(bookName)
      const fresh = tree.byPath.get(relPath)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      failScoped(bookName, e)
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
      deps.openError.value = '名称不能为空，或含 / \\ 或以 . 开头/结尾，或以空格结尾，或是 Windows 保留名（CON/NUL/COM1 等）'
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
      if (!stillIn(book)) return // 已切书：文档已落 A 书，不动 B 界面
      await tree.load(book)
      // R48-24（四十八轮）：tree.load（大书秒级）的 await 窗口切书 A→B 后，byPath 已是
      // B 书树——按 A 书路径查找可能命中 B 书同名文件顶开其正开的活动文档。byPath.get
      // 前补书名复检（doCopy 同步补）
      if (!stillIn(book)) return
      const fresh = tree.byPath.get(r.path)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      failScoped(book, e)
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
      // R-P2-1（评审修复批）：改名成功即弃该文档旧身份的脏镜像（直接丢弃、不迁移）——
      // 镜像键含 docId，legacy 文档 id 按路径派生（legacy:<sha256(path)[:16]>，服务端
      // 结构性操作自愈后旧 id 必然孤儿化），同路径重建新文档复用同 id 时 open 会误复活
      // 旧镜像污染新文档。canonical 文档 docId 稳定（键不变），清了只是损失「改名后~
      // 下次击键」的镜像空窗（下一击键/保存即重建，R55-F-3 本就是 best-effort 兜底），
      // 统一直接丢弃，不为 canonical 单独分叉「保留重写」语义。book 用入口快照：清的
      // 是被改名文档所属的旧书键，即便 await 期间切书清理也不落空。
      doc.clearDirtyMirror(book, node.docId)
      // R1010b-FE-P3-2（2026-09-10 内存专项重审修复批）：改名成功即清该文档误报灰显键
      // ——legacy docId 由路径派生，改名后旧 id 孤儿化，同路径重建新文档复用同 id 时
      // 残留键会把旧章灰显态/禁用误报按钮带给新章（E-10 删除链同款清理，原改名链漏）。
      // canonical docId 稳定，清了只是损失灰显展示态（标记真相在服务端），对齐 R-P2-1
      // 「不为 canonical 单独分叉语义」取舍；book 用入口快照，在途切书清理不落空。
      clearFalsePositiveMarksForDoc(book, node.docId)
      // B-10（第六十轮）：await 后活源复检（对齐 doDelete/doCopy 双点守卫）——重命名
      // 在途切书后 tree.load(旧书) 会把 A 书整树覆盖进 B 书工作台（后调者胜写入）
      if (!stillIn(book)) return
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
      failScoped(book, e)
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
    // R44-3（四十四轮）：确认前先落盘脏内容——原链确认→deleteDoc→discard 对
    // autosave 窗口内的脏章直接丢弃内存 entry，「可从回收站恢复」对脏章失实（回收
    // 站只有最后已保存版本）。先尽力保存（saving 中由 F8 在途链落定后排队续存）；
    // 保存失败/冲突未决时换如实文案（conflict 项本就无法自动保存，需作者决断重载/覆盖）。
    // R48-88（四十八轮）：内部落盘 origin 改 autosave——手动保存会弹「已保存」toast，
    // 紧接「确认删除」弹窗语义突兀（这次保存只是删除前置步骤非作者动作）；autosave
    // 静默落盘，留住 R44-3 的防丢语义不惊扰
    const entry = doc.get(node.docId)
    let unsaved = false
    if (entry && entry.dirty) {
      // R59 清偿批（R55-F-6）：在途保存窗口先落定再判——F8 契约下 doc.save(docId,
      // 'autosave') 在 entry.saving 时直接返 false 不等待（节拍自会重扫），且 dirty
      // 要到保存落定才清，原判式在窗口内必误报「未保存的修改将一并丢失」（内容其实
      // 正在落盘）。先 await 在途保存（doc.waitInflightSave，flushDirty 同款台账
      // 等待），落定后按最新 entry 态走既有判式：条目已清按无未保存处理，conflict
      // 未决 / 真保存失败仍如实换文案（保守方向不回退）。
      // R49-25：save 返 false 且 dirty 已清 ≠ 失败（内容已在磁盘）不误报——判式
      // `!save && dirty` 的语义保留不变。R48-88（合并批收编）：内部落盘 origin 用
      // autosave——manual 会弹「已保存」toast，紧接「确认删除」弹窗语义突兀；
      // autosave 静默落盘，R44-3 防丢语义不惊扰。
      await doc.waitInflightSave(node.docId)
      const cur = doc.get(node.docId)
      unsaved = !cur
        ? false
        : cur.conflict
          ? true
          : !(await doc.save(node.docId, 'autosave')) && (doc.get(node.docId)?.dirty ?? false)
    }
    const ok = await ui.ask({
      title: '删除章节',
      message: unsaved
        ? `确认删除「${node.name}」？该章有未保存的修改将一并丢失（回收站只保留最后已保存的版本）。`
        : `确认删除「${node.name}」？可从回收站恢复。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    if (!stillIn(book)) return
    try {
      await deleteDoc(book, node.docId)
      // E-10（二十九轮）：删章成功即清该章误报灰显键——同路径重建新章复用 legacy docId，
      // 残留键会把旧章灰显态/禁用按钮带给新章
      clearFalsePositiveMarksForDoc(book, node.docId)
      // R33-13（三十三轮）：删除成功即丢弃 doc 缓存条目——删除前刚键入（autosave 窗口内）
      // 或本就 dirty 的文档软删后 entry 若仍驻留，autosaveTick 会对已删 docId 无限重试
      // （404 后 dirty 不清），且切书 flushDirty 失败触发「保存失败将永久丢弃」假警报
      if (stillIn(book)) {
        doc.discard(node.docId)
        await tree.load(book)
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      failScoped(book, e)
    }
  }

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

  // --- 移动（菜单 + 拖拽共用）---
  async function doMove(docId: string, toDir: string): Promise<void> {
    // Z-25：同 onRenameCommit——书名入口捕获
    const book = deps.bookName()
    try {
      await moveDoc(book, docId, toDir)
      // B-10（第六十轮）：同 onRenameCommit——await 后活源复检，在途切书不再加载旧书树
      if (!stillIn(book)) return
      await tree.load(book)
      // Y-29：同 onRenameCommit——doc 缓存 path 随移动回填
      const entry = doc.get(docId)
      if (entry) {
        const fresh = tree.byDocId.get(docId)
        if (fresh) entry.path = fresh.path
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      failScoped(book, e)
    }
  }
  async function onDrop(targetPath: string): Promise<void> {
    const src = draggedPath.value
    draggedPath.value = null
    if (!src) return
    const node = tree.byPath.get(src)
    if (!node) {
      // P3-19（全库重评-0914）：源路径已不在树中（拖拽期间外部移动/删除/切书重建）——
      // 原与「目录不支持」共落同一分支，文案误导（这里根本没有目录动作）。单列明示
      // 无数据动作，不静默（R1010-P3「近似卡死」口径）。
      ui.toast('拖拽源已不存在（可能已被移动或删除）', 'info')
      return
    }
    if (!node.docId) {
      // R1010-P3（G6-②）：目录行同样 draggable，拖目录落下此前静默丢弃——
      // 无任何反馈近似「卡死」。moveDoc 仅 docId 面（服务端 move 只收 docId），
      // 目录拖拽移动本就不支持：补 info toast 明示，不改移动语义。
      ui.toast('目录暂不支持拖拽移动（可拖拽章节到目标目录）', 'info')
      return
    }
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
      if (!stillIn(book)) return
      await tree.load(book)
      if (!stillIn(book)) return // R48-24：tree.load 窗口切书防御（onCreateCommit 同款注记）
      const fresh = tree.byPath.get(r.path)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      // R34D-21：catch 补切书守卫（对齐 R71-28）——切书后旧书报错不写新书界面
      failScoped(book, e)
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
    splitEditing.value = null
  }

  return {
    // 状态（模板绑定）
    creating,
    renamePath,
    metaEditing,
    draggedPath,
    splitEditing,
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
    doMergeIntoPrev,
    doMergeUndo,
    doSplitHere,
    onSplitCommit,
    doMove,
    onDrop,
    doCopy,
  }
}
