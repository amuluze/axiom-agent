/**
 * 传输层默认 HTTP 流绑定（纯模块，无 providerHost 依赖）。
 *
 * transport 的 `httpStream` 默认值在启动时由桌面宿主注入（`platform/providerHost.ts`
 * 的 `bindDefaultHttpStream`），避免 transport → providerHost → ... → transport 的
 * 模块初始化循环依赖。未绑定即抛「仅在桌面应用可用」（浏览器 demo 模式 fail-closed）。
 */
import type { ModelHttpStreamFactory } from './modelHttpContract'

let defaultHttpStream: ModelHttpStreamFactory | undefined

export const bindDefaultHttpStream = (stream: ModelHttpStreamFactory): void => {
  defaultHttpStream = stream
}

export const getDefaultHttpStream = (): ModelHttpStreamFactory => defaultHttpStream ?? (() => {
  throw new Error('真实模型连接仅在 Axiom 桌面应用中可用')
})
