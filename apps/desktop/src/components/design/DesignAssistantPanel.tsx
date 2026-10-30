/**
 * 设计助手侧栏（docs/design-canvas.md §11 第六轮；对齐 .pen 设计稿 XjPQ 的
 * 侧栏覆写：设计页隐藏 Nav/工作区/任务列表/底栏，Spacer 位置换成「绘画窗口」；
 * 侧栏 Composer 不展开审批模式下拉，设计写操作与普通会话使用同一权限档。
 *
 * 面板形态与文档/测试助手同构（Shared10 / DocsAssistant / Shared12 克隆），
 * 因此直接复用 `AssistantSidebarPanel`——不再保留本地的第二份 markup，
 * 否则改面板结构（引导区、空态、Composer 装配）会漏掉设计视图。
 */
import { AssistantSidebarPanel, assistantCopyFrom } from '@/components/shell/AssistantSidebarPanel'
import { useT } from '@/i18n'

const DesignAssistantPanel = () => {
  const { t } = useT()
  return <AssistantSidebarPanel copy={assistantCopyFrom(t, 'app.design.assistant')} showAccessPicker={false} />
}

export default DesignAssistantPanel
