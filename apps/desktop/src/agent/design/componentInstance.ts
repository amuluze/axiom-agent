export type DesignBinding = { kind: 'mock'; value: unknown } | { kind: 'bind'; target: string }

export const designBindingOf = (value: unknown): DesignBinding | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1) return null
  if (Object.hasOwn(record, '$mock')) return { kind: 'mock', value: record.$mock }
  if (typeof record.$bind === 'string') return { kind: 'bind', target: record.$bind }
  return null
}

export const componentFixtureOf = (
  fixtures: Record<string, Record<string, unknown>>,
  fixture?: string,
): Record<string, unknown> => fixtures[fixture ?? ''] ?? Object.values(fixtures)[0] ?? {}

export const resolveComponentProps = (
  kind: 'presentational' | 'store-bound',
  fixture: Record<string, unknown>,
  props?: Record<string, unknown>,
  variant?: string,
): Record<string, unknown> => {
  const resolved: Record<string, unknown> = kind === 'store-bound' ? {} : { ...fixture }
  for (const [field, value] of Object.entries(props ?? {})) {
    const binding = designBindingOf(value)
    if (binding?.kind === 'mock') resolved[field] = binding.value
    else if (binding?.kind === 'bind') resolved[field] = Object.hasOwn(resolved, field) ? resolved[field] : `{${binding.target}}`
    else resolved[field] = value
  }
  if (variant !== undefined) resolved.variant = variant
  return resolved
}
