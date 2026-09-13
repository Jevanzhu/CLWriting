/**
 * 短篇集默认画像与机检阈值——唯一正本（R0912-ds41 P3-6，重评-deepseek-v4.1-flash 修复批）。
 *
 * 此前 metrics/short-index.ts（DEFAULT_SHORT_CONFIG）与 install/data.ts
 * （DEFAULT_SHORT_CHECKS）各持一份 12 行逐字相同的默认表，面临单侧改动漂移；
 * 收敛到本模块后两消费方各自展开使用，键序与行为不变（防漂移锚测试见
 * test/metrics/r0912-ds41-short-defaults.test.ts）。
 *
 * 刻意零内部依赖（对齐 web-next shared/chat-history.ts 的 shared 惯例）：
 * 形状用结构化本地类型（与 format/types.ts BookConfig['short'] 字段同名同型、
 * 可赋值兼容），不 import 本库任何模块——metrics/install 等任意层引用本模块
 * 均无依赖倒挂与循环风险。
 */

/** 短篇集默认表形状（结构兼容 BookConfig['short'] 的必填子集） */
interface ShortDefaults {
  /** 短篇平台/栏目画像 */
  profile: string
  /** 画像目标情绪池 */
  target_emotions: string[]
  /** 画像目标反转类型池 */
  target_reversal_types: string[]
  /** 画像目标结尾味道池 */
  target_ending_flavors: string[]
  /** 短篇总字数下限 */
  word_min: number
  /** 短篇总字数上限 */
  word_max: number
  /** 单个身体部位词允许出现次数 */
  body_part_threshold: number
  /** 「像」字比喻密度阈值 */
  simile_threshold: number
  /** 期望正文结构节数 */
  section_count: number
  /** 开头零环境检查的前 N 字 */
  opening_env_chars: number
}

/** 短篇集默认画像与机检阈值（唯一正本；消费方只展开、不改写） */
export const SHORT_DEFAULTS: ShortDefaults = {
  profile: '通用短篇',
  target_emotions: ['惊悚', '爽感', '酸涩', '温暖'],
  target_reversal_types: ['身份反转', '亲密关系反转', '时间/记忆反转', '其他反转'],
  target_ending_flavors: ['后怕', '释然', '遗憾', '余韵'],
  word_min: 8000,
  word_max: 20000,
  body_part_threshold: 5,
  simile_threshold: 10,
  section_count: 5,
  opening_env_chars: 300,
}
