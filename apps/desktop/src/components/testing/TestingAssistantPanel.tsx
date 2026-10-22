/**
 * 测试助手侧栏（.pen 设计稿 tsCases / tsRunng / tsRprt 的 p3kaM 覆写形态）：
 * 测试页侧栏只保留 Title Bar 与本助手面板。对话即普通会话，用户通过与模型对话
 * 编写/完善右侧测试用例（探索与固化走测试页主区既有通道）。
 */
import { AssistantSidebarPanel, assistantCopyFrom } from '@/components/shell/AssistantSidebarPanel'
import { useT } from '@/i18n'

const TestingAssistantPanel = () => {
  const { t } = useT()
  return <AssistantSidebarPanel copy={assistantCopyFrom(t, 'app.testing.assistant')} />
}

export default TestingAssistantPanel
