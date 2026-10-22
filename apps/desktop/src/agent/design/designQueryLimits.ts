/**
 * design_query 的轻量契约面：字节预算常量与 `.ax` 文件名判定。
 *
 * 工具元数据（inputSchema 描述、validate、审批绑定输入）与执行面分开：这里只放
 * 校验用到的标量与纯判定，模式执行器（render/scan/compare/reconcile…）留在
 * design_query 各执行器，由 `execute` 按需动态导入——工具在默认会话里始终注册，
 * 静态引入会把整个设计查询与扫描实现带进启动主包。
 */
export const DEFAULT_IMAGE_MAX_BYTES = 512 * 1024
export const MAX_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** scan 模式的单张缩略图预算（32KiB ≈ 几千 token——逐页扫描必须控制上下文体积）。 */
export const DEFAULT_SCAN_THUMBNAIL_BYTES = 32 * 1024
export const isAxFile = (path: string): boolean => /\.ax$/i.test(path)
