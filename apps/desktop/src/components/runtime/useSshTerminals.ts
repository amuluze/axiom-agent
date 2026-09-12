import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  MONO_FONT_STACKS,
  scaledTerminalFontSize,
  type MonoFontFamily,
  useUiStore,
} from '@/stores/uiStore'
import { onSshSessionEvent } from '@/platform/sshSession'
import { useSshStore } from '@/stores/sshStore'
import { decodeBase64ToBytes } from '@/platform/base64'
import { setTerminalFocus, TERMINAL_THEME } from '@/platform/terminal'

/**
 * SSH 终端实例托管（每主机一个独立 xterm 实例 + 隐藏容器切换保活）。
 *
 * 自 SshTerminalPanel 抽出，集中持有 `Map<hostId, SshTermInstance>`：实例创建 /
 * 销毁、host 列表 reconcile、字号热更新、激活 fit+focus、SSH 输出事件分发都
 * 依赖同一张 Map，收进一个 hook 最内聚。组件仅剩 hostbar/footer 渲染与连接
 * 逻辑。
 *
 * - 事件单订阅：只注册一次 `onSshSessionEvent`，按 `event.hostId` 路由到对应
 *   实例，避免每主机重复 subscribe。decoder **每实例独立**——修正单 decoder
 *   在跨主机切换时拼接多字节序列的瑕疵。
 * - 每实例 hostId 固化在 `onData`/`onResize` 闭包里，不再依赖组件层的
 *   activeHostRef 过滤，切换主机不丢历史（只切显示，不 reset）。
 */

export interface SshTermInstance {
  term: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
  resizeObserver: ResizeObserver
  disposables: Array<{ dispose: () => void }>
  /** 每实例独立解码器（stream 模式跨事件复用，避免分块切开多字节）。 */
  decoder: TextDecoder
}

interface UseSshTerminalsOptions {
  hosts: Array<{ id: string }>
  activeHostId: string | null
  fontSizePx: number
  monoFontFamily: MonoFontFamily
}

export interface UseSshTerminalsApi {
  /** 每主机 slot 容器的稳定 ref 回调（缓存 per-id，避免 React 反复 mount/unmount）。 */
  getSlotRef: (hostId: string) => (node: HTMLDivElement | null) => void
  getTerminal: (hostId: string) => Terminal | undefined
  fitFocus: (hostId: string | null) => void
}

const disposeInstance = (
  instances: Map<string, SshTermInstance>,
  hostId: string,
): void => {
  const inst = instances.get(hostId)
  if (!inst) return
  instances.delete(hostId)
  inst.resizeObserver.disconnect()
  // 事件/焦点/resize-timer 清理都在 disposables 里统一释放。
  for (const disposable of inst.disposables) disposable.dispose()
  void setTerminalFocus(false)
  try {
    inst.term.dispose()
  } catch {
    // 已是野实例（重复销毁）时忽略。
  }
}

export const useSshTerminals = ({
  hosts,
  fontSizePx,
  monoFontFamily,
}: UseSshTerminalsOptions): UseSshTerminalsApi => {
  const instancesRef = useRef(new Map<string, SshTermInstance>())
  const slotRefsRef = useRef(new Map<string, (node: HTMLDivElement | null) => void>())

  // 事件单订阅：按 hostId 路由到对应实例（decoder 每实例独立，防跨主机串字节）。
  // 只注册一次，实例未建/已删则丢弃；不随 activeHostId 变化重订阅。
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void onSshSessionEvent((event) => {
      const inst = instancesRef.current.get(event.hostId)
      if (!inst) return
      if (event.data) {
        inst.term.write(inst.decoder.decode(decodeBase64ToBytes(event.data), { stream: true }))
      }
      if (event.done) {
        useSshStore.getState().markSessionClosed(event.hostId)
        inst.term.write(
          `\r\n\x1b[2m── 连接已断开${event.exitCode == null ? '' : `（退出码 ${event.exitCode}）`} ──\x1b[0m\r\n`,
        )
      }
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 主机列表 reconcile：清理已从列表移除的主机实例。
  useEffect(() => {
    const instances = instancesRef.current
    const ids = new Set(hosts.map((host) => host.id))
    for (const hostId of [...instances.keys()]) {
      if (!ids.has(hostId)) disposeInstance(instances, hostId)
    }
    // hosts 清空时 React 已卸载全部 slot（ref 回调兜底销毁）；此处再兜一层。
    if (hosts.length === 0 && instances.size > 0) {
      for (const hostId of [...instances.keys()]) disposeInstance(instances, hostId)
    }
  }, [hosts])

  // 面板卸载：销毁全部实例，避免泄漏。
  useEffect(() => {
    const instances = instancesRef.current
    return () => {
      for (const hostId of [...instances.keys()]) disposeInstance(instances, hostId)
    }
  }, [])

  // 字号/字体偏好即时生效：遍历所有实例更新 options 并 fit（修改行/列数经
  // onResize 链路同步远端会话，与容器尺寸变化同路径）。
  useEffect(() => {
    const nextFontSize = scaledTerminalFontSize(12, fontSizePx)
    const nextFontFamily = MONO_FONT_STACKS[monoFontFamily]
    for (const inst of instancesRef.current.values()) {
      if (inst.term.options.fontSize !== nextFontSize) inst.term.options.fontSize = nextFontSize
      if (inst.term.options.fontFamily !== nextFontFamily) inst.term.options.fontFamily = nextFontFamily
      try {
        inst.fitAddon.fit()
      } catch {
        // 面板尚未布局时忽略，由既有 ResizeObserver 兜底。
      }
    }
  }, [fontSizePx, monoFontFamily])

  const registerSlot = useCallback((hostId: string, node: HTMLDivElement | null): void => {
    const instances = instancesRef.current
    if (node === null) {
      disposeInstance(instances, hostId)
      return
    }
    if (instances.has(hostId)) return

    // 读当前 UI 偏好（字号/字体 set 走 getState，保证 registerSlot deps 稳定）。
    const { fontSizePx: fs, monoFontFamily: mf } = useUiStore.getState()
    const term = new Terminal({
      fontFamily: MONO_FONT_STACKS[mf],
      fontSize: scaledTerminalFontSize(12, fs),
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      theme: TERMINAL_THEME,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(node)
    // 显式写入当前偏好：xterm 构造已应用，这里兜底（测试桩 FakeTerminal 忽略构造参数）。
    term.options.fontFamily = MONO_FONT_STACKS[mf]
    term.options.fontSize = scaledTerminalFontSize(12, fs)

    const disposables: Array<{ dispose: () => void }> = [
      term.onData((data) => {
        void useSshStore.getState().writeSession(hostId, data).catch(() => undefined)
      }),
      term.onResize(({ cols, rows }) => {
        void useSshStore.getState().resizeSession(hostId, cols, rows).catch(() => undefined)
      }),
    ]

    // xterm 5.5 未暴露 onFocus/onBlur：监听底层 textarea 上报 Rust 手势门。
    const focusTextarea = term.textarea
    const reportFocus = (): void => {
      void setTerminalFocus(true)
    }
    const reportBlur = (): void => {
      void setTerminalFocus(false)
    }
    focusTextarea?.addEventListener('focus', reportFocus)
    focusTextarea?.addEventListener('blur', reportBlur)
    disposables.push({
      dispose: () => {
        if (focusTextarea) {
          focusTextarea.removeEventListener('focus', reportFocus)
          focusTextarea.removeEventListener('blur', reportBlur)
        }
      },
    })

    let resizeTimer: number | undefined
    const clearResizeTimer = (): void => {
      if (resizeTimer) window.clearTimeout(resizeTimer)
    }
    const scheduleFit = (): void => {
      if (resizeTimer) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        try {
          fitAddon.fit()
        } catch {
          // 布局中（hidden→visible 间隙）忽略，由激活 fit 兜底。
        }
      }, 80)
    }
    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(node)
    disposables.push({ dispose: clearResizeTimer })

    instances.set(hostId, {
      term,
      fitAddon,
      container: node,
      resizeObserver,
      disposables,
      decoder: new TextDecoder(),
    })
  }, [])

  const getSlotRef = useCallback(
    (hostId: string): ((node: HTMLDivElement | null) => void) => {
      const slotRefs = slotRefsRef.current
      let ref = slotRefs.get(hostId)
      if (!ref) {
        ref = (node: HTMLDivElement | null): void => registerSlot(hostId, node)
        slotRefs.set(hostId, ref)
      }
      return ref
    },
    [registerSlot],
  )

  const getTerminal = useCallback(
    (hostId: string): Terminal | undefined => instancesRef.current.get(hostId)?.term,
    [],
  )

  const fitFocus = useCallback((hostId: string | null): void => {
    if (!hostId) return
    const inst = instancesRef.current.get(hostId)
    if (!inst) return
    try {
      inst.fitAddon.fit()
    } catch {
      // 尺寸未定（刚切回 hidden→visible）忽略，由 ResizeObserver 兜底。
    }
    try {
      inst.term.focus()
    } catch {
      // 线程未就绪时忽略。
    }
  }, [])

  return { getSlotRef, getTerminal, fitFocus }
}
