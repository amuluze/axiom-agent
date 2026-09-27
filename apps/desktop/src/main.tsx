import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/sidebar.css'
import './styles/new-task.css'
import './styles/composer.css'
import './styles/session.css'
import './styles/approval.css'
import './styles/feedback.css'
import './styles/settings.css'
import './styles/design.css'
import './styles/rail.css'
import './styles/ssh.css'
import './styles/terminal.css'
import './styles/connect.css'
import { runRuntimeFaultAutomation } from './platform/runtimeFaultAutomation'
import { setDesignComponentDetailProvider, setDesignComponentInventoryProvider } from '@/agent/design/componentInventoryHost'
import { axComponentDetailOf, axComponentInventorySummary } from '@/components/design/ax/registry'
import { renderAxPageToPng, renderPenPageForScan } from '@/components/design/ax/renderPageHost'
import { setDesignPageRenderProvider, setDesignScanPageRenderProvider } from '@/agent/design/designRenderHost'
import { WorkspaceRecoveryGate } from './components/WorkspaceRecoveryGate'
import { initConnectService } from './stores/services/connectService'
import { initBrowserPanelService } from './stores/services/browserPanelService'
import { initUpdaterService } from './stores/services/updaterService'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkspaceRecoveryGate>
      <App />
    </WorkspaceRecoveryGate>
  </React.StrictMode>,
)

// `.ax` 组件清单：把设计层注册表的摘要注入 agent 层接缝（`design_query` 消费）。
// 在此装配而非 agentStore 内直接 import——注册表依赖会话组件、组件依赖 store，
// 直接 import 会形成模块环（对照 runtimeCaches 的同类处理）。
setDesignComponentInventoryProvider(axComponentInventorySummary)
// 单组件详单（mode=component）：props 契约 + statics + fixture 数据形状，
// 模型写 component 节点前查一次即可，不必读组件源码反推隐式前提。
setDesignComponentDetailProvider(axComponentDetailOf)
// 渲染回读：`design_query` 的 render 模式要把整页渲染成 PNG 回给模型自查。
setDesignPageRenderProvider(renderAxPageToPng)
// 扫描验证：逐页离屏渲染 + 像素统计（`design_query` mode=scan 与画布扫描面板共用）。
setDesignScanPageRenderProvider(renderPenPageForScan)

// 连接服务：订阅聊天平台事件并路由到 agentStore（浏览器 dev 模式为空操作）。
initConnectService()
// 浏览器面板服务：订阅 Rust 浏览器事件总线 + screencast 可见性门控（dev 模式为空操作）。
initBrowserPanelService()
// 自更新服务：启动后延迟静默检查一次（dev 模式为空操作）。
initUpdaterService()

void runRuntimeFaultAutomation().catch((error: unknown) => {
  console.error('Runtime fault automation failed', error)
})
