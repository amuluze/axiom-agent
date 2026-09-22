import {
  defaultProviderProfile,
  PROVIDER_PROFILE_SCHEMA_VERSION,
  type ProviderProfile,
} from '@/agent/transport/provider'

/**
 * 测试用 generic-anthropic-compatible profile（内置 MiniMax 入口已移除）。
 *
 * 放在 agent 层而非组件层的设置测试夹具里：它是 Provider 契约的样例数据，
 * agent 层自身的测试（transport / runtime）也要用，从 components 反向取会形成层次倒置。
 * 直接构造已规范化形态（解析已下沉 Rust，测试不走异步解析）。
 */
export const TEST_ANTHROPIC_PROFILE: ProviderProfile = {
  ...defaultProviderProfile('generic-anthropic-compatible'),
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  profileId: 'test.anthropic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  modelId: 'claude-test',
  secretId: 'provider.generic-anthropic-compatible.api-key',
}
