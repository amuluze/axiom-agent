import { describe, expect, it } from 'vitest'
import {
  backgroundRunCapacityError,
  MAX_CONCURRENT_BACKGROUND_RUNS,
} from './backgroundRunPolicy'

describe('backgroundRunCapacityError', () => {
  it('allows new background runs below the cap', () => {
    for (let running = 0; running < MAX_CONCURRENT_BACKGROUND_RUNS; running += 1) {
      expect(backgroundRunCapacityError(running)).toBeNull()
    }
  })

  it('rejects new background runs at or above the cap with a readable reason', () => {
    for (const running of [MAX_CONCURRENT_BACKGROUND_RUNS, MAX_CONCURRENT_BACKGROUND_RUNS + 1]) {
      const error = backgroundRunCapacityError(running)
      expect(error).toContain('后台会话已达上限')
      expect(error).toContain(String(MAX_CONCURRENT_BACKGROUND_RUNS))
    }
  })
})
