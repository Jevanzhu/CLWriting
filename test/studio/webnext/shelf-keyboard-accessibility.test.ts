// @vitest-environment happy-dom
/**
 * R36-23（三十六轮）：书架主导航键盘不可达（R72-12 修复漏网，无替代键盘路径）。
 *
 * - ShelfModalHero（弹层 hero，原 `<section>` 仅 @click）：补 role="button" +
 *   tabindex="0" + Enter/Space 触发同一「打开」手势（对齐 R72-12 已修的 ShelfHeroCard）。
 * - BookCard（书卡 grid/list）：复核结论——本体已是原生 `<button>`（Tab 可达、
 *   Enter/Space 由浏览器原生激活 @click，focus trap 的 FOCUSABLE 选择器也收 button），
 *   R36-23 无需改结构；本文件以「渲染为 button + 点击 emit」锚定键盘语义契约，
 *   防将来被误改成 div/section 时无测试红线。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ShelfModalHero from '../../../src/studio/web-next/src/components/shelf/ShelfModalHero.vue'
import BookCard from '../../../src/studio/web-next/src/components/ui/BookCard.vue'
import type { BookEntry } from '../../../src/studio/web-next/src/api/shelf'

const BOOK: BookEntry = {
  name: '我的书',
  title: '我的书',
  kind: 'long',
  chapters: 12,
  words: 45600,
  lastEdited: '2026-09-01T00:00:00Z',
  latestChapter: '第12章 结局',
  targetWords: 100000,
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R36-23：ShelfModalHero 键盘可达（role/tabindex + Enter/Space）', () => {
  it('grid hero：role=button + tabindex=0；Enter/Space 触发 open（与点击同一手势）', async () => {
    const wrapper = mount(ShelfModalHero, { props: { book: BOOK, viewMode: 'grid' } })
    const hero = wrapper.find('.hero-card')
    expect(hero.attributes('role')).toBe('button')
    expect(hero.attributes('tabindex')).toBe('0')

    await hero.trigger('click')
    expect(wrapper.emitted('open')?.at(-1)).toEqual(['我的书'])

    await hero.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open')?.at(-1)).toEqual(['我的书'])

    await hero.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('open')?.at(-1)).toEqual(['我的书'])
    wrapper.unmount()
  })

  it('list hero：同样 role/tabindex + Enter 触发 open', async () => {
    const wrapper = mount(ShelfModalHero, { props: { book: BOOK, viewMode: 'list' } })
    const hero = wrapper.find('.hero-list')
    expect(hero.attributes('role')).toBe('button')
    expect(hero.attributes('tabindex')).toBe('0')

    await hero.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open')).toEqual([['我的书']])
    wrapper.unmount()
  })
})

describe('R36-23：BookCard 键盘语义回归锚（本体为原生 button，无需改结构）', () => {
  it('grid 卡渲染为 <button>（Tab 可达 + 原生 Enter/Space 激活点击），click emit 姓名', async () => {
    const wrapper = mount(BookCard, { props: { book: BOOK, variant: 'grid' } })
    const card = wrapper.find('.book-card')
    expect(card.element.tagName).toBe('BUTTON')
    expect(card.attributes('disabled')).toBeUndefined()

    await card.trigger('click')
    expect(wrapper.emitted('click')).toEqual([['我的书']])
    wrapper.unmount()
  })

  it('list 行渲染为 <button>，点击 emit 姓名', async () => {
    const wrapper = mount(BookCard, { props: { book: BOOK, variant: 'list' } })
    const row = wrapper.find('.list-row')
    expect(row.element.tagName).toBe('BUTTON')

    await row.trigger('click')
    expect(wrapper.emitted('click')).toEqual([['我的书']])
    wrapper.unmount()
  })

  it('批量模式仍为可聚焦 button（click 语义不变）', async () => {
    const wrapper = mount(BookCard, { props: { book: BOOK, variant: 'grid', batchMode: true, selected: true } })
    const card = wrapper.find('.book-card')
    expect(card.element.tagName).toBe('BUTTON')

    await card.trigger('click')
    expect(wrapper.emitted('click')).toEqual([['我的书']])
    wrapper.unmount()
  })
})