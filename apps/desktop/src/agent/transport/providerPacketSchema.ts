/**
 * 零依赖的 provider 流式包级 schema 校验。
 *
 * 目标：当 Anthropic / OpenAI Responses 等协议变更流式响应结构时，在解析点抛出带字段
 * 路径的明确错误（由 transport 的 try/catch 转换为可见的 `{type:'error'}` 事件），而
 * 不是静默跳过整包，或把缺失字段默认替换成错误值——后者最典型的是 OpenAI Responses
 * 缺 `output_index` 时默认 0，会把多个 output item 折叠进同一 slot 污染状态。
 *
 * 原则：
 * - 只声明「分支消费且协议必须存在」的字段；未知字段与未知事件类型保持宽容（前向兼容，
 *   厂商会新增事件/字段）。
 * - `required: true` 缺失、为 null 或类型不符 → 抛 `ProviderPacketError`（fail-closed）。
 * - `required: false` 的字段存在才递归校验，缺失放行；JSON `null` 视同缺失放行——兼容
 *   协议普遍以 null 表达可选字段缺席（如 chat.completion.chunk 的 `delta.tool_calls: null`，
 *   消费侧的 isRecord/Array.isArray 守卫对 null 与 undefined 走同一路径）。嵌套结构
 *   （object/array）按需声明。
 *
 * 不引入 zod 等运行时依赖：本项目对依赖面严格控制（连 YAML frontmatter 都自研行级
 * parser），此处用约 80 行的递归校验器即可覆盖「字段形状漂移」这一风险面。
 */

export class ProviderPacketError extends Error {
  readonly providerId: string
  readonly packetType: string
  readonly fieldPath: string
  readonly expected: string
  readonly actual: unknown

  constructor(
    providerId: string,
    packetType: string,
    fieldPath: string,
    expected: string,
    actual: unknown,
  ) {
    super(
      `Provider ${providerId} 流式包 ${packetType} 字段 ${fieldPath} 结构不符：`
      + `期望 ${expected}，实际 ${describeValue(actual)}`,
    )
    this.name = 'ProviderPacketError'
    this.providerId = providerId
    this.packetType = packetType
    this.fieldPath = fieldPath
    this.expected = expected
    this.actual = actual
  }
}

const describeValue = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return 'object'
  return JSON.stringify(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type FieldSpec =
  | { kind: 'string'; required?: boolean }
  | { kind: 'number'; required?: boolean }
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'object'; fields?: Record<string, FieldSpec>; required?: boolean }
  | { kind: 'array'; items?: FieldSpec; required?: boolean }
  | { kind: 'any'; required?: boolean }

/** 包级 schema：以字段名 → 字段规格映射。 */
export type PacketSchema = Record<string, FieldSpec>

/** 字段规格工厂（arrow-function 风格，保持调用点声明简洁）。 */
export const str = (required = false): FieldSpec => ({ kind: 'string', required })
export const num = (required = false): FieldSpec => ({ kind: 'number', required })
export const bool = (required = false): FieldSpec => ({ kind: 'boolean', required })
export const obj = (
  fields: Record<string, FieldSpec> = {},
  required = false,
): FieldSpec => ({ kind: 'object', fields, required })
export const arr = (items?: FieldSpec, required = false): FieldSpec => ({ kind: 'array', items, required })
export const any = (required = false): FieldSpec => ({ kind: 'any', required })

const matchPrimitive = (value: unknown, kind: FieldSpec['kind']): boolean => {
  switch (kind) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'any': return true
  }
}

const validateSpec = (
  providerId: string,
  packetType: string,
  path: string,
  value: unknown,
  spec: FieldSpec,
): void => {
  if (value == null) {
    if (spec.required) {
      throw new ProviderPacketError(providerId, packetType, path, spec.kind, value)
    }
    return
  }
  if (spec.kind === 'object') {
    if (!isRecord(value)) {
      throw new ProviderPacketError(providerId, packetType, path, 'object', value)
    }
    for (const [name, child] of Object.entries(spec.fields ?? {})) {
      validateSpec(providerId, packetType, `${path}.${name}`, value[name], child)
    }
    return
  }
  if (spec.kind === 'array') {
    if (!Array.isArray(value)) {
      throw new ProviderPacketError(providerId, packetType, path, 'array', value)
    }
    if (spec.items) {
      for (const [index, element] of value.entries()) {
        validateSpec(providerId, packetType, `${path}[${index}]`, element, spec.items)
      }
    }
    return
  }
  if (!matchPrimitive(value, spec.kind)) {
    throw new ProviderPacketError(providerId, packetType, path, spec.kind, value)
  }
}

/**
 * 校验单个流式包。schema 中声明的字段逐一验证；根不是对象、required 字段缺失或类型
 * 不符时抛 `ProviderPacketError`。返回 void（校验通过即继续）。
 */
export const validateProviderPacket = (
  providerId: string,
  packetType: string,
  packet: unknown,
  schema: PacketSchema,
): void => {
  if (!isRecord(packet)) {
    throw new ProviderPacketError(providerId, packetType, '<root>', 'object', packet)
  }
  for (const [name, spec] of Object.entries(schema)) {
    validateSpec(providerId, packetType, name, packet[name], spec)
  }
}

/**
 * Anthropic Messages 流式事件包级 schema。
 * 只声明「分支消费且协议保证存在」的关键字段；message/usage 等次要字段由消费分支自身的
 * 宽容处理兜底，不在此收紧。
 */
export const ANTHROPIC_PACKET_SCHEMAS: Readonly<Record<string, PacketSchema>> = {
  message_start: { message: obj({}, true) },
  content_block_start: {
    index: num(true),
    content_block: obj({}, true),
  },
  content_block_delta: {
    index: num(true),
    delta: obj({}, true),
  },
  content_block_stop: { index: num(true) },
  message_delta: { delta: obj({}, true) },
  message_stop: {},
  error: { error: obj({}, false) },
}

/**
 * OpenAI Responses 流式事件包级 schema。
 * `output_index` 是多数事件的定位键：缺失会被既有逻辑默认成 0，多个 item 折叠进同一
 * slot 静默污染状态，因此对消费 `output_index` 的事件一律标为 required。
 */
export const OPENAI_RESPONSES_PACKET_SCHEMAS: Readonly<Record<string, PacketSchema>> = {
  'response.output_item.added': {
    output_index: num(true),
    item: obj({}, true),
  },
  'response.output_text.delta': { output_index: num(true), delta: str(true) },
  'response.refusal.delta': { output_index: num(true), delta: str(true) },
  'response.reasoning_summary_text.delta': { output_index: num(true), delta: str(true) },
  'response.reasoning_summary_part.done': { output_index: num(true) },
  'response.output_text.done': { output_index: num(true) },
  'response.refusal.done': { output_index: num(true) },
  'response.reasoning_summary_text.done': { output_index: num(true) },
  'response.function_call_arguments.delta': { output_index: num(true), delta: str(true) },
  'response.function_call_arguments.done': { output_index: num(true), arguments: str(true) },
  'response.output_item.done': { output_index: num(true), item: obj({}, true) },
  'response.completed': { response: obj({}, false) },
  'response.incomplete': { response: obj({}, false) },
}

/**
 * OpenAI-compatible（chat completions）包级 schema——单一 schema 校验所有包（该协议
 * 无 `type` 字段，按 `object: chat.completion.chunk` 分发）。compatible 家族宽容性由
 * 设计保证：`choices` / `delta` 均 required:false，缺失不抛；唯一收紧点是
 * `delta.tool_calls[].index`——工具调用是执行面，index 缺失时当前实现会静默丢弃整条
 * 工具调用（工具永不执行、无对应 tool_result），属必须显式暴露的漂移。
 */
export const OPENAI_COMPATIBLE_PACKET_SCHEMA: PacketSchema = {
  choices: arr(obj({
    delta: obj({
      tool_calls: arr(obj({ index: num(true) }), false),
    }, false),
  }, false), false),
}

/** 供测试与诊断使用的类型投影（避免误把校验模块当值导入）。 */
export const isProviderPacketError = (error: unknown): error is ProviderPacketError =>
  error instanceof ProviderPacketError
