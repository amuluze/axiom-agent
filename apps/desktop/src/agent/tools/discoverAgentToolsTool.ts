import type { AgentTool, JsonValue } from '../core/types'
import { hasOnlyKeys, isJsonObject, optionalInteger } from './workspaceToolUtils'

const DEFAULT_LIMIT = 4
const MAX_LIMIT = 8

interface DiscoveryInput {
  query: string
  limit: number
}

const normalizeQuery = (value: string): string => value.trim().toLocaleLowerCase()

const queryTerms = (query: string): string[] =>
  normalizeQuery(query)
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean)

const asDiscoveryInput = (input: JsonValue): DiscoveryInput => {
  if (!isJsonObject(input)) throw new Error('invalid discovery input')
  return {
    query: typeof input.query === 'string' ? input.query.trim() : '',
    limit: typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
  }
}

const scoreTool = (tool: AgentTool, query: string, terms: string[]): number => {
  const name = normalizeQuery(tool.name)
  const label = normalizeQuery(tool.label)
  const description = normalizeQuery(tool.description)
  const searchableName = name.replace(/_/g, ' ')
  // Search across snippet + guidelines too so intent words (e.g. "execute",
  // "argv", "whitelist") that only appear in guidance can still match.
  const snippet = normalizeQuery(tool.promptSnippet ?? '')
  const guidelines = normalizeQuery((tool.promptGuidelines ?? []).join(' '))
  const haystack = `${searchableName} ${label} ${description} ${snippet} ${guidelines}`
  let score = 0
  if (name === query || searchableName === query) score += 100
  if (haystack.includes(query)) score += 12
  for (const term of terms) {
    if (name.includes(term) || searchableName.includes(term)) score += 6
    if (label.includes(term)) score += 3
    if (description.includes(term) || snippet.includes(term) || guidelines.includes(term)) score += 1
  }
  return score
}

export const createDiscoverAgentToolsTool = (
  registry: AgentTool[],
  activeNames: readonly string[] = [],
): AgentTool => {
  const tools = registry.slice()
  const activeSet = new Set(activeNames)
  const catalog = tools.map((tool) => `${tool.name}（${tool.label}）`).join(', ')
  return {
    name: 'discover_agent_tools',
    label: '发现 Agent 工具',
    promptSnippet: '搜索并激活 Axiom 在本次运行中已授权的能力。',
    promptGuidelines: [
      '激活的工具在本次会话剩余时间内始终可用。',
    ],
    runtimeVersion: '4',
    recoveryPolicy: 'idempotent',
    idempotencyKey: (input) => {
      const { query, limit } = asDiscoveryInput(input)
      return `discover:${normalizeQuery(query)}:${limit}`
    },
    description: [
      'Search the Axiom-authorized tool registry by intent and activate the matches for subsequent model turns.',
      'Call this tool first, then use the returned tools in the next turn; already-activated tools remain available.',
      `Example queries: "read workspace", "explore codebase", "edit file", "run tests".${catalog ? ` Available tools: ${catalog}.` : ' No additional tools are granted under the current run policy.'}`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Capability description or exact tool name (e.g. read workspace, edit file, run tests).',
        },
        limit: {
          type: 'number',
          description: `Maximum matches to activate. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    validate: (input) => {
      if (!isJsonObject(input) || !hasOnlyKeys(input, ['query', 'limit'])) {
        return { ok: false, error: 'Arguments must be an object with only query and limit.' }
      }
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256) {
        return { ok: false, error: 'query must be a non-empty string of 1..256 chars.' }
      }
      if (!optionalInteger(input.limit, 1, MAX_LIMIT)) {
        return { ok: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}.` }
      }
      return { ok: true, value: input }
    },
    execute: async (input) => {
      const { query, limit } = asDiscoveryInput(input)
      const terms = queryTerms(query)
      const matches = tools
        .map((tool, index) => ({ tool, index, score: scoreTool(tool, normalizeQuery(query), terms) }))
        .filter((candidate) => candidate.score > 0 && !activeSet.has(candidate.tool.name))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, limit)
        .map((candidate) => candidate.tool)
      const names = matches.map((tool) => tool.name)
      return {
        content: names.length > 0
          ? `Activated tools: ${matches.map((tool) => `${tool.name} (${tool.label})`).join(', ')}. Use them in the next turn.`
          : `No authorized tool matched "${query}" outside your currently active capabilities. Rephrase with a more specific capability.`,
        details: { query, matches: names },
        ...(names.length > 0 ? { addedToolNames: names } : {}),
      }
    },
  }
}
