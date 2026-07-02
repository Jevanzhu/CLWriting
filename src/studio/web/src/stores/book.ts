/** 当前书：选择态 + 数据缓存（对照 v5 state 书籍域；数据缓存嵌套 data 块） */
import { defineStore } from 'pinia'
import type {
  BookKind,
  BookOverview,
  Rhythm,
  LeadsData,
  MetricsReport,
  StyleTrend,
  PieceDetailData,
  PieceSummary,
  SettingsData,
  CharacterCard,
  RealmSystem,
  BookConfigLoose,
  FileEntry,
  RewriteResult,
} from '../types'
import {
  getOverview,
  getRhythm,
  getLeads,
  getHealth,
  getPiece,
  listPieces,
  getSettings,
  updateCharacter as apiUpdateCharacter,
  updateRealm as apiUpdateRealm,
  getConfig,
  putConfig as apiPutConfig,
  readFile as apiReadFile,
  writeFile as apiWriteFile,
  listFiles,
  revertBook as apiRevertBook,
  rewriteDraft as apiRewriteDraft,
  applyRewrite as apiApplyRewrite,
  type LearnCandidates,
  type LearnSampleCandidate,
  type LearnQuoteCandidate,
} from '../api/books'

/** 单块只读数据槽（统一 value/loading/error） */
interface DataSlot<T> {
  value: T | null
  loading: boolean
  error: string
}

function emptySlot<T>(): DataSlot<T> {
  return { value: null, loading: false, error: '' }
}

/** 可写槽（配置等：DataSlot + saving/savedMsg） */
interface WritableSlot<T> extends DataSlot<T> {
  saving: boolean
  savedMsg: string
}

function emptyWritable<T>(): WritableSlot<T> {
  return { value: null, loading: false, error: '', saving: false, savedMsg: '' }
}

/** 文风铁律编辑槽（文件读写态） */
interface StyleRulesSlot {
  content: string
  original: string
  missing: boolean
  loading: boolean
  saving: boolean
  savedMsg: string
  error: string
}

/** learn 候选 + 作者勾选（运行态在 cli store） */
interface LearnState {
  samples: LearnSampleCandidate[]
  quotes: LearnQuoteCandidate[]
  pickedSamples: boolean[]
  pickedQuotes: boolean[]
}

/** 编辑器槽（文件编辑态 + 改写域；content 走 store 高频写无碍） */
interface EditorSlot {
  files: FileEntry[]
  selected: string
  content: string
  original: string
  loading: boolean
  saving: boolean
  reverting: boolean
  savedMsg: string
  error: string
  /** 改写指令（仅草稿 工作区/草稿-N.md 可用） */
  rewriteInstruction: string
  rewriteResult: RewriteResult | null
  rewriteRunning: boolean
  rewriteApplying: boolean
}

/** 通用加载：清空 → 请求 → 填值/记错（loading/error 自管） */
async function loadSlot<T>(slot: DataSlot<T>, fn: () => Promise<T>): Promise<void> {
  slot.loading = true
  slot.error = ''
  slot.value = null
  try {
    slot.value = await fn()
  } catch (e) {
    slot.error = e instanceof Error ? e.message : String(e)
  } finally {
    slot.loading = false
  }
}

interface BookState {
  /** 当前书名 */
  name: string
  /** 长篇 / 短篇 */
  kind: BookKind
  /** 编辑态当前文件路径 */
  file: string
  /** 短篇篇号 */
  piece: number
  /** 总览态当前子页（o1/a_health…） */
  ov: string
  /** 账本追踪详情 id（v5 ledgerDetail） */
  ledgerDetail: string | null
  /** 工作台当前任务 id */
  task: string
  /** 当前书数据缓存（只读块 + 可写块） */
  data: {
    overview: DataSlot<BookOverview>
    rhythm: DataSlot<Rhythm>
    leads: DataSlot<LeadsData>
    health: DataSlot<{ metrics: MetricsReport; style: StyleTrend }>
    piece: DataSlot<PieceDetailData>
    pieces: DataSlot<PieceSummary[]>
    settings: DataSlot<SettingsData>
    config: WritableSlot<BookConfigLoose>
    styleRules: StyleRulesSlot
    learnCandidates: LearnState
    editor: EditorSlot
  }
}

export const useBookStore = defineStore('book', {
  state: (): BookState => ({
    name: '',
    kind: 'long',
    file: '',
    piece: 1,
    ov: 'o1',
    ledgerDetail: null,
    task: '',
    data: {
      overview: emptySlot(),
      rhythm: emptySlot(),
      leads: emptySlot(),
      health: emptySlot(),
      piece: emptySlot(),
      pieces: emptySlot(),
      settings: emptySlot(),
      config: emptyWritable(),
      styleRules: { content: '', original: '', missing: false, loading: false, saving: false, savedMsg: '', error: '' },
      learnCandidates: { samples: [], quotes: [], pickedSamples: [], pickedQuotes: [] },
      editor: {
        files: [],
        selected: '',
        content: '',
        original: '',
        loading: false,
        saving: false,
        reverting: false,
        savedMsg: '',
        error: '',
        rewriteInstruction: '',
        rewriteResult: null,
        rewriteRunning: false,
        rewriteApplying: false,
      },
    },
  }),
  actions: {
    /** 打开书：重置选择态（kind 决定默认 ov/file） */
    open(name: string, kind: BookKind) {
      this.name = name
      this.kind = kind
      this.file = ''
      this.piece = 1
      this.ov = kind === 'short' ? 'a_piece' : 'o1'
      this.ledgerDetail = null
      this.task = ''
    },
    setFile(f: string) {
      this.file = f
    },
    setOv(o: string) {
      this.ov = o
      this.ledgerDetail = null
    },
    setTask(t: string) {
      this.task = t
    },

    // —— 只读数据加载（name 由 page 从路由传入，不入 store）——
    async loadOverview(name: string) {
      await loadSlot(this.data.overview, () => getOverview(name))
    },
    async loadRhythm(name: string) {
      await loadSlot(this.data.rhythm, () => getRhythm(name))
    },
    async loadLeads(name: string) {
      await loadSlot(this.data.leads, () => getLeads(name))
    },
    async loadHealth(name: string) {
      await loadSlot(this.data.health, () => getHealth(name))
    },
    async loadPiece(name: string, no: number) {
      await loadSlot(this.data.piece, () => getPiece(name, no))
    },
    async loadPieces(name: string) {
      await loadSlot(this.data.pieces, () => listPieces(name))
    },
    async loadSettings(name: string) {
      await loadSlot(this.data.settings, () => getSettings(name))
    },

    // —— Settings 写回 ——
    /** 角色卡（按 file 匹配本地同步） */
    async updateCharacter(name: string, card: CharacterCard) {
      await apiUpdateCharacter(name, card)
      const list = this.data.settings.value?.characters
      if (list) {
        const i = list.findIndex((c) => c.file === card.file)
        if (i >= 0) list[i] = { ...card }
      }
    },
    /** 境界体系 */
    async updateRealm(name: string, body: { 体系: RealmSystem[]; 正文?: string }) {
      await apiUpdateRealm(name, body)
      const s = this.data.settings.value
      if (s) s.realm = body
    },

    // —— 配置（config）读写 ——
    async loadConfig(name: string) {
      await loadSlot(this.data.config, () => getConfig(name))
    },
    async putConfig(name: string, conf: BookConfigLoose) {
      const slot = this.data.config
      slot.saving = true
      slot.error = ''
      try {
        await apiPutConfig(name, conf)
        slot.value = conf
        slot.savedMsg = '配置已保存'
        setTimeout(() => (slot.savedMsg = ''), 2000)
      } catch (e) {
        slot.error = e instanceof Error ? e.message : String(e)
      } finally {
        slot.saving = false
      }
    },

    // —— 文风铁律（styleRules）读写 ——
    async loadStyleRules(name: string) {
      const s = this.data.styleRules
      s.loading = true
      s.error = ''
      try {
        const content = await apiReadFile(name, '文风/文风铁律.md')
        s.content = content
        s.original = content
        s.missing = false
      } catch {
        s.missing = true
        s.content = ''
        s.original = ''
      } finally {
        s.loading = false
      }
    },
    async saveStyleRules(name: string) {
      const s = this.data.styleRules
      if (s.saving || s.missing) return
      s.saving = true
      s.error = ''
      try {
        await apiWriteFile(name, '文风/文风铁律.md', s.content)
        s.original = s.content
        s.savedMsg = '文风铁律已保存'
        setTimeout(() => (s.savedMsg = ''), 2000)
      } catch (e) {
        s.error = e instanceof Error ? e.message : String(e)
      } finally {
        s.saving = false
      }
    },

    // —— learn 候选（结构化产出；运行态/反馈在 cli store）——
    setLearnCandidates(c: LearnCandidates) {
      this.data.learnCandidates.samples = c.samples
      this.data.learnCandidates.quotes = c.quotes
      // 默认全选（机检已过滤≥60），作者可取消不想要的
      this.data.learnCandidates.pickedSamples = new Array(c.samples.length).fill(true)
      this.data.learnCandidates.pickedQuotes = new Array(c.quotes.length).fill(true)
    },
    clearLearn() {
      this.data.learnCandidates.samples = []
      this.data.learnCandidates.quotes = []
      this.data.learnCandidates.pickedSamples = []
      this.data.learnCandidates.pickedQuotes = []
    },

    // —— 编辑器（editor）文件态 + 改写 ——
    /** 拉文件列表（默认 file 跳由由 page 处理，store 不碰 router） */
    async loadFiles(name: string) {
      const e = this.data.editor
      e.error = ''
      try {
        e.files = await listFiles(name)
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err)
      }
    },
    /** 读当前 selected 文件 → 填 content/original */
    async loadFile(name: string) {
      const e = this.data.editor
      if (!e.selected) return
      e.loading = true
      e.error = ''
      e.rewriteResult = null
      try {
        const data = await apiReadFile(name, e.selected)
        e.content = data
        e.original = data
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err)
      } finally {
        e.loading = false
      }
    },
    /** 保存当前文件（dirty 时） */
    async save(name: string) {
      const e = this.data.editor
      if (!e.selected || e.content === e.original) return
      e.saving = true
      e.error = ''
      try {
        await apiWriteFile(name, e.selected, e.content)
        e.original = e.content
        e.savedMsg = '已保存'
        setTimeout(() => (e.savedMsg = ''), 1500)
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err)
      } finally {
        e.saving = false
      }
    },
    /** 回滚到指定章/篇（prompt/confirm 由 page 编排；成功后刷新文件+内容） */
    async revert(name: string, chapter: number) {
      const e = this.data.editor
      e.reverting = true
      e.error = ''
      try {
        const data = await apiRevertBook(name, chapter)
        e.savedMsg = data.message ?? '已回滚'
        setTimeout(() => (e.savedMsg = ''), 3000)
        await this.loadFiles(name)
        if (e.selected) await this.loadFile(name)
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err)
      } finally {
        e.reverting = false
      }
    },
    /** 改写：local(选段)/whole(整章) → POST /rewrite → DiffView */
    async rewriteRun(name: string, chapter: number, mode: 'local' | 'whole', instruction: string, selection?: string) {
      const e = this.data.editor
      e.rewriteRunning = true
      e.error = ''
      e.rewriteResult = null
      try {
        const body: { chapter: number; mode: 'local' | 'whole'; instruction: string; selection?: string } = {
          chapter,
          mode,
          instruction,
        }
        if (mode === 'local' && selection) body.selection = selection
        e.rewriteResult = await apiRewriteDraft(name, body)
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err)
      }
      e.rewriteRunning = false
    },
    /** 应用改写：accept 落盘（更新 content/original），false 丢弃 */
    async rewriteApply(name: string, chapter: number, accept: boolean) {
      const e = this.data.editor
      if (!e.rewriteResult) return
      e.rewriteApplying = true
      e.error = ''
      try {
        const d = await apiApplyRewrite(name, { chapter, content: e.rewriteResult.rewritten, accept })
        if (accept && d.applied) {
          e.content = e.rewriteResult.rewritten
          e.original = e.rewriteResult.rewritten
          e.savedMsg = '改写已落盘(原稿备份 草稿-' + chapter + '.bak.md)'
          setTimeout(() => (e.savedMsg = ''), 3000)
        }
        e.rewriteResult = null
      } catch (err) {
        e.error = err instanceof Error ? err.message : String(err)
      }
      e.rewriteApplying = false
    },

    /** 切书：清空所有数据缓存 */
    resetData() {
      const d = this.data
      for (const slot of [d.overview, d.rhythm, d.leads, d.health, d.piece, d.pieces, d.settings]) {
        slot.value = null
        slot.loading = false
        slot.error = ''
      }
      d.config.value = null
      d.config.loading = false
      d.config.error = ''
      d.config.saving = false
      d.config.savedMsg = ''
      const sr = d.styleRules
      sr.content = ''
      sr.original = ''
      sr.missing = false
      sr.loading = false
      sr.saving = false
      sr.savedMsg = ''
      sr.error = ''
      this.clearLearn()
      const e = d.editor
      e.files = []
      e.selected = ''
      e.content = ''
      e.original = ''
      e.loading = false
      e.saving = false
      e.reverting = false
      e.savedMsg = ''
      e.error = ''
      e.rewriteInstruction = ''
      e.rewriteResult = null
      e.rewriteRunning = false
      e.rewriteApplying = false
    },
  },
})
