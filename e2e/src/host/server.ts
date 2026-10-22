import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { resolve, dirname } from 'node:path'
import { createHostState, handleCommand, resetHostState, type HostApprovalPolicy, type HostState } from './commands'
import { textTurn, toolTurn, type ScriptedTurn } from './model'

export interface HostServerOptions {
  bind: string
  approvalPolicy: HostApprovalPolicy
  chunkSize?: number
}

export interface HostSnapshot {
  calls: { cmd: string; args: Record<string, unknown> }[]
  approved: string[]
  denied: string[]
  pendingApprovals: string[]
  workspaces: string[]
  activeWorkspacePath: string | null
  secrets: string[]
}

export interface HostServer {
  baseUrl: string
  state: HostState
  snapshot: () => HostSnapshot
  close: () => Promise<void>
}

interface Client {
  response: ServerResponse
  events: { event: string; handler: number }[]
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body ?? null)
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

const readJson = async (stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** 脚本场景的线上表示：{kind:'text',text} 或 {kind:'tool',name,input}。 */
type ScenarioStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input?: Record<string, unknown> }

const toTurns = (steps: ScenarioStep[]): ScriptedTurn[] => steps.map((step, index) =>
  step.kind === 'text'
    ? textTurn(step.text, `msg_e2e_${index}`)
    : toolTurn([{ name: step.name, input: step.input ?? {}, id: `toolu_e2e_${index}` }], `msg_e2e_${index}`))

/** 启动假宿主：命令面（/invoke）、事件面（/events）、控制面（/control/*）。 */
export const startHostServer = async (options: HostServerOptions): Promise<HostServer> => {
  const state = await createHostState()
  const clients = new Map<string, Client>()
  const chunkSize = options.chunkSize ?? 512

  const emit = (clientId: string, event: string, payload: unknown): void => {
    const client = clients.get(clientId)
    if (!client) return
    for (const registration of client.events) {
      if (registration.event !== event) continue
      client.response.write(
        `data: ${JSON.stringify({ handler: registration.handler, event, payload })}\n\n`,
      )
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${options.bind}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
        })
        response.end()
        return
      }
      if (url.pathname === '/events') {
        const clientId = url.searchParams.get('client') ?? 'default'
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        clients.set(clientId, { response, events: [] })
        request.on('close', () => clients.delete(clientId))
        return
      }
      if (url.pathname === '/invoke') {
        const body = await readJson(request)
        const clientId = String(body.clientId ?? 'default')
        const cmd = String(body.cmd ?? '')
        const args = (body.args ?? {}) as Record<string, unknown>
        try {
          // 事件插件：登记 event → handlerId，宿主推送时按此派发。
          if (cmd === 'plugin:event|listen') {
            clients.get(clientId)?.events.push({
              event: String(args.event ?? ''),
              handler: Number(args.handler ?? 0),
            })
            json(response, 200, { ok: true, value: args.handler ?? null })
            return
          }
          if (cmd === 'plugin:event|unlisten') {
            const client = clients.get(clientId)
            if (client) {
              client.events = client.events.filter((entry) => entry.handler !== args.eventId)
            }
            json(response, 200, { ok: true, value: null })
            return
          }
          state.calls.push({ cmd, args })
          const value = await handleCommand(cmd, args, {
            clientId,
            state,
            approvalPolicy: options.approvalPolicy,
            chunkSize,
            emit,
          })
          json(response, 200, { ok: true, value: value ?? null })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(response, 200, { ok: false, error: `${cmd}: ${message}` })
        }
        return
      }
      if (url.pathname === '/control/seed-workspace') {
        const body = await readJson(request)
        const name = String(body.name ?? `ws-${state.workspaces.size + 1}`)
        const path = resolve(state.root, name)
        await mkdir(path, { recursive: true })
        for (const [file, content] of Object.entries((body.files ?? {}) as Record<string, string>)) {
          const target = resolve(path, file)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content)
        }
        if (body.pick !== false) state.pickQueue.push(path)
        json(response, 200, { path })
        return
      }
      if (url.pathname === '/control/scenario') {
        const body = await readJson(request)
        state.turns = toTurns((body.steps ?? []) as ScenarioStep[])
        json(response, 200, { turns: state.turns.length })
        return
      }
      if (url.pathname === '/control/approval') {
        const body = await readJson(request)
        const decision = String(body.decision ?? 'allow')
        const lease = state.approvals.keys().next()
        if (lease.done) {
          json(response, 409, { error: '没有待处理的审批请求' })
          return
        }
        const pending = state.approvals.get(lease.value)
        state.approvals.delete(lease.value)
        if (decision === 'allow') pending?.resolve(lease.value)
        else pending?.reject(new Error('用户拒绝了本次操作'))
        json(response, 200, { lease: lease.value, decision })
        return
      }
      if (url.pathname === '/control/state') {
        json(response, 200, snapshot())
        return
      }
      if (url.pathname === '/control/reset') {
        resetHostState(state)
        json(response, 200, { ok: true })
        return
      }
      json(response, 404, { error: `unknown route ${url.pathname}` })
    })()
  })

  const snapshot = (): HostSnapshot => ({
    calls: state.calls,
    approved: state.approved,
    denied: state.denied,
    pendingApprovals: [...state.approvals.keys()],
    workspaces: [...state.workspaces.keys()],
    activeWorkspacePath: state.activeWorkspacePath,
    secrets: [...state.secrets],
  })

  await new Promise<void>((settle) => server.listen(0, options.bind, settle))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('假宿主未能绑定回环端口')
  return {
    baseUrl: `http://${options.bind}:${address.port}`,
    state,
    snapshot,
    close: () => new Promise<void>((settle, fail) => {
      for (const client of clients.values()) client.response.end()
      server.close((error) => (error ? fail(error) : settle()))
    }),
  }
}
