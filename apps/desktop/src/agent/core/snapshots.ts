import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  JsonValue,
  ModelRequest,
  ToolCall,
  ToolApprovalPresentation,
  ToolResultMessage,
} from './types'

export const cloneJsonValue = <T extends JsonValue>(value: T): T => structuredClone(value)

export const snapshotAgentMessage = <T extends AgentMessage>(message: T): T =>
  structuredClone(message)

export const snapshotAgentMessages = (messages: AgentMessage[]): AgentMessage[] =>
  messages.map((message) => snapshotAgentMessage(message))

export const snapshotAssistantMessage = (message: AssistantMessage): AssistantMessage =>
  snapshotAgentMessage(message)

export const snapshotToolResultMessage = (message: ToolResultMessage): ToolResultMessage =>
  snapshotAgentMessage(message)

export const snapshotToolCall = (call: ToolCall): ToolCall => structuredClone(call)

export const snapshotToolResult = (result: AgentToolResult): AgentToolResult =>
  structuredClone(result)

export const snapshotApprovalPresentation = (
  presentation: ToolApprovalPresentation,
): ToolApprovalPresentation => structuredClone(presentation)

export const snapshotAgentTool = (tool: AgentTool): AgentTool => ({
  ...tool,
  inputSchema: cloneJsonValue(tool.inputSchema),
})

export const snapshotAgentTools = (tools: AgentTool[]): AgentTool[] =>
  tools.map((tool) => snapshotAgentTool(tool))

export const snapshotAgentContext = (context: AgentContext): AgentContext => ({
  ...context,
  model: structuredClone(context.model),
  reasoning: context.reasoning ? structuredClone(context.reasoning) : undefined,
  messages: snapshotAgentMessages(context.messages),
  tools: snapshotAgentTools(context.tools),
  activeToolNames: context.activeToolNames?.slice(),
})

export const snapshotModelRequest = (request: ModelRequest): ModelRequest =>
  structuredClone(request)

export const snapshotAgentEvent = (event: AgentEvent): AgentEvent => structuredClone(event)
