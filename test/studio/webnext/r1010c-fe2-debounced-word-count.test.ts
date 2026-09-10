/**
 * R1010c-FE2-P3-6（2026-09-10 全量独立复审修复批）：useDebouncedWordCount /
 * useDebouncedFmFields 直测（此前 75 行、7 组件消费、零直测）。
 *
 * 语义锚（头注 + R43-17 纪律）：① 初值当拍（首屏/挂载即时，无防抖窗口）；② 同 key
 * 内容变化 150ms 防抖、窗口内多次变化只取末值；③ key 变化（切文档）即刻重算并作废
 * 在途定时器（防抖窗不滞留旧文档值）；④ flush() 同步取当拍（关键时点先 flush 防低估）；
 * ⑤ 卸载清定时器（无孤儿回调）；⑥ 缺省剥 front matter、stripFm=false 对裸生成文本；
 * ⑦ undefined 内容 → 0 / 空表。
 * 假时钟对齐 r47-debounced-source 先例；字数期望值用同源 countWords 计算（不复制口径）。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, h, render, nextTick } from 'vue'
import {
  useDebouncedWordCount,
  useDebouncedFmFields,
} from '../../../src/studio/web-next/src/composables/useDebouncedWordCount'
import { countWords } from '../../../src/studio/web-next/src/shared/words'

/** 组件作用域挂载（composable 内 onUnmounted 需组件实例）；返回卸载函数（r47 同款）。 */
function mountWith(setup: () => void): () => void {
  const el = document.createElement('div')
  const Comp = { setup } as unknown as Parameters<typeof h>[0]
  render(h(Comp), el)
  return () => render(null, el)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R1010c-FE2-P3-6: useDebouncedWordCount', () => {
  it('初值当拍（挂载即正确，无防抖窗口）', () => {
    const src = ref('正文一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    expect(r!.count.value).toBe(countWords('正文一二三'))
  })

  it('同 key 内容变化 150ms 防抖——窗口内不更新、多次变化只取末值', async () => {
    const src = ref('一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    src.value = '一二三四'
    await nextTick()
    expect(r!.count.value).toBe(3) // 防抖窗口内不更新
    src.value = '一二三四五六七'
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(r!.count.value).toBe(3) // 差 1ms 仍不更新
    vi.advanceTimersByTime(1)
    expect(r!.count.value).toBe(7) // 只取末值
  })

  it('key 变化（切文档）即刻取新文档值——在途防抖定时器作废，不回灌旧文档值', async () => {
    const src = ref('甲文档')
    const key = ref('doc-a')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value, () => key.value)
    })
    src.value = '甲文档改'
    await nextTick()
    vi.advanceTimersByTime(100) // 旧文档的防抖窗口走了一半
    // 未到 150ms 即切文档：key 变化当拍取新文档内容（R43-17：窗口不滞留旧文档值）
    key.value = 'doc-b'
    src.value = '乙文档内容长一些'
    await nextTick()
    expect(r!.count.value).toBe(countWords('乙文档内容长一些'))
    vi.advanceTimersByTime(300) // 旧定时器（携带 甲文档改）已被取消——过期触发也不回灌
    expect(r!.count.value).toBe(countWords('乙文档内容长一些'))
  })

  it('flush() 同步取当拍（关键时点防 150ms 窗内低估）', async () => {
    const src = ref('一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    src.value = '一二三四五六'
    await nextTick()
    expect(r!.count.value).toBe(3) // 窗口内仍旧值
    r!.flush()
    expect(r!.count.value).toBe(6) // flush 即刻取当拍
  })

  it('卸载清定时器——防抖回调不再更新输出', async () => {
    const src = ref('一二三')
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    const unmount = mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    src.value = '一二三四五'
    await nextTick()
    unmount()
    vi.advanceTimersByTime(500)
    expect(r!.count.value).toBe(3) // 卸载后在途定时器已清，不更新
  })

  it('undefined 内容 → 0（初始与防抖后一致）', async () => {
    const src = ref<string | undefined>(undefined)
    let r: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      r = useDebouncedWordCount(() => src.value)
    })
    expect(r!.count.value).toBe(0)
    src.value = '一二'
    await nextTick()
    vi.advanceTimersByTime(150)
    expect(r!.count.value).toBe(2)
  })

  it('缺省剥 front matter；stripFm=false 对裸生成文本不剥', () => {
    const withFm = '---\ntitle: 测试\n---\n\n正文一二三'
    const src = ref(withFm)
    let stripped: ReturnType<typeof useDebouncedWordCount> | undefined
    let raw: ReturnType<typeof useDebouncedWordCount> | undefined
    mountWith(() => {
      stripped = useDebouncedWordCount(() => src.value)
      raw = useDebouncedWordCount(() => src.value, () => undefined, { stripFm: false })
    })
    // 期望值用同源 countWords 计算（不复制剥 fm 口径）
    expect(stripped!.count.value).toBe(countWords('正文一二三'))
    expect(raw!.count.value).toBe(countWords(withFm))
    expect(raw!.count.value).toBeGreaterThan(stripped!.count.value) // fm 头计入与不计入可区分
  })
})

describe('R1010c-FE2-P3-6: useDebouncedFmFields', () => {
  it('初值当拍解析 fm 字段表', () => {
    const src = ref('---\ntitle: 上卷\npov: 甲人\n---\n\n正文')
    let r: ReturnType<typeof useDebouncedFmFields> | undefined
    mountWith(() => {
      r = useDebouncedFmFields(() => src.value)
    })
    expect(r!.fields.value).toEqual({ title: '上卷', pov: '甲人' })
  })

  it('undefined 内容 → 空表', () => {
    const src = ref<string | undefined>(undefined)
    let r: ReturnType<typeof useDebouncedFmFields> | undefined
    mountWith(() => {
      r = useDebouncedFmFields(() => src.value)
    })
    expect(r!.fields.value).toEqual({})
  })

  it('同 key 内容变化走 150ms 防抖；key 变化（切文档）即刻取新表', async () => {
    const src = ref('---\ntitle: 上卷\n---\n\n正文')
    const key = ref('doc-a')
    let r: ReturnType<typeof useDebouncedFmFields> | undefined
    mountWith(() => {
      r = useDebouncedFmFields(() => src.value, () => key.value)
    })
    src.value = '---\ntitle: 上卷改\n---\n\n正文'
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(r!.fields.value).toEqual({ title: '上卷' }) // 防抖窗口内不更新
    vi.advanceTimersByTime(1)
    expect(r!.fields.value).toEqual({ title: '上卷改' })
    // 切文档：即刻取新文档的表，不滞留旧文档值
    key.value = 'doc-b'
    src.value = '---\nview: 乙视角\n---\n\n正文B'
    await nextTick()
    expect(r!.fields.value).toEqual({ view: '乙视角' })
  })
})
