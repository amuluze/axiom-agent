import { PROVIDER_CONSTANTS, type ProviderProfileDraft } from './providerProfile'

export type ProviderNumericField = 'timeoutMs' | 'maxOutputTokens' | 'contextWindow'

/** 三态声明的合法取值域（Domain 不变量 3）：与 Rust 侧白名单逐字对偶。 */
const IMAGE_INPUT_DECLARATIONS = ['catalog', 'text', 'image'] as const

export interface ProviderNumericViolation {
  field: ProviderNumericField
  /** 越界/非有限数值；NaN 表示输入框为空或非数字。 */
  value: number
  min: number
  max: number
}

/**
 * 保存 Provider 前的数值字段校验：界值来自与 Rust 同源的生成表
 * （`PROVIDER_CONSTANTS` ↔ `generated_provider_table.rs`，同一 generator 产出；
 *  经 provider barrel 转出，避免绕过 Provider Runtime 边界直连生成数据）。
 *
 * 为什么必须显式报错：Rust 侧 `provider_profiles.rs::bounded_integer` 对越界值**静默 clamp**，
 * 对非 u64（NaN 经 JSON 序列化成 null）回落到默认值；而 UI 只把 min/max 写成 HTML 属性，
 * `<input type="number">` 不在 `<form>` 内、点「保存配置」不触发原生约束校验——于是把
 * 「最大输出 token」填成 200000 会看到「配置已保存」，实际生效的却是被裁剪后的 64000，
 * 全程没有任何报错（用户以为改生效了）。此处在保存入口先拒绝，让失败可见且零写入。
 */
export const validateProviderNumericDraft = (
  draft: Pick<ProviderProfileDraft, ProviderNumericField>,
): ProviderNumericViolation | undefined => {
  const checks: Array<{ field: ProviderNumericField; min: number; max: number }> = [
    { field: 'timeoutMs', min: PROVIDER_CONSTANTS.timeoutMinMs, max: PROVIDER_CONSTANTS.timeoutMaxMs },
    { field: 'maxOutputTokens', min: PROVIDER_CONSTANTS.maxOutputMin, max: PROVIDER_CONSTANTS.maxOutputMax },
    { field: 'contextWindow', min: PROVIDER_CONSTANTS.contextMin, max: PROVIDER_CONSTANTS.contextMax },
  ]
  for (const { field, min, max } of checks) {
    const value = draft[field]
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) continue
    return {
      field,
      value: typeof value === 'number' ? value : Number.NaN,
      min,
      max,
    }
  }
  return undefined
}

/**
 * 保存 Provider 前的图片输入声明校验：取值必须落在三态内，缺省视为 `catalog`。
 *
 * 与数值字段同一保存入口自检：归一化链（TS 参考实现 / Rust 权威）对非法声明
 * fail-closed 报错，但那条路径在浏览器 demo 下不经过 Rust；自检放在写入口可保证
 * 「非法值绝不落库」在任何宿主下都成立，且不静默归一为某一档（静默归一会让
 * 「声明支持图片」被读成仅文本，能力结论随之错误）。
 */
export const isValidProviderImageInputDraft = (
  draft: Pick<ProviderProfileDraft, 'imageInput'>,
): boolean => draft.imageInput === undefined
  || IMAGE_INPUT_DECLARATIONS.includes(draft.imageInput)
