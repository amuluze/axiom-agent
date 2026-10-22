/**
 * 文档助手侧栏（.pen 设计稿 docs-view / docs-edit / docs-empty 的 dvd/dvx/dve-side
 * 覆写形态）：文档页侧栏只保留 Title Bar 与本助手面板，Nav / 工作区 / 任务列表 /
 * 底栏让位——与设计页侧栏覆写（XjPQ）同一模式。对话即普通会话，用户通过与模型
 * 对话创建/更新右侧文档（写操作仍走会话的写工具审批链）。
 */
import { AssistantSidebarPanel, assistantCopyFrom } from '@/components/shell/AssistantSidebarPanel'
import { useT } from '@/i18n'

const DocsAssistantPanel = () => {
  const { t } = useT()
  return <AssistantSidebarPanel copy={assistantCopyFrom(t, 'app.docs.assistant')} />
}

export default DocsAssistantPanel
