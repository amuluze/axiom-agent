import type { ModelStreamEvent, ModelTransport } from '@/agent/core/types'

export class ProviderSetupRequiredTransport implements ModelTransport {
  constructor(private readonly providerLabel: string) {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error(`${this.providerLabel} 需要先完成 API Key 配置`)
  }
}
