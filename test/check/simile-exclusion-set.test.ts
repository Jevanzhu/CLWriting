/**
 * SIMILE_RE 排他词集：模板性收词（「群像」）不计入比喻密度（R33-29）。
 *
 * 档源：原 r33-check-fixes.test.ts 的 R33-29 组（同文件 R33-1 组并入
 * section-count-fence.test.ts、R33-5/R33-6 组并入 lead-updates-evidence-guards.test.ts、
 * R33-30 组并入 check-input-tolerance.test.ts、R33-32 组并入
 * quoted-span-dialogue-strip.test.ts）。
 */
import { test, expect } from 'vitest'
import { checkSimile } from '../../src/check/count.js'

test('R33-29: 「群像」不再计入比喻密度', () => {
  expect(checkSimile('这幅群像描写刻画了众生。', 1).items).toHaveLength(0)
})

/** 名词性「X像」全表——与 count.ts SIMILE_RE 前置排除字符类的登记词表同源。
 *  任一前置字漏出字符类，该词即被计入比喻密度（短篇 strict 下 simile-density 虚高升红，
 *  把无明喻的章打回重写、白烧真调用）。「录像」即此前漏网一例。 */
const NOUN_XIANG_WORDS = [
  '图像',
  '偶像',
  '摄像',
  '录像',
  '影像',
  '照像',
  '画像',
  '音像',
  '映像',
  '实像',
  '虚像',
  '镜像',
  '显像',
  '成像',
  '雕像',
  '塑像',
  '石像',
  '铜像',
  '铁像',
  '玉像',
  '蜡像',
  '金像',
  '肖像',
  '绣像',
  '头像',
  '佛像',
  '神像',
  '遗像',
  '铸像',
  '拟像',
  '造像',
  '圣像',
  '群像',
  '形象',
  '印像',
  '想像',
]

test('明喻排除字符类覆盖词表全量：名词性「X像」逐词不计入比喻密度', () => {
  for (const w of NOUN_XIANG_WORDS) {
    expect(checkSimile(`他盯着那个${w}看了很久。`, 1).items, `「${w}」不应计入`).toHaveLength(0)
  }
})
