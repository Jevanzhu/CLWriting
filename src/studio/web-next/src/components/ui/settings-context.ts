import type { InjectionKey } from 'vue'
import type { BookConfig } from '../../api/books'

/** saveConfig 的可选参数。
 *
 *  `label` 是**未保存清单上显示的名字**（如「书籍类型」）：写失败时 UI 已置位而 book.yaml
 *  未变，作者需要一个能对上号的落点才知道「哪一项没保存」，否则只能看到一条错误 toast、
 *  而面板上所有控件都还显示着新值。 */
export interface SaveConfigOpts {
  /** 不弹成功 toast（range 拖动等高频场景） */
  silent?: boolean
  /** 未保存清单上的项名；缺省归入「book.yaml」 */
  label?: string
}

/** saveConfig 注入键：SettingsModal provide，Book/Ai/History 子组件 inject。
 *  串行化读写 book.yaml（防快速连续修改竞态）。
 *
 *  返回 true = 落盘成功；false = 失败（原因已 toast，并已在未保存清单里登记）。
 *
 *  **失败不自动回滚**：多窗口并发下 A 窗口回滚可能覆盖 B 窗口刚写的值，比不回滚更坏。
 *  故失败只登记、不回退显示值——作者看到的就是「我改了、但没存上」。 */
export type SaveConfig = (mutate: (cfg: BookConfig) => void, opts?: SaveConfigOpts) => Promise<boolean>
export const SAVE_CONFIG_KEY: InjectionKey<SaveConfig> = Symbol('saveConfig')

/** 未保存项清单（label → 失败原因）。SettingsModal 登记，容器面渲染成常驻提示条。 */
export const SAVE_FAILURES_KEY: InjectionKey<import('vue').Ref<Map<string, string>>> = Symbol('saveFailures')
