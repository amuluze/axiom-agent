const skipWhitespace = (source: string, start: number): number => {
  let index = start
  while (/\s/.test(source[index] ?? '')) index += 1
  return index
}

const readStringEnd = (source: string, start: number): number => {
  if (source[start] !== '"') throw new Error('Expected JSON string')
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') return index + 1
  }
  throw new Error('Unterminated JSON string')
}

const skipValue = (source: string, start: number): number => {
  const first = source[start]
  if (first === '"') return readStringEnd(source, start)
  if (first !== '{' && first !== '[') {
    let index = start
    while (index < source.length && !/[\s,}\]]/.test(source[index] ?? '')) index += 1
    return index
  }

  const stack = [first]
  let index = start + 1
  while (index < source.length && stack.length > 0) {
    const char = source[index]
    if (char === '"') {
      index = readStringEnd(source, index)
      continue
    }
    if (char === '{' || char === '[') stack.push(char)
    if (char === '}' || char === ']') {
      const open = stack.pop()
      if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) {
        throw new Error('Mismatched JSON delimiter')
      }
    }
    index += 1
  }
  if (stack.length > 0) throw new Error('Unterminated JSON value')
  return index
}

const findRootArray = (source: string, property: string): number => {
  let index = skipWhitespace(source, 0)
  if (source[index] !== '{') throw new Error('Expected root JSON object')
  index += 1

  while (index < source.length) {
    index = skipWhitespace(source, index)
    if (source[index] === '}') break
    const keyStart = index
    const keyEnd = readStringEnd(source, keyStart)
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string
    index = skipWhitespace(source, keyEnd)
    if (source[index] !== ':') throw new Error('Expected JSON property separator')
    index = skipWhitespace(source, index + 1)
    if (key === property) {
      if (source[index] !== '[') throw new Error(`Expected ${property} to be an array`)
      return index
    }
    index = skipWhitespace(source, skipValue(source, index))
    if (source[index] === ',') index += 1
  }

  throw new Error(`Missing root property: ${property}`)
}

interface ArrayEntry {
  start: number
  end: number
  comma: number | null
}

export const removeRootJsonArrayItem = (source: string, property: string, itemIndex: number): string => {
  const arrayStart = findRootArray(source, property)
  const entries: ArrayEntry[] = []
  let index = skipWhitespace(source, arrayStart + 1)

  while (source[index] !== ']') {
    const start = index
    const end = skipValue(source, start)
    index = skipWhitespace(source, end)
    const comma = source[index] === ',' ? index : null
    entries.push({ start, end, comma })
    if (comma === null) {
      if (source[index] !== ']') throw new Error('Expected JSON array delimiter')
      break
    }
    index = skipWhitespace(source, comma + 1)
  }

  const entry = entries[itemIndex]
  if (!entry) throw new Error('JSON array item does not exist')
  if (entry.comma !== null) return `${source.slice(0, entry.start)}${source.slice(entry.comma + 1)}`
  if (itemIndex > 0) {
    const previousComma = entries[itemIndex - 1]?.comma
    if (previousComma === null || previousComma === undefined) throw new Error('Missing JSON array delimiter')
    return `${source.slice(0, previousComma)}${source.slice(entry.end)}`
  }
  return `${source.slice(0, entry.start)}${source.slice(entry.end)}`
}
