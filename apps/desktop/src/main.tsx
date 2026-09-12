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
import './styles/settings.css'
import './styles/rail.css'
import './styles/ssh.css'
import './styles/terminal.css'
import './styles/connect.css'
import { runRuntimeFaultAutomation } from './platform/runtimeFaultAutomation'
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

// 连接服务：订阅聊天平台事件并路由到 agentStore（浏览器 dev 模式为空操作）。
initConnectService()
// 浏览器面板服务：订阅 Rust 浏览器事件总线 + screencast 可见性门控（dev 模式为空操作）。
initBrowserPanelService()
// 自更新服务：启动后延迟静默检查一次（dev 模式为空操作）。
initUpdaterService()

void runRuntimeFaultAutomation().catch((error: unknown) => {
  console.error('Runtime fault automation failed', error)
})
