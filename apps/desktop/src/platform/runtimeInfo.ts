import { commands, type RuntimeInfo } from './bindings'
import { isTauriRuntime } from './environment'

export type { RuntimeInfo } from './bindings'

export const getRuntimeInfo = async (): Promise<RuntimeInfo> => {
  if (isTauriRuntime()) return commands.getRuntimeInfo()

  return {
    appName: 'Axiom',
    appVersion: 'browser-dev',
    operatingSystem: navigator.platform || 'browser',
    architecture: 'webview',
  }
}
