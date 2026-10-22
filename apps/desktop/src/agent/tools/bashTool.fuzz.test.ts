import { describe, expect, it } from 'vitest'
import { isDangerousCommand, validateBashInput } from './bashTool'

/** 固定 LCG：生成可复现的命令语料，不引入额外 fuzz 依赖。 */
const next = (state: { value: number }): number => {
  state.value = (state.value * 1664525 + 1013904223) >>> 0
  return state.value
}

const fragments = [
  'echo safe',
  'git status',
  'npm test',
  'sudo id',
  'git pull && sudo rm -rf /',
  'echo hi; sudo whoami',
  '( sudo id )',
  'echo $(sudo id)',
  'echo x > /tmp/out.log',
  'make build >> /var/log/x',
  'cat a > ~/notes',
  'echo x 2>/dev/null',
  'echo x >& /tmp/out',
  'grep sudo package.json',
  'echo "run sudo as root"',
  "echo 'a > b'",
  'rm -rf ./build',
  'rm -r -f ./build',
  'curl https://example.com',
  'printf "%s" /usr/bin/sudo',
]

const randomCommand = (state: { value: number }): string => {
  const count = 1 + (next(state) % 4)
  const parts: string[] = []
  for (let index = 0; index < count; index += 1) {
    parts.push(fragments[next(state) % fragments.length]!)
  }
  return parts.join([' ', '; ', ' && ', ' | ', '\n'][next(state) % 5]!)
}

describe('bash policy fuzz', () => {
  it('never throws and always returns null or a string reason', () => {
    const random = { value: 0x5eedba5 }
    for (let iteration = 0; iteration < 600; iteration += 1) {
      const command = randomCommand(random)
      const result = validateBashInput({ command })
      expect(result === null || typeof result === 'string').toBe(true)
      expect(() => isDangerousCommand(command)).not.toThrow()
    }
  })

  it('rejects generated commands that invoke sudo in command position', () => {
    const prefixes = ['', 'echo ok; ', 'echo ok && ', '( ', 'echo $(', '\n']
    for (const prefix of prefixes) {
      expect(validateBashInput({ command: `${prefix}sudo id` })).toContain('sudo')
    }
    expect(validateBashInput({ command: '/usr/bin/sudo id' })).toContain('sudo')
    expect(validateBashInput({ command: 'env A=1 /usr/bin/sudo id' })).toContain('sudo')
  })

  it('rejects generated redirects outside the workspace but allows safe ones', () => {
    for (const command of [
      'echo x > /tmp/out',
      'echo x >> ../outside',
      'echo x > "$HOME/out"',
      'echo x >& /tmp/out',
      'exec {fd}> /tmp/out',
    ]) {
      expect(validateBashInput({ command })).toContain('重定向')
    }
    for (const command of [
      'echo x > out.txt',
      'echo x > "src/out.txt"',
      'echo x 2>/dev/null',
      'printf "a > b"',
      'grep sudo package.json',
    ]) {
      expect(validateBashInput({ command })).toBeNull()
    }
  })

  it('flags generated dangerous commands without flagging quoted data', () => {
    const dangerous = [
      'sudo id',
      'echo ok; sudo id',
      'echo ok && rm -rf /',
      'rm -r -f ./build',
      'curl https://example.com',
      'reboot',
    ]
    for (const command of dangerous) expect(isDangerousCommand(command)).toBe(true)
    const safe = [
      'grep sudo package.json',
      'echo "sudo id"',
      "echo 'rm -rf /'",
      'git checkout feature/curling',
    ]
    for (const command of safe) expect(isDangerousCommand(command)).toBe(false)
  })

  it('keeps rejection independent of fragment concatenation order', () => {
    // 只要 sudo/外写片段出现在命令位置，组合词序不应把它降级为安全命令。
    const random = { value: 0xcafe_babe }
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const prefix = randomCommand(random)
      for (const suffix of ['sudo id', 'echo x > /tmp/out']) {
        const command = `${prefix}; ${suffix}`
        expect(validateBashInput({ command }), command).not.toBeNull()
      }
    }
  })
})
