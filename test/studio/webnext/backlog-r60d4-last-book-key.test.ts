/**
 * R60-D-4（六十轮）回归——最近打开书键 'clw-last-book' 收敛 shared/storage-keys 单源。
 *
 * 缺陷：App.vue（启动恢复读取）、Shelf.vue / ShelfModal.vue（选书记入）、ShelfModal.vue
 *（删当前书清扫）四处各自硬编码同串——R28-3 点名、R30-26 已为 onboard-premise 键修过的
 *「写入/清除键名断裂」同族：一侧改键名另一侧静默失配（启动落进已删书 / 删书清不掉）。
 * 修复：storage-keys.ts 增设 LAST_BOOK_KEY 常量，四方 import 单源；落盘键值不变。
 * 形态参考：r30-storage-keys.test.ts 静态扫描段 + r51-h4-fp-prefix-single-source.test.ts。
 */
import { describe, it, expect } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { LAST_BOOK_KEY } from '../../../src/studio/web-next/src/shared/storage-keys'

const SRC_ROOT = path.resolve(__dirname, '../../../src/studio/web-next/src')

// 三消费方（R60-D-4 评审快照定位的直写/直读点，grep 实际命中为准）
const CONSUMERS: ReadonlyArray<{ label: string; rel: string }> = [
  { label: 'App.vue：启动恢复读取', rel: 'App.vue' },
  { label: 'Shelf.vue：全屏页选书记入', rel: 'pages/Shelf.vue' },
  { label: 'ShelfModal.vue：浮层选书记入 + 删当前书清扫', rel: 'components/ui/ShelfModal.vue' },
]

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else if (/\.(ts|vue)$/.test(ent.name)) out.push(p)
  }
  return out
}

describe('R60-D-4: LAST_BOOK_KEY 单源契约', () => {
  it('常量值锁——恰为历史落盘键 clw-last-book（改值即丢全部用户「上次打开的书」恢复态，禁止静默变更）', () => {
    expect(LAST_BOOK_KEY).toBe('clw-last-book')
  })

  it('src/** 内除 storage-keys.ts 外无 clw-last-book 字面量（防双源再分叉）', async () => {
    const files = await walk(SRC_ROOT)
    expect(files.length).toBeGreaterThan(10) // 扫描路径有效性自证
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith(`${path.sep}shared${path.sep}storage-keys.ts`)) continue // 单一事实源本体
      const text = await fsp.readFile(f, 'utf8')
      if (text.includes('clw-last-book')) offenders.push(path.relative(SRC_ROOT, f))
    }
    expect(offenders).toEqual([])
  })

  it('三消费方均 import LAST_BOOK_KEY 且至少一处实际消费（读/写/清扫四方同源）', async () => {
    for (const c of CONSUMERS) {
      const text = await fsp.readFile(path.join(SRC_ROOT, c.rel), 'utf8')
      expect(text, c.label).toContain(`import { LAST_BOOK_KEY } from '`)
      // import 行自身占 1 次，实际消费须再至少 1 次（getItem/setItem/removeItem）
      expect((text.match(/\bLAST_BOOK_KEY\b/g) ?? []).length, c.label).toBeGreaterThanOrEqual(2)
    }
  })
})
