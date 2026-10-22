import { isTauriRuntime } from '@/platform/environment'
import { retireSessionAuthority } from '@/platform/sessionAuthorization'

/**
 * 停止会话 = 中断 run + 收口该会话的全部权限。
 *
 * 权限收口走单条 `retire_session_authority_command`：held Automatic 模式与会话撤销
 * 代际在 Rust 侧同一次调用内落定。停止是**降级**动作，若拆成「撤销代际」与「降级
 * 模式」两段 IPC，后段失败就会把更高权限留在原处（fail-open）。
 *
 * 收口失败（IPC 断裂 / 进程异常）不会回滚已完成的 abort——但会经回调上报，
 * 由调用方写入 settingsError；权威判定在 Rust 侧，失败即无法签发新租约。
 */
export const stopSessionRuntime = async <T>(
  runtime: { id: string; abortAndWait: () => Promise<T> },
  onRetirementError: (error: unknown) => void,
): Promise<T> => {
  const settlement = runtime.abortAndWait()
  const retirement = isTauriRuntime()
    ? Promise.resolve().then(() => retireSessionAuthority(runtime.id)).catch(onRetirementError)
    : Promise.resolve()
  const [result] = await Promise.all([settlement, retirement])
  return result
}
