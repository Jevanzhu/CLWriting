/** 当前书选择态（对照 v5 state 书籍域：file/piece/ov/task 等） */
import { defineStore } from 'pinia'
import type { BookKind } from '../types'

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
  },
})
