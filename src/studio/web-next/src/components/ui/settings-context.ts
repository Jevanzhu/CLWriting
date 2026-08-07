import type { InjectionKey } from 'vue'
import type { BookConfig } from '../../api/books'

/** saveConfig 注入键：SettingsModal provide，Book/Ai/History 子组件 inject。
 *  串行化读写 book.yaml（防快速连续修改竞态）。 */
export type SaveConfig = (mutate: (cfg: BookConfig) => void, silent?: boolean) => Promise<void>
export const SAVE_CONFIG_KEY: InjectionKey<SaveConfig> = Symbol('saveConfig')
