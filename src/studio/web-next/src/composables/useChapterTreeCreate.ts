/**
 * 章节树「新建 / inline 创建」子 composable —— 自 useChapterTreeActions.ts 缝 create 拆出。
 *
 * （⑤④产品巨件拆分波4）：useChapterTreeActions.ts（901 行）按
 * 缝 structure + create 纯移动拆分。本文件承载缝 create：inline 新建（八类模板）/
 * 单例新建（总纲·世界观）/ TabBar 新建信号分派 / 新建种子与初始模板组装——含
 * 拍板快断批（阶段 24 登记项）seed 章号前缀捕获与提交侧拼回链路，
 * 逐字节保持。状态 ref（creating）与切书守卫（stillIn/failScoped）、树取值辅助
 * （lastVolumePath/nextChapterNo/volumeCount/bodyPadKind）仍由 useChapterTreeActions
 * 装配后经 deps 传入（refs 与回调原样传递，响应式接线不变）；动作分发/重命名/
 * 删除/移动/复制/篇章信息留残核，结构操作族见 useChapterTreeStructure.ts。
 * 纯移动：代码与注释逐字随迁，零行为变化、零逻辑改写。依赖方向单向（无环回引）：
 * 本文件不 import 残核与 useChapterTreeStructure；模块顶层求值常量零迁移
 * （NEW_DEFAULT_DIRS/NEW_KIND_BY_KEY 仅残核 onMenuSelect 消费，留残核单源）。
 */
import type { Ref } from 'vue'
import type { useDocStore } from '../stores/doc'
import type { useTreeStore } from '../stores/tree'
import type { useUiStore } from '../stores/ui'
import type { CreateKind, useWorkspaceStore } from '../stores/workspace'
import type { TreeNode } from '../types/tree'
import { createDoc } from '../api/documents'
import { chapterFilePrefix } from '../shared/words'
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
import { sanitizeName, extractChapterNo, collectAncestors } from '../shared/chapter-tree'

type TreeStore = ReturnType<typeof useTreeStore>
type DocStore = ReturnType<typeof useDocStore>
type WorkspaceStore = ReturnType<typeof useWorkspaceStore>
type UiStore = ReturnType<typeof useUiStore>

export type CreatingKind =
  'chapter' | 'chapter-outline' | 'volume-outline' | 'character' | 'item' | 'foreshadow' | 'volume' | 'doc'

export type Creating = {
  kind: CreatingKind
  renderDir: string
  fsDir: string
  seed: string
  /** 拍板快断批（阶段 24 登记项）：新建种子的数字前缀（chapter/
   *  chapter-outline 在 startCreate 时捕获）——作者清掉 seed 前缀只填标题时，提交侧
   *  拼回此前缀，堵「文件名无章号 → 取号扫描失明 → fm 章号连号重号」。 */
  seedPrefix: string
} | null

export function useChapterTreeCreate(deps: {
  bookName: () => string
  openError: Ref<string | null>
  tree: TreeStore
  doc: DocStore
  ws: WorkspaceStore
  ui: UiStore
  stillIn: (book: string) => boolean
  failScoped: (book: string, e: unknown) => void
  creating: Ref<Creating>
  lastVolumePath: () => string | null
  nextChapterNo: () => number
  volumeCount: () => number
  bodyPadKind: (src?: TreeNode) => 'chapter' | 'piece'
}) {
  const { tree, doc, ws, ui, stillIn, failScoped, creating, lastVolumePath, nextChapterNo, volumeCount, bodyPadKind } =
    deps

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
      // 单例新建补初始模板——骨架模板删除后 createDoc 不传 content
      // 落全空文件，新书总纲/世界观无处供给骨架（既有缺口，非删除批回归）
      const template =
        relPath === '大纲/总纲.md' ? synopsisTemplate() : relPath === '设定/世界观.md' ? worldviewTemplate() : undefined
      await createDoc(bookName, { relPath, ...(template !== undefined ? { content: template } : {}) })
      if (!stillIn(bookName)) return // 已切书——文件已落 A 书，不动 B 界面
      await tree.load(bookName)
      const fresh = tree.byPath.get(relPath)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      // catch 补切书守卫（对齐）——切书后旧书报错不写新书界面
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
    const seedPrefix =
      kind === 'chapter' || kind === 'chapter-outline' ? chapterFilePrefix(nextChapterNo(), bodyPadKind()) : ''
    const seed =
      kind === 'chapter' || kind === 'chapter-outline'
        ? // 种子补零走 chapterFilePrefix 单源（按本书宽度口径）——原完全不补零
          `${seedPrefix}未命名`
        : kind === 'volume-outline'
          ? `卷纲_第${volumeCount() + 1}卷`
          : ''
    creating.value = { kind, renderDir, fsDir, seed, seedPrefix }
    const next = new Set(ws.treeExpanded)
    next.add(renderDir)
    if (ancestors) for (const a of ancestors) next.add(a)
    // 新建自动展开随用户动作置「已操作」位（挡迟到 prefs 回填覆盖）
    ws.setTreeExpanded([...next])
  }
  async function onCreateCommit(value: string): Promise<void> {
    const c = creating.value
    if (!c) return
    let name = sanitizeName(value)
    if (!name) {
      // 文案补 Windows 保留名拒收项（sanitizeName 新增校验段）
      deps.openError.value =
        '名称不能为空，或含 / \\ 或以 . 开头/结尾，或以空格结尾，或是 Windows 保留名（CON/NUL/COM1 等）'
      return
    }
    creating.value = null
    // 拍板快断批（作者指令「按建议顺序开工」取前端拼回档）：作者清掉种子
    // 前缀只填标题时拼回 seedPrefix——无章号文件名对 nextChapterNo 取号扫描/读侧
    // parseChapterFileName 双失明（连建多章 fm 章号重号、跨卷重号章被结构合并 400 拒收）；
    // 作者自填章号形态（「0007-…」/「第7章…」）不覆盖
    if (
      (c.kind === 'chapter' || c.kind === 'chapter-outline') &&
      c.seedPrefix !== '' &&
      extractChapterNo(name) === null
    ) {
      name = `${c.seedPrefix}${name}`
    }
    const relPath =
      c.kind === 'volume'
        ? // 卷内首章文件名补零走单源（原完全不补零）。卷名目录段 ${name}/ 不可丢
          //（e2e tree-ops 实证：丢段后首章落正文根、卷节点永不出现——树按目录派生卷）
          `${c.fsDir}/${name}/${chapterFilePrefix(nextChapterNo(), bodyPadKind())}未命名.md`
        : `${c.fsDir}/${name}.md`
    // 按类型给初始模板（降低空白页阻力）；volume=建卷即建首章，首章空正文即可
    const content = buildCreateContent(c.kind, name, c.seed)
    // L-F2await 前捕获书名——创建在途切书后 openTab 会在 B 书树命中同路径
    const book = deps.bookName()
    try {
      const r = await createDoc(book, { relPath, ...(content ? { content } : {}) })
      if (!stillIn(book)) return // 已切书：文档已落 A 书，不动 B 界面
      await tree.load(book)
      // tree.load（大书秒级）的 await 窗口切书 A→B 后，byPath 已是
      // B 书树——按 A 书路径查找可能命中 B 书同名文件顶开其正开的活动文档。byPath.get
      // 前补书名复检（doCopy 同步补）
      if (!stillIn(book)) return
      const fresh = tree.byPath.get(r.path)
      if (fresh?.docId) {
        await doc.open(fresh)
        ws.openTab(fresh.docId)
      }
    } catch (e) {
      // catch 补切书守卫（对齐）——切书后旧书报错不写新书界面
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

  return {
    onNewChapter,
    createSingleton,
    dispatchCreate,
    startCreate,
    onCreateCommit,
    onCreateCancel,
  }
}
