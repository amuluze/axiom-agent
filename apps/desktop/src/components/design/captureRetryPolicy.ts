/**
 * 原生截图的失败分类与重试节奏（纯函数）。
 *
 * 单次失败的代价由 Rust 侧的有界等待决定（14s 收结果 + 15s 外层兜底），所以重试
 * 的关键不在「等多久」而在**该不该等**：对永久性失败再重试一次，等于白等一整轮
 * 超时——用户看到的是导出/扫描卡住十几秒然后报同一个错。
 *
 * 另一条容易被忽略的约束是并发：画布扫描一次并行 4 张截图（`runPool`）。主线程
 * 拥塞时 4 张会在**同一时刻**先后超时，若都用固定间隔重试，4 个重试又会挤在同
 * 一瞬间再次压上主线程——固定节奏会把瞬时拥塞放大成持续拥塞。故重试间隔带抖动。
 *
 * 错误文本以 Rust `webview_capture.rs` 的返回为准（该侧文案变更时此处需同步）。
 */

/** 失败性质：瞬时（值得重试）/ 永久（重试只是白等）。 */
export type CaptureFailureKind = 'transient' | 'permanent'

const PERMANENT_PATTERNS: readonly RegExp[] = [
  // 矩形非法：调用方给错了，重试多少次都是同一个错（且 Rust 在截图前就拒绝）。
  /截图矩形无效/,
  // 平台不支持：能力探测阶段就该拦住，走到截图才失败说明探测与实际不一致，重试无意义。
  /不支持|unsupported|not supported/i,
]

/**
 * 按错误文本判定失败性质。**未知文案按瞬时处理**——保持既有行为（未知失败原本
 * 就会重试一次），且截图失败的多数成因确实是瞬时类；永久性只有确定识别得出的
 * 两种（矩形非法、平台不支持），宁可漏判也不要把瞬时拥塞当永久失败丢掉恢复机会。
 */
export const classifyCaptureFailure = (message: string): CaptureFailureKind =>
  PERMANENT_PATTERNS.some((pattern) => pattern.test(message)) ? 'permanent' : 'transient'

/** 重试间隔基准（毫秒）。与 Rust 侧 15s 超时相比量级很小——等待的主体是对端。 */
export const CAPTURE_RETRY_BASE_DELAY_MS = 250

/**
 * 第 n 次重试（n 从 1 起）前等待的毫秒数：基准 × 2ⁿ⁻¹，再乘抖动系数。
 * 抖动取 [0.5, 1.5) 的确定性序列（由 attempt 推出，不依赖随机数），使并行重试
 * 彼此错开，同时让测试可断言。
 */
export const captureRetryDelayMs = (attempt: number): number => {
  const step = Math.max(1, Math.floor(attempt))
  const base = CAPTURE_RETRY_BASE_DELAY_MS * 2 ** (step - 1)
  // 黄金比例散列：同一步的不同 attempt 落到不同相位。
  const phase = ((step * 0.6180339887498949) % 1 + 1) % 1
  return Math.round(base * (0.5 + phase))
}