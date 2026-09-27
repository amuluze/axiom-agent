/**
 * 画布渲染错误边界：.pen 是模型随时改写的活文件，渲染映射对未来节点形状的
 * 假设失效时不能把整棵 React 树（含 Shell 侧栏）一起卸载成黑屏——应用内没有
 * 其它边界，坏数据必须降级为画布区的错误卡片。
 *
 * 单稿画布（DesignView）与对比视图（DesignCompareView）共用；对比视图每列各挂一个。
 * resetKey（sha256）换代时自动清除已捕获的错误并重挂 children（内容修复后的
 * 自动重试）；无错误时 resetKey 变化不重挂——无限画布的编辑态（选中/撤销栈/
 * 在途写回）必须跨内容更新存活。
 */
import { Component, Fragment } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface CanvasErrorBoundaryProps {
  title: string
  retryLabel: string
  /** 内容代际：仅在「有错误在身」时触发重挂重试，平时变化不重挂。 */
  resetKey?: string
  children: ReactNode
}

interface CanvasErrorBoundaryState {
  error: Error | null
  attempt: number
  lastResetKey?: string
}

class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  state: CanvasErrorBoundaryState = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<CanvasErrorBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(
    props: CanvasErrorBoundaryProps,
    state: CanvasErrorBoundaryState,
  ): Partial<CanvasErrorBoundaryState> | null {
    if (props.resetKey === undefined || props.resetKey === state.lastResetKey) return null
    // resetKey 换代：记住新代际；身上挂着错误时重试一次（重挂 children）。
    return state.error
      ? { lastResetKey: props.resetKey, error: null, attempt: state.attempt + 1 }
      : { lastResetKey: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 诊断出口：解析器已兜底，这里捕获的是渲染层残差；根因只在这能看到。
    console.error('[design] 画布渲染失败', error, info.componentStack)
  }

  render() {
    const { title, retryLabel, children } = this.props
    const { error, attempt } = this.state
    if (!error) return <Fragment key={attempt}>{children}</Fragment>
    return (
      <div className="design-view__parse-error" role="alert">
        <div>{title}</div>
        <div>{error.message}</div>
        <button
          type="button"
          className="design-view__rescan"
          onClick={() => this.setState((current) => ({ error: null, attempt: current.attempt + 1 }))}
        >
          {retryLabel}
        </button>
      </div>
    )
  }
}

export default CanvasErrorBoundary
