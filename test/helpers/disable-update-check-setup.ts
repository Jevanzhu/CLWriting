/**
 * 阶段 53 S5：单测进程的「不打网」闸——关掉更新检查的出站。
 *
 * 背景：更新检查启动后延迟一次出站访问 api.github.com。检查本体现归**主进程**
 * （`update-controller.createUpdateCheckHost`，net.fetch 受系统代理；原在子进程，已迁），
 * 但单测里凡装 main.js 的用例（test/desktop/main-*.test.ts）仍会经 bootstrap 排上这枚定时器，
 * 长跑用例可越 5s 窗口真打网：CI 无外网 → 失败静默（不影响断言），有外网 → 测试进程做真实
 * 出站，两种都违背「测试不打网」的硬要求。
 *
 * 口径：开关在 update/check 内短路（`runUpdateCheckOnce` 首行）——置 1 即完全不检查、
 * 不置结果。需要**真跑**检查的用例自行临时清掉该变量（见 test/studio/server/app-info.test.ts
 * 与 test/update/check.test.ts 的 beforeEach/局部删除）。
 *
 * e2e 侧同口径，落点在 playwright.config.ts（worker 进程继承主进程 env，global-setup
 * 与各 spec 自起 server 一并覆盖）。
 */
process.env['CLW_DISABLE_UPDATE_CHECK'] = '1'
