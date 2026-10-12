/**
 * 书架「继续写作」hero 的 script 单源（全屏页 / 弹层 / 紧凑单行三档共用）。
 *
 * 三档模板形态各异（竖版大卡 / 横版大卡 / 紧凑单行），公共面只有两件：
 * ① 对外契约——props 恒为「书 + 视图档」，事件恒为 open(书名)；
 * ② 「打开」手势——点击、Enter、Space 是同一落点（Enter/Space 由模板的 .prevent 收掉
 *    原生行为，避免滚屏/滚页），光标光斑跟随复用 useShelf 的 onCardMove
 *    （--mx/--my 由 useShelf 侧按帧合并写入）。
 * 手势与契约收在这里，模板与样式仍各族自持——三档布局无公共结构可提，硬提只能靠条件
 * 分支把三份布局塞回一件，反而让差异面失焦。
 */
import type { BookEntry } from '../../api/shelf'
import { onCardMove } from '../../composables/useShelf'

/** 三档 hero 共用的对外契约（grid/list 两档由 viewMode 分派）。 */
export interface ShelfHeroProps {
  book: BookEntry
  viewMode: 'grid' | 'list'
}

export interface ShelfHeroEmits {
  /** 打开本书（点击 / Enter / Space 同一落点） */
  open: [name: string]
}

export interface ShelfHeroGesture {
  /** 打开本书（绑 click / keydown.enter.prevent / keydown.space.prevent） */
  onActivate: () => void
  /** 光标光斑跟随（绑 mousemove） */
  onMove: (e: MouseEvent) => void
}

/**
 * 手势单源：`getName` 取当前书名（prop 活值），`emitOpen` 上抛 open 事件。
 * 事件绑定形态不变——Enter/Space 的原生行为仍由模板修饰符收掉。
 */
export function useShelfHeroGesture(getName: () => string, emitOpen: (name: string) => void): ShelfHeroGesture {
  return {
    onActivate: () => emitOpen(getName()),
    onMove: onCardMove,
  }
}
