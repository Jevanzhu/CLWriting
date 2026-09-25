<script setup lang="ts">
// 文档编辑视图：单行路径式顶栏（面包屑→标题合为一条，720px 居中对齐正文）+ CM6 正文。
// 巨石批 7b 拆分：顶栏整卡 → components/editor/EditorDocHead（标题编辑 v-model 双向），
// AI 辅助指令表/执行器 → composables/useAiAssist（顶栏按钮与右键菜单双消费）；
// 本文件留正文编辑（CmHost/正文 fm 剥离）、右键菜单、自动保存与文档打开编排。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PenLine } from 'lucide-vue-next'
import { useDocStore } from '../stores/doc'
import { useTreeStore } from '../stores/tree'
import { useWorkspaceStore } from '../stores/workspace'
import { useUiStore } from '../stores/ui'
import { getConfig } from '../api/books'
import { mergeFm, formKindOf, isBodyKind, splitFrontmatter } from '../shared/words'
import { useDebouncedFmFields, useDebouncedWordCount } from '../composables/useDebouncedWordCount'
import { useStaleGuard } from '../composables/useStaleGuard'
import {
  registerBodyWriteback,
  scheduleBodyWriteback,
  flushBodyWriteback,
} from '../shared/body-writeback'
import CmHost from '../editor/CmHost.vue'
import EditorDocHead from '../components/editor/EditorDocHead.vue'
import ContextMenu from '../components/ui/ContextMenu.vue'
import type { MenuItem } from '../components/ui/ContextMenu.vue'
import { useNativeMenu } from '../composables/useNativeMenu'
import { useAiAssist } from '../composables/useAiAssist'
import { APP_FIND_EVENT } from '../composables/useAppActions'
import EmptyState from '../components/ui/EmptyState.vue'
import { friendlyError } from '../shared/error'

const props = defineProps<{ docId: string | null }>()
const doc = useDocStore()
const tree = useTreeStore()
const ws = useWorkspaceStore()
const ui = useUiStore()

const aiOff = computed(() => ui.aiAvailable === false)
const isReviewable = computed(() => {
  if (!entry.value) return false
  if (formKindOf(entry.value.path) !== null) return true
  return isBodyKind(entry.value.path)
})

const entry = computed(() => (props.docId ? doc.get(props.docId) : undefined))

// 当前书类型（长篇/短篇），顶栏 pill 展示；切书时重新拉取 book.yaml
const bookKind = ref<'long' | 'short' | null>(null)
// R0916-7-P3-26：请求代守卫收敛 useStaleGuard 单源（原裸计数器 kindReqId）。
// 判定时机逐位不变：await 后先查代再落态，被后发请求作废的迟归结果丢弃。
const kindReq = useStaleGuard()
watch(
  () => doc.bookName,
  async (name) => {
    if (!name) {
      bookKind.value = null
      return
    }
    const reqId = kindReq.begin()
    try {
      const cfg = await getConfig(name)
      if (kindReq.stale(reqId)) return // P2-19：丢弃过期结果
      bookKind.value = cfg.kind === 'short' ? 'short' : 'long'
    } catch {
      if (kindReq.stale(reqId)) return
      bookKind.value = null
    }
  },
  { immediate: true },
)
const hasForm = computed(() => (entry.value ? formKindOf(entry.value.path) !== null : false))
const body = computed(() => {
  const c = entry.value?.content ?? ''
  if (!hasForm.value) return c
  const split = splitFrontmatter(c)
  if (!split) return c
  // R36-6（三十六轮）：只剥 fm/body 分隔的首个换行（mergeFm 恒产出 `---\n\n${body}`，
  // splitFrontmatter 的 body 自带该分隔换行）——作者有意保留的正文前空行原样展示。
  // 旧 `.replace(/^\n+/, '')` 把用户留白一并剥掉：补笔后 store 已记录前导空行，首次
  // 后续键入走 mergeFm 剥前导 → body computed 变化 → CmHost 全量替换把前导回车拽回。
  return split.body.replace(/^\n/, '')
})
function commitBodyWriteback(docId: string, next: string): void {
  // RC 源码重审 B-2（Opus-5.5 轮）③：条目按登记时的 docId 解析——切档后本组件
  // entry 已指向新档（props.docId 已变），照 entry.value 合并回写会把旧档正文整段
  // 写进新档（R51-I-6 同型跨档污染）。doc.get(docId) 与 entry.value 在「同档在编」
  // 时是同一对象，语义同改前；条目已被删/弃（doc.discard、LRU 驱逐、404 清理）时
  // 取不到 → 照改前 onBodyChange 的 `if (!e) return` 早退。
  const e = doc.get(docId)
  if (!e) return
  if (formKindOf(e.path) === null) {
    doc.patch(e.docId, next)
    return
  }
  // R36-6（三十六轮）：编辑路径显式保前导——body computed 已只剥 fm/body 分隔首换行，
  // next 的前导空行全部是用户输入；mergeFm 默认剥前导属「加载/粘贴等明确来源」的
  // 写入口径（rewrite 接受 / refresh 对账走默认），此处关掉——否则补笔后首次后续键入
  // store 前导被剥 → body 变化 → CmHost 全量替换把作者刻意留的正文前留白拽回
  const merged = mergeFm(e.content, next, { stripLeading: false })
  if (merged !== e.content) {
    doc.patch(e.docId, merged)
    return
  }
  // 批2-B（2026-09-07 全量代码重审 批2-B）：删除 R31-30 时代 `next.startsWith('\n')` 的
  // 补笔兜底分支——R36-6 起编辑路径不剥前导后，落至此处即 merged === e.content，而该
  // 分支构造串 `---\n${fmRaw}\n---\n\n${next}` 与 mergeFm(e.content, next,
  // { stripLeading: false }) 逐字节同构（同源 splitFrontmatter + 同模板），patch 同串
  // 恒为 no-op（doc.patch 对同内容早退），纯死代码。
}

// RC 源码重审 B-2（Opus-5.5 轮）：每次按键的正文回写改「登记 + 200ms 尾随节流」，
// 到点才跑上面的 mergeFm + doc.patch（见 shared/body-writeback.ts 头注：不变量与窗口
// 取舍）。改前每个按键都在同步输入栈内跑全文 mergeFm/patch/body 重切/CmHost 全等回比；
// 改后每按键只剩 CmHost 侧一次 doc.toString()（R39-20 已钉的单遍），全量合并按窗口摊薄。
function onBodyChange(next: string): void {
  const e = entry.value
  if (!e) return
  scheduleBodyWriteback(e.docId, next)
}

// RC 源码重审 B-2（Opus-5.5 轮）②：切档前先落防抖尾——props.docId 一变就同步冲刷，
// 早于子层 CmHost 的切档全量替换与本组件 entry 切换后的任何消费；不冲刷则末尾一个
// 窗口的键入随切档静默丢失（红线：编辑永不静默丢失）。用 flush:'sync' 而非默认 pre：
// sync 在 props 落定瞬间执行，判据只看槽内 docId（见 shared/body-writeback.ts 头注③），
// 序不依赖调度器的 pre 队列排序。同档内 props.docId 不变则本 watch 不触发（无开销）。
watch(() => props.docId, () => flushBodyWriteback(), { flush: 'sync' })
// R64-33（十二轮）：字数与服务端/右栏同源（countWords：码点计数 + 剥 markdown 标记）——
// 旧「去空白 UTF-16 计数」与右栏同屏可稳定不一致（markdown 标记/代理对字符）
// R39-20（三十九轮）：字数统计防抖 150ms——countWords 全文码点展开每击键 O(n)（超大
// 单文件可感），显示延迟一拍无感；初值取当拍（首屏/切文档即时），卸载清定时器。
// R0916-7-P3-26：手写副本换装 useDebouncedWordCount 共享件——窗口时长（150ms）、
// 切 docId 即刻重算、口径（countWords 码点计数 + 剥 markdown）逐位不变。内容源改
// entry.content（原为已剥 fm 的 body）：与 FocusStatsBar / WritingInfoPanel /
// HistoryPanel 同源同参，共享件内的单槽记忆据此把同一份正文的每窗口计算收成一遍。
// 由此产生的唯一口径差：非表单目录的 md 若开头有 --- 围栏，此前顶栏把 fm 头计入而
// 右栏/树不计（树口径见 stores/doc.ts 的 stripFrontmatter），现统一为不计。
const { count: wordCount } = useDebouncedWordCount(() => entry.value?.content, () => props.docId)

const isChapter = computed(() => isBodyKind(entry.value?.path ?? ''))
const titleModel = ref('')
// R46-5（四十六轮）：标题 fm 解析 150ms 防抖（parseFmFields 每击键全文 split/join
// 两趟大分配——wordCount R39-20 同族）；F2 编辑守卫与切文档即时语义不变
const { fields: titleFmFields } = useDebouncedFmFields(() => entry.value?.content, () => props.docId)
// F2（五十九轮）：标题编辑守卫——标题框聚焦（新标题未提交）或提交在途期间，watch 源
// entry.content 的任何变化（正文键入/refresh）不得回写 titleModel，否则未提交的新标题
// 被静默覆盖。切文档时强制脱离编辑态（输入框随文档切换失效，提交通道已不可能）。
const titleEditing = ref(false)
watch(
  [titleFmFields, () => props.docId],
  ([f, id], old) => {
    if (old === undefined || old[1] !== id) titleEditing.value = false
    if (titleEditing.value) return
    const e = entry.value
    titleModel.value = e ? (f['标题'] ?? e.name) : ''
  },
  { immediate: true },
)

const { aiActions, runAiAssist } = useAiAssist()
// R35-37：右键 AI 动作按指令 key 取用——原按下标硬编码（aiActions[0..3]）与指令表
// 顺序隐式耦合，重排即静默错动作。零行为变更（当前顺序下动作映射不变）。
const aiActionByKey: Map<string, (typeof aiActions)[number]> = new Map(
  aiActions.map((a) => [a.key, a]),
)

type CmHostExposed = {
  insertText: (t: string) => void
  getSelection: () => string
  hasSelection: () => boolean
  getCursorOffset: () => number | null
  clipboardCut: () => Promise<void>
  clipboardCopy: () => Promise<void>
  clipboardPaste: () => Promise<void>
  selectAll: () => void
  undoAction: () => void
  redoAction: () => void
  openSearch: () => void
}
const cmHost = ref<CmHostExposed | null>(null)

// 右键菜单（桌面端 → macOS 原生 Menu；浏览器 → 自定义 ContextMenu）
const { isNative, menuVisible, menuX, menuY, menuItems, popup, onPopupSelect, onPopupClose } = useNativeMenu()

function onContextMenu(e: MouseEvent): void {
  const hasSel = cmHost.value?.hasSelection() ?? false
  popup(buildCtxItems(hasSel), e.clientX, e.clientY, onCtxSelect)
}

function buildCtxItems(hasSel: boolean): MenuItem[] {
  const items: MenuItem[] = [
    { key: 'cut', label: '剪切', accelerator: 'CmdOrCtrl+X', disabled: !hasSel },
    { key: 'copy', label: '复制', accelerator: 'CmdOrCtrl+C', disabled: !hasSel },
    { key: 'paste', label: '粘贴', accelerator: 'CmdOrCtrl+V' },
    { key: 'sep1', label: '', separator: true },
    { key: 'undo', label: '撤销', accelerator: 'CmdOrCtrl+Z' },
    { key: 'redo', label: '重做', accelerator: 'CmdOrCtrl+Shift+Z' },
    { key: 'sep2', label: '', separator: true },
    { key: 'selectAll', label: '全选', accelerator: 'CmdOrCtrl+A' },
    { key: 'sep3', label: '', separator: true },
    { key: 'find', label: '查找', accelerator: 'CmdOrCtrl+F' },
  ]
  if (isReviewable.value && !aiOff.value) {
    items.push({ key: 'sep4', label: '', separator: true })
    items.push({
      key: 'ai',
      label: 'AI 辅助',
      submenu: aiActions.map(a => ({
        key: `ai-${a.key}`,
        label: a.label,
        disabled: !hasSel,
      })),
    })
  }
  return items
}

async function onCtxSelect(key: string): Promise<void> {
  // R35-37：AI 子菜单项 key 形如 `ai-<指令key>`，按 key 查指令表取动作
  if (key.startsWith('ai-')) {
    const action = aiActionByKey.get(key.slice(3))
    if (action) void runAiAssist(action)
    return
  }
  switch (key) {
    case 'cut': await cmHost.value?.clipboardCut(); break
    case 'copy': await cmHost.value?.clipboardCopy(); break
    case 'paste': await cmHost.value?.clipboardPaste(); break
    case 'undo': cmHost.value?.undoAction(); break
    case 'redo': cmHost.value?.redoAction(); break
    case 'selectAll': cmHost.value?.selectAll(); break
    case 'find': cmHost.value?.openSearch(); break
  }
}

// P2-21：仅插入成功才消费，防无编辑器时文本静默丢失。
// 低级项（第六轮）：immediate 的回调在 setup 期执行时 cmHost 必为 null（模板 ref 未挂），
// 「挂载后补消费」实际不达——挂载时（onMounted）与 doc 异步打开落位后（nextTick）各补一次
function tryConsumeInsert(): void {
  const cmd = ws.pendingInsert
  if (!cmd || !cmHost.value) return
  // R0916-7-P3-24：一次性令牌 consume()——挂载/落位多口补消费并存时重复消费得
  // null，天然幂等；仅插入成功才占消费权（cmHost 缺位不 consume，令牌留槽等下次）
  const text = cmd.consume()
  if (text === null) return
  cmHost.value.insertText(text)
}
watch(() => ws.pendingInsert, () => tryConsumeInsert(), { immediate: true })

watch(
  // CC-P1-4：同时挂 docId 和 tree.byDocId——恢复持久化 activeDocId 时 getBookPrefs（快）
  // 可能先于 tree.load（慢，大书含 git status + 全盘字数）返回，此时 byDocId 为空；
  // 仅 watch docId 会触发一次空查找后静默放弃，树到达后无补偿重试 → 编辑器停留空态。
  // 挂上 byDocId.get(docId) 后树加载完成 watch 重触发，补开恢复的文档。
  [() => props.docId, () => (props.docId ? tree.byDocId.get(props.docId) : undefined)],
  async ([id]) => {
    if (!id || doc.get(id)) return
    const node = tree.byDocId.get(id)
    if (!node) return
    // V-P2-28：打开失败不再静默——空编辑器无提示会让作者以为内容丢了
    try {
      await doc.open(node)
      // 低级项（第六轮）：doc 落位渲染出 CmHost 后补消费挂起中的插入信号
      //（挂载时 entry 尚空 → onMounted 那次消费不到，此后同值不再触发 watch）
      void nextTick().then(() => tryConsumeInsert())
    } catch (err) {
      ui.toast(friendlyError(err), 'error')
    }
  },
  { immediate: true },
)

// 复审-0913-mac适配 P3-7：全局查找入口（系统菜单「查找…」/ ⌘F 经 useAppActions 与
// useHotkeys 派发 APP_FIND_EVENT）桥接到本视图——复用右键菜单 'find' 同一条
// cmHost.openSearch() 路径（openSearchPanel 幂等，已开面板不重复弹层）；无活动文档时
// cmHost 为 null 可选链短路，安全 no-op。
function onAppFind(): void {
  cmHost.value?.openSearch()
}

// Q-9（第十五轮）：自动保存定时器上移 Book.vue（切到工作台/总览等视图后本组件卸载，
// 此前 dirty 文档随之停止自动保存）——此处只保留编辑器专属生命周期接线。
onMounted(() => {
  // R0916-7-P3-24：选区/光标查询面收敛为单句柄注册（原两个函数槽各自挂卸，
  // 含阶段 24 的光标偏移读取器——章节拆分读拆分点）
  ws.setEditorHandle({
    getSelection: () => cmHost.value?.getSelection() ?? '',
    getCursorOffset: () => cmHost.value?.getCursorOffset() ?? null,
  })
  // RC 源码重审 B-2（Opus-5.5 轮）：正文回写执行体注册（mergeFm + doc.patch 的落回
  // 入口，见 shared/body-writeback.ts 头注）——本组件在场期间按键回写走 200ms 防抖窗
  registerBodyWriteback(commitBodyWriteback)
  // 低级项（第六轮）：immediate watch 在 setup 期 cmHost 为 null 消费不到——挂载补一次
  tryConsumeInsert()
  window.addEventListener(APP_FIND_EVENT, onAppFind)
})
onUnmounted(() => {
  // RC 源码重审 B-2（Opus-5.5 轮）②：卸载（切到工作台/总览等视图）先落防抖尾，
  // 否则末尾一个窗口的键入随组件销毁静默丢失；落回用槽内 docId，不依赖本组件 props。
  // 序：flush 先于注销——注销会丢弃未落槽（registerBodyWriteback(null) 的既定语义）
  flushBodyWriteback()
  registerBodyWriteback(null)
  ws.setEditorHandle(null)
  window.removeEventListener(APP_FIND_EVENT, onAppFind)
})
</script>

<template>
  <EmptyState v-if="!entry" :icon="PenLine" text="选择左侧章节开始写作" class="editor-empty" />
  <div v-else class="editor-view" :class="{ 'editor-focus': ws.focusMode }">
    <EditorDocHead v-if="!ws.focusMode" v-model:title="titleModel" :doc-id="docId" :book-kind="bookKind" :word-count="wordCount" @update:title-editing="titleEditing = $event" />
    <div class="doc-body">
      <div class="doc-page">
        <!-- 标题居中（只读展示，编辑入口在顶栏）；专注模式下隐藏 -->
        <div v-if="!ws.focusMode" class="page-title-area">
          <span class="page-title">{{ isChapter ? (titleModel || '未命名') : entry.name }}</span>
        </div>
        <!-- 正文编辑器 -->
        <div class="page-editor" @contextmenu.prevent="onContextMenu">
          <CmHost
            ref="cmHost"
            :model-value="body"
            :mode="entry.mode"
            :typewriter="ws.focusMode"
            :history-key="docId ?? undefined"
            @update:model-value="onBodyChange"
          />
        </div>
        <i class="crop cm-tl" />
        <i class="crop cm-tr" />
        <i class="crop cm-bl" />
        <i class="crop cm-br" />
      </div>
    </div>
    <ContextMenu
      v-if="!isNative"
      :visible="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onPopupSelect"
      @close="onPopupClose"
    />
  </div>
</template>

<style scoped>
.editor-empty {
  height: 100%;
  justify-content: center;
}
.editor-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background-secondary);
  /* 统一左右 padding（doc-head 和 doc-body 共享） */
  --doc-pad-x: var(--size-4-12);
  /* 角标参数（全局共享） */
  --crop-size: 40px;
  --crop-edge: 90px;
  --crop-gap: 10px;
  /* 正文宽度 = 纸张宽度 - 两侧(角标边距 + 角标大小 + 间距) */
  --prose-max-width: max(320px, calc(100% - 2 * (var(--crop-edge) + var(--crop-size) + var(--crop-gap))));
}

/* 纸张内标题（绝对定位，在角标上方） */
.page-title-area {
  position: absolute;
  top: var(--size-4-6);
  left: 0;
  right: 0;
  max-width: var(--prose-max-width);
  margin: 0 auto;
  z-index: 2;
  text-align: center;
}
.page-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-normal);
  font-family: var(--prose-font);
  border: none;
  outline: none;
  background: transparent;
  text-align: center;
  width: 100%;
}
.page-editor {
  height: 100%;
}

/* ===== Word 风格纸张 ===== */
.doc-body {
  flex: 1;
  min-height: 0;
  padding: var(--size-4-3) var(--doc-pad-x) var(--size-4-5);
  overflow: hidden;
}
.doc-page {
  --page-pad: 105px;
  position: relative;
  height: 100%;
  max-width: var(--page-width, 1020px);
  margin: 0 auto;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  box-shadow: var(--shadow-s), var(--shadow-l);
  overflow: hidden;
  padding: var(--page-pad) 0;
}
/* 专注模式纸张宽度回归用户设置值（--page-width，见 .doc-page 基础规则）——
 * 不因专注刻意放大/收窄，调整入口移专注态右侧浮动排版条（FocusFormatBar） */
.crop {
  position: absolute;
  width: var(--crop-size);
  height: var(--crop-size);
  pointer-events: none;
  z-index: 1;
}
.cm-tl {
  top: calc(var(--page-pad) - var(--crop-size));
  left: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-right: 1px solid var(--background-modifier-border-active);
  border-bottom: 1px solid var(--background-modifier-border-active);
}
.cm-tr {
  top: calc(var(--page-pad) - var(--crop-size));
  right: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-left: 1px solid var(--background-modifier-border-active);
  border-bottom: 1px solid var(--background-modifier-border-active);
}
.cm-bl {
  bottom: calc(var(--page-pad) - var(--crop-size));
  left: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-right: 1px solid var(--background-modifier-border-active);
  border-top: 1px solid var(--background-modifier-border-active);
}
.cm-br {
  bottom: calc(var(--page-pad) - var(--crop-size));
  right: min(var(--crop-edge), calc(50% - var(--crop-size) - var(--crop-gap)));
  border-left: 1px solid var(--background-modifier-border-active);
  border-top: 1px solid var(--background-modifier-border-active);
}
</style>
