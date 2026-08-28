// R73-76：playwright 对外类型面随版本漂移（@playwright/test 未稳定导出 Reporter 三件套），
// 这里用结构化最小类型自持——reporter 由 config 以路径字符串挂载，运行时只按形状调用。
interface ReporterLike {
  onTestEnd?(test: TestCaseLike, result: TestResultLike): void
  onError?(error: Error): void
}
interface TestCaseLike {
  title: string
  location: { file: string }
}
interface TestResultLike {
  status: string
}

/**
 * R73-76（批 F-9）：e2e 顺序契约「首因」标记 reporter。
 *
 * 28+ spec 共享 globalSetup 的单一 workDir、workers:1 按字典序串行——某 spec 内
 * 进程级崩溃（worker crash/OOM）后，后续 spec 常因「前序该落的状态没落」连坐红，
 * 红点遍布却无首因标记，排查只能从头顺。本 reporter 标记整轮第一个未通过用例：
 * 连坐红时「首因大概率在此（或其所在 spec 的前置链）」。只打印提示，不改写任何
 * 结果/退出码（retries: 0 契约不变，见 playwright.config.ts）。
 */
export default class FirstCauseReporter implements ReporterLike {
  private printed = false

  onTestEnd(test: TestCaseLike, result: TestResultLike): void {
    if (this.printed) return
    if (result.status === 'passed' || result.status === 'skipped') return
    this.printed = true
    console.error(
      `\n[e2e 首因标记 R73-76] 整轮首个未通过用例：${test.title}（${test.location.file}）\n` +
        '[e2e 首因标记] 本套 e2e 共享单一 workDir 顺序契约（workers:1）：若其后出现成片连坐红，\n' +
        '首因大概率在本用例/本 spec（或其前置 spec 崩溃未落盘）；排查请从这里开始。',
    )
  }

  onError(error: Error): void {
    if (this.printed) return
    this.printed = true
    console.error(`\n[e2e 首因标记 R73-76] runner 级错误（可能在用例之外）：${error.message}`)
  }
}
