import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontendRoot = path.join(root, 'apps/desktop/src')

const readText = (relativePath) => readFile(path.join(root, relativePath), 'utf8')

const sorted = (values) => [...values].sort()

const assertSameSet = (actual, expected, label) => {
  assert.deepEqual(sorted(new Set(actual)), sorted(new Set(expected)), `${label} drifted`)
}

const sourceFiles = async (directory) => {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(target))
    else if (/\.tsx?$/u.test(entry.name)) files.push(target)
  }
  return files
}

const parseCsp = (value) => new Map(value
  .split(';')
  .map((directive) => directive.trim())
  .filter(Boolean)
  .map((directive) => {
    const [name, ...sources] = directive.split(/\s+/u)
    return [name, sources]
  }))

const assertCsp = (value, expected, label) => {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  const directives = parseCsp(value)
  assertSameSet(directives.keys(), Object.keys(expected), `${label} directives`)
  for (const [directive, sources] of Object.entries(expected)) {
    assertSameSet(directives.get(directive) ?? [], sources, `${label} ${directive}`)
  }
}

const buildSource = await readText('apps/desktop/src-tauri/build.rs')
const libSource = await readText('apps/desktop/src-tauri/src/lib.rs')
const capability = JSON.parse(await readText('apps/desktop/src-tauri/capabilities/default.json'))
const e2eCapability = JSON.parse(await readText(
  'apps/desktop/src-tauri/capabilities/e2e/runtime-fault.json',
))
const tauriConfig = JSON.parse(await readText('apps/desktop/src-tauri/tauri.conf.json'))
const e2eConfig = JSON.parse(await readText('apps/desktop/src-tauri/tauri.e2e.conf.json'))
const providerBarrel = await readText('apps/desktop/src/agent/transport/provider.ts')
// Provider secretId 前缀表单一来源：contracts/providers.json → 生成的 TS/Rust 数据段。
const providersContract = JSON.parse(await readText('apps/desktop/contracts/providers.json'))
const generatedTsData = await readText('apps/desktop/src/agent/transport/generatedProviderData.ts')
const generatedRustTable = await readText('apps/desktop/src-tauri/src/generated_provider_table.rs')

const commandArray = (name) => {
  const block = buildSource.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`, 'u'))
  assert.ok(block, `build.rs must define ${name}`)
  return [...block[1].matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1])
}
const manifestCommands = commandArray('APP_COMMANDS')
const e2eOnlyManifestCommands = commandArray('E2E_APP_COMMANDS')
const e2eManifestCommands = [...manifestCommands, ...e2eOnlyManifestCommands]
assert.ok(manifestCommands.length > 0, 'APP_COMMANDS must not be empty')
assert.equal(new Set(manifestCommands).size, manifestCommands.length, 'APP_COMMANDS contains duplicates')
assert.equal(new Set(e2eManifestCommands).size, e2eManifestCommands.length,
  'E2E APP_COMMANDS contains duplicates')
assert.match(buildSource, /var_os\("CARGO_FEATURE_E2E"\)/u)
assert.match(buildSource, /app_commands\.extend_from_slice\(E2E_APP_COMMANDS\)/u)
assert.match(buildSource, /AppManifest::new\(\)\.commands\(app_commands\)/u)

const handlerBlock = libSource.match(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/u)
assert.ok(handlerBlock, 'lib.rs must define a Tauri invoke handler')
const handlerEntries = handlerBlock[1]
  .split(',')
  .map((command) => command.trim())
  .filter(Boolean)
const handlerCommands = []
const e2eOnlyHandlerCommands = []
for (const entry of handlerEntries) {
  const match = entry.match(/^(?:#\[cfg\(feature = "e2e"\)\]\s*)?([a-z][a-z0-9_]*)$/u)
  assert.ok(match, `unsupported invoke handler entry: ${entry}`)
  if (entry.startsWith('#[cfg')) e2eOnlyHandlerCommands.push(match[1])
  else handlerCommands.push(match[1])
}
assertSameSet(manifestCommands, handlerCommands, 'application manifest and invoke handler')
assertSameSet(e2eOnlyManifestCommands, e2eOnlyHandlerCommands,
  'E2E application manifest and invoke handler')

const invokedCommands = new Set()
const e2eInvokedCommands = new Set()
for (const file of await sourceFiles(frontendRoot)) {
  const source = await readFile(file, 'utf8')
  // 相对路径归一为 / 分隔：path.relative 在 Windows 返回反斜杠，精确比较会
  // 永远失配，把 e2e 专用 invoke 误计入常规集合（跨平台审计的前提）。
  const relativeFile = path.relative(frontendRoot, file).split(path.sep).join('/')
  for (const match of source.matchAll(/(?:\binvoke|__TAURI_INVOKE)(?:<[^;()]*>)?\(\s*(['"])([^'"]+)\1/gu)) {
    if (match[2].startsWith('plugin:')) continue
    if (relativeFile === 'platform/runtimeFaultInjection.ts') {
      e2eInvokedCommands.add(match[2])
    } else {
      invokedCommands.add(match[2])
    }
  }
}
assertSameSet(manifestCommands, invokedCommands, 'application manifest and frontend invokes')
assertSameSet(e2eOnlyManifestCommands, e2eInvokedCommands,
  'E2E application manifest and frontend invokes')

assert.equal(capability.identifier, 'default')
assert.equal(capability.local, true)
assert.deepEqual(capability.windows, ['main'])
// 主 capability 覆盖 macOS / Linux / Windows（Linux/Windows 的功能限制在 Rust
// 侧 fail-closed，见 docs/linux-support.md 与 docs/windows-support.md；命令面
// 不裁剪以维持契约稳定）。
assert.deepEqual(capability.platforms, ['macOS', 'linux', 'windows'])
assert.equal('remote' in capability, false, 'remote origins must not receive IPC capabilities')

assert.doesNotMatch(
  providerBarrel,
  /BUILTIN_PROVIDER_(?:CATALOG|REGISTRY|CREDENTIAL_MIGRATIONS)|ProviderCatalog/u,
  'public Provider barrel must not expose Registry construction or migration capabilities',
)

const providerBoundaryImports = new Map([
  ['./ProviderRegistry', new Set(['ProviderRuntime.ts', 'ProviderCredentialRuntime.ts'])],
  ['./builtinProviderDescriptors', new Set(['ProviderRegistry.ts', 'providerDefinitions.ts'])],
  ['./providerDefinitions', new Set([
    'ProviderRegistry.ts',
    'builtinProviderDescriptors.ts',
    'providerProfile.ts',
    'modelCatalog.ts',
  ])],
  ['./ProviderCredentialRuntime', new Set(['ProviderRuntime.ts'])],
  ['./generatedProviderData', new Set([
    'builtinProviderDescriptors.ts',
    'providerDefinitions.ts',
    'providerProfile.ts',
  ])],
  ['@/agent/transport/ProviderCredentialRuntime', new Set(['stores/agentStore.ts'])],
])
for (const file of await sourceFiles(frontendRoot)) {
  // 同上：归一为 / 分隔，Windows 反斜杠路径无法命中边界白名单。
  const relative = path.relative(frontendRoot, file).split(path.sep).join('/')
  if (/\.(?:test|spec)\.tsx?$/u.test(relative)) continue
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/\bfrom\s+(['"])([^'"]+)\1/gu)) {
    const allowed = providerBoundaryImports.get(match[2])
    if (!allowed) continue
    assert.ok(
      allowed.has(relative) || allowed.has(path.basename(relative)),
      `${relative} bypasses the Provider Runtime boundary via ${match[2]}`,
    )
  }
}

const quotedValues = (source) => [...source.matchAll(/["'](provider\.[A-Za-z0-9._-]+)["']/gu)]
  .map((match) => match[1])
const currentSecretIds = providersContract.providers
  .filter((provider) => provider.auth.kind === 'api-key')
  .map((provider) => provider.auth.defaultSecretId)
const legacySecretIds = providersContract.providers.flatMap((provider) => provider.legacySecretIdPrefixes)
assert.doesNotMatch(generatedTsData, /Provider(?:Registry|CredentialRuntime)/u,
  'generated Provider data must not reference Runtime types')
assertSameSet(
  quotedValues(generatedTsData).filter((value) => value.includes('.api-key')),
  [...currentSecretIds, ...legacySecretIds],
  'generated TS Provider secret namespaces',
)
const nativeCurrentBlock = generatedRustTable.match(
  /const CURRENT_PROVIDER_SECRET_PREFIXES: &\[&str\] = &\[([\s\S]*?)\];/u,
)
const nativeLegacyBlock = generatedRustTable.match(
  /const LEGACY_PROVIDER_SECRET_PREFIXES: &\[&str\] = &\[([\s\S]*?)\];/u,
)
assert.ok(nativeCurrentBlock, 'native current Provider secret namespace is missing')
assert.ok(nativeLegacyBlock, 'native legacy Provider secret namespace is missing')
assertSameSet(quotedValues(nativeCurrentBlock[1]), currentSecretIds, 'current Provider secret namespaces')
assertSameSet(quotedValues(nativeLegacyBlock[1]), legacySecretIds, 'legacy Provider secret namespaces')

// 模型级 wire（多协议网关，如 OpenCode Go 的 chat/responses/messages）：TS 生成数据与 Rust
// 生成表必须逐条一致——TS 用它选 transport 类（决定请求体构造与 SSE 解析），Rust 用它解析
// 请求 URL 与认证头；两侧漂移会造成「按 A 协议发请求、按 B 协议解析响应」这类静默故障。
const RUST_ENUM_TO_FORMAT = {
  OpenaiCompatible: 'openai-compatible',
  OpenaiResponses: 'openai-responses',
  AnthropicCompatible: 'anthropic-compatible',
}
const contractWireFormats = providersContract.providers.flatMap((provider) => (provider.models ?? [])
  .filter((model) => model.wire)
  .map((model) => `${model.modelId}|${model.wire.apiFormat}|${model.wire.endpoint}`))
const rustWires = (generatedRustTable.match(/model_wires: &\[[\s\S]*?\n {8}\]/gu) ?? []).flatMap(
  (block) => [...block.matchAll(
    /model_id: "([^"]+)",\s*api_format: ModelApiFormat::(\w+),\s*endpoint: "([^"]+)"/gu,
  )].map((match) => `${match[1]}|${RUST_ENUM_TO_FORMAT[match[2]] ?? match[2]}|${match[3]}`),
)
assert.deepEqual(
  rustWires,
  contractWireFormats,
  'native Provider model wires must mirror the contract exactly',
)
const tsWires = [...generatedTsData.matchAll(/wire: \{[\s\S]*?\}/gu)].map(([block]) => {
  const match = block.match(/apiFormat: '([^']+)',\s*endpoint: '([^']+)'/u)
  return match ? `${match[1]}|${match[2]}` : block
})
assert.deepEqual(
  tsWires,
  contractWireFormats.map((entry) => entry.split('|').slice(1).join('|')),
  'generated TS Provider model wires must mirror the contract exactly',
)
// 静态请求头/会话头表：只允许覆盖声明了它们的 provider（TS/Rust 同源）。
// 按 const 块切分后匹配（rustfmt 会把短数组压成一行，不能按行缩进假设）。
const rustConstBody = (name) => {
  // 行尾容忍 CRLF：Windows 检出（core.autocrlf）会把生成表写成 \r\n，
  // 逐字 `\n` 锚点在跨平台审计下会失配。
  const match = generatedRustTable.match(new RegExp(`const ${name}[^=]*=([\\s\\S]*?);\\r?\\n`, 'u'))
  assert.ok(match, `native ${name} is missing`)
  return match[1]
}
const contractHeaderProviders = providersContract.providers
  .filter((provider) => provider.requestHeaders)
  .map((provider) => provider.id).sort()
const rustHeaderProviders = [...rustConstBody('PROVIDER_REQUEST_HEADERS')
  .matchAll(/\("([a-z0-9-]+)", &\[\(/gu)].map((match) => match[1]).sort()
assert.deepEqual(
  rustHeaderProviders,
  contractHeaderProviders,
  'native Provider request-header table must cover exactly the declaring providers',
)
// 会话头的 host 级声明：由「声明了 sessionHeader 的 provider 的默认 endpoint host ∪
// trustedHosts」派生（上游要求属于服务，不随 provider 条目走）。派生逻辑在生成器与这里
// 各实现一次，两边必须得出同一集合——漂移会让自定义 endpoint 指向该服务的请求缺头 400。
const expectedSessionHeaderHosts = [...new Set(providersContract.providers
  .filter((provider) => provider.sessionHeader)
  .flatMap((provider) => [
    new URL(provider.defaultProfile.endpoint).host,
    ...(provider.trustedHosts ?? []),
  ]))].sort()
const rustSessionHeaderHosts = [...rustConstBody('PROVIDER_SESSION_HEADER_HOSTS')
  .matchAll(/\("([a-z0-9.-]+)", "/gu)].map((match) => match[1]).sort()
assert.deepEqual(
  rustSessionHeaderHosts,
  expectedSessionHeaderHosts,
  'native session-header host table must match the derived contract hosts',
)

// 展示用链接（官网/邀请）：UI-only 字段，但必须与契约一致地出现在生成数据里，
// 否则设置页会漏展示或展示过期链接。
for (const key of ['website', 'inviteUrl']) {
  const declared = providersContract.providers
    .filter((provider) => provider[key] !== undefined)
    .map((provider) => `${key}: '${provider[key]}'`)
  for (const expected of declared) {
    assert.ok(generatedTsData.includes(expected), `generated TS Provider data is missing ${expected}`)
  }
  // 数据段里该 key 的出现次数必须等于声明数（界面类型声明里的 `key?:` 不带引号，不计数）：
  // 多出来就是生成数据带上了未声明的链接。
  const occurrences = generatedTsData.split(`${key}: '`).length - 1
  assert.equal(occurrences, declared.length, `generated TS ${key} entries must match the contract`)
}

const contractSessionHeaderProviders = providersContract.providers
  .filter((provider) => provider.sessionHeader)
  .map((provider) => provider.id).sort()
const rustSessionHeaderProviders = [...rustConstBody('PROVIDER_SESSION_HEADERS')
  .matchAll(/\("([a-z0-9-]+)", "/gu)].map((match) => match[1]).sort()
assert.deepEqual(
  rustSessionHeaderProviders,
  contractSessionHeaderProviders,
  'native Provider session-header table must cover exactly the declaring providers',
)

const pluginPermissions = [
  'core:event:allow-listen',
  'core:event:allow-unlisten',
  'core:window:allow-start-dragging',
  // 应用内主题偏好同步原生窗口外观（platform/windowTheme.ts → set_window_theme），
  // WKWebView 原生控件（select 下拉等）跟随 NSApp 外观而非页面 color-scheme。
  'core:window:allow-set-theme',
  'dialog:allow-open',
  // 窗口状态记忆（尺寸/位置/最大化）：窗口几何由 window-state 插件在窗口
  // 创建时恢复（Rust 侧注册，platform 层无需前端调用，仅权限声明）。
  'window-state:default',
  // 自更新：updater:default（check/download/install/download-and-install）+
  // process:allow-restart（安装完成后重启；不放行 allow-exit）。
  // updater 插件按配置存在与否条件注册（lib.rs），无配置构建中权限仅静态解析、不可达。
  'updater:default',
  'process:allow-restart',
]
// 终端 stdin 权限按需运行时授予（terminal.rs spawn_terminal → add_capability，
// 需要 tauri `dynamic-acl` feature），不在默认 capability 中开放；其余命令一一对应。
// stdin 输入来源由 Rust 侧原生键盘手势门单次消费校验（terminal.rs consume_stdin_gesture）。
const RUNTIME_GRANTED_PERMISSIONS = new Set(['allow-write-terminal-stdin'])
const mainWindowPermissions = manifestCommands
  .map((command) => `allow-${command.replaceAll('_', '-')}`)
  .filter((permission) => !RUNTIME_GRANTED_PERMISSIONS.has(permission))
assertSameSet(
  capability.permissions,
  [...pluginPermissions, ...mainWindowPermissions],
  'main capability permissions',
)
assert.equal(
  capability.permissions.includes('allow-write-terminal-stdin'),
  false,
  'stdin permission must not be open in the default capability',
)
const terminalSource = await readText('apps/desktop/src-tauri/src/terminal.rs')
assert.match(
  terminalSource,
  /spawn_terminal[\s\S]*add_capability\(/u,
  'terminal.rs spawn_terminal must grant the runtime stdin capability',
)
assert.match(
  terminalSource,
  /permission\("allow-write-terminal-stdin"\)/u,
  'terminal.rs runtime capability must reference the stdin permission',
)
const e2eAppPermissions = e2eOnlyManifestCommands
  .map((command) => `allow-${command.replaceAll('_', '-')}`)
assert.equal(e2eCapability.identifier, 'e2e-runtime-fault')
assert.equal(e2eCapability.local, true)
assert.deepEqual(e2eCapability.windows, ['main'])
// E2E capability 仅 macOS：原生 AX 驱动的 E2E（swiftc/osascript）没有 Linux 等价物。
assert.deepEqual(e2eCapability.platforms, ['macOS'])
assert.equal('remote' in e2eCapability, false, 'remote origins must not receive E2E IPC capabilities')
assertSameSet(e2eCapability.permissions, e2eAppPermissions, 'E2E capability permissions')
assert.equal(capability.permissions.some((permission) => permission.startsWith('sql:')), false)
assert.doesNotMatch(libSource, /tauri_plugin_sql/u)

assert.deepEqual(tauriConfig.app.windows.map((window) => window.label), ['main'])
const mainWindow = tauriConfig.app.windows[0]
assert.equal(mainWindow.titleBarStyle, 'Overlay')
assert.equal(mainWindow.hiddenTitle, true)
assert.deepEqual(mainWindow.trafficLightPosition, { x: 8, y: 22 })
const security = tauriConfig.app.security
assert.deepEqual(security.capabilities, ['default'])
assert.equal(security.freezePrototype, true)
assert.equal(security.dangerousDisableAssetCspModification, false)
assert.equal('assetProtocol' in security, false, 'asset protocol must remain disabled by default')

const sharedCsp = {
  'default-src': ["'self'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'form-action': ["'none'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'script-src': ["'self'"],
}
assertCsp(security.csp, {
  ...sharedCsp,
  'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
}, 'production CSP')
assertCsp(security.devCsp, {
  ...sharedCsp,
  'connect-src': [
    "'self'",
    'ipc:',
    'http://ipc.localhost',
    'http://localhost:*',
    'ws://localhost:*',
  ],
}, 'development CSP')

assert.equal(e2eConfig.identifier, 'com.axiom.desktop.e2e')
assert.deepEqual(e2eConfig.app.windows, [])
assert.deepEqual(e2eConfig.app.security, {
  capabilities: ['default', 'e2e-runtime-fault'],
})

console.log([
  'Tauri capability audit passed',
  `app-commands=${manifestCommands.length}`,
  `e2e-commands=${e2eManifestCommands.length}`,
  `plugin-permissions=${pluginPermissions.length}`,
  'window=main',
  'remote-ipc=denied',
  'provider-boundary=restricted',
  'production-csp=restricted',
].join(' '))
