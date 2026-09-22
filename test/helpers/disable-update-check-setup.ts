/**
 * 阶段 53 S5：单测进程的「不打网」闸——关掉起服后延迟触发的更新检查。
 *
 * 背景：`startServer` 起服后延迟 5s fire-and-forget 跑一次更新检查（出站访问
 * api.github.com）。单测里凡起真 server 的用例（test/helpers/safe-port 族）都会带上
 * 这枚定时器——用例跑得快时它在 close 时被清掉，但长跑用例（含多 server/重负载）可
 * 越 5s 窗口真打网：CI 无外网 → 失败静默（不影响断言），有外网 → 测试进程做真实出站，
 * 两种都违背「测试不打网」的硬要求。
 *
 * 口径：开关在 update/check 内短路（`runUpdateCheckOnce` 首行）——置 1 即完全不检查、
 * 不置结果。需要**真跑**检查的用例自行临时清掉该变量（见 test/studio/app-info.test.ts
 * 与 test/update/check.test.ts 的 beforeEach/局部删除）。
 *
 * e2e 侧同口径，落点在 playwright.config.ts（worker 进程继承主进程 env，global-setup
 * 与各 spec 自起 server 一并覆盖）。
 */
process.env['CLW_DISABLE_UPDATE_CHECK'] = '1'
