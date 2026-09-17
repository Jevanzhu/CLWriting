/**
 * 0918独立重评修复批（E002）回归：driver 写手腿在途判定 isWriterRunning。
 *
 * 现状：cc isRunning 遍历全部 owner 槽位，chat 腿以 `chat:<book>` owner 全程在册至
 * finish 注销——对话期间 sync 快照 running 被置真且永不复位（chat_done/chat_error 走
 * chat 族不达 workbench.running）。修法：driver 接口新增 isWriterRunning（可选，两
 * 实现都提供），cc 实现 = 存在未 aborted 且 owner 不以 `chat:` 开头的槽位即 true；
 * 其余 owner（spawn/self-heal/review:<书>/task-gate 的 action:<书>/缺省 ''）照旧算
 * 写手腿。stream.ts:360 sync 快照换用该判定（/interrupt 的 isRunning 全停语义不动）。
 * mock 无 ctrl 登记（registerCtrl noop），恒 false 保持接口齐平。
 */
import { test, expect } from 'vitest'
import { ccDriver } from '../../src/driver/cc.js'
import { mockDriver } from '../../src/driver/mock.js'

test('E002: 仅 chat 腿 ctrl 在册 → isWriterRunning=false 且 isRunning=true（收窄口径的分界形态）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl, 'chat:测试书')
  expect(ccDriver.isRunning!(session)).toBe(true) // isRunning 语义不变（全槽位）
  expect(ccDriver.isWriterRunning!(session)).toBe(false)
  // 终态注销后两者归 false
  ccDriver.unregisterCtrl!(session, ctrl)
  expect(ccDriver.isRunning!(session)).toBe(false)
  expect(ccDriver.isWriterRunning!(session)).toBe(false)
  ccDriver.dispose(session)
})

test('E002: 仅写手腿 owner（spawn）→ 两者皆 true', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl, 'spawn')
  expect(ccDriver.isRunning!(session)).toBe(true)
  expect(ccDriver.isWriterRunning!(session)).toBe(true)
  ccDriver.unregisterCtrl!(session, ctrl)
  ccDriver.dispose(session)
})

test('E002: 混合（chat 腿 + 写手腿并存）→ isWriterRunning=true（只排除 chat 前缀，不互抹）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const chatCtrl = new AbortController()
  const spawnCtrl = new AbortController()
  ccDriver.registerCtrl!(session, chatCtrl, 'chat:测试书')
  ccDriver.registerCtrl!(session, spawnCtrl, 'self-heal')
  expect(ccDriver.isWriterRunning!(session)).toBe(true)
  expect(ccDriver.isRunning!(session)).toBe(true)
  // 写手腿收尾后仅剩 chat 腿 → isWriterRunning 归 false、isRunning 仍 true
  ccDriver.unregisterCtrl!(session, spawnCtrl)
  expect(ccDriver.isWriterRunning!(session)).toBe(false)
  expect(ccDriver.isRunning!(session)).toBe(true)
  ccDriver.unregisterCtrl!(session, chatCtrl)
  ccDriver.dispose(session)
})

test('E002: 非 chat 前缀 owner（review:<书>/task-gate action:<书>/缺省空串）照旧算写手腿', async () => {
  const session = await ccDriver.startSession('/tmp')
  const reviewCtrl = new AbortController()
  const gateCtrl = new AbortController()
  const defaultCtrl = new AbortController()
  ccDriver.registerCtrl!(session, reviewCtrl, 'review:测试书')
  expect(ccDriver.isWriterRunning!(session)).toBe(true)
  ccDriver.unregisterCtrl!(session, reviewCtrl)
  ccDriver.registerCtrl!(session, gateCtrl, 'outline:测试书')
  expect(ccDriver.isWriterRunning!(session)).toBe(true)
  ccDriver.unregisterCtrl!(session, gateCtrl)
  ccDriver.registerCtrl!(session, defaultCtrl) // owner 缺省 = '' 槽
  expect(ccDriver.isWriterRunning!(session)).toBe(true)
  ccDriver.unregisterCtrl!(session, defaultCtrl)
  ccDriver.dispose(session)
})

test('E002: aborted 的 ctrl 不算写手腿在途（与 isRunning 的 X-P2-11 口径同型）', async () => {
  const session = await ccDriver.startSession('/tmp')
  const ctrl = new AbortController()
  ccDriver.registerCtrl!(session, ctrl, 'spawn')
  expect(ccDriver.isWriterRunning!(session)).toBe(true)
  ctrl.abort()
  expect(ccDriver.isWriterRunning!(session)).toBe(false)
  ccDriver.unregisterCtrl!(session, ctrl)
  ccDriver.dispose(session)
})

test('E002: mock driver 接口齐平——isWriterRunning 恒 false（无 ctrl 登记）', async () => {
  expect(typeof mockDriver.isWriterRunning).toBe('function')
  const session = await mockDriver.startSession('/tmp')
  expect(mockDriver.isWriterRunning!(session)).toBe(false)
  mockDriver.dispose(session)
})
