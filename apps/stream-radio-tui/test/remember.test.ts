import { describe, expect, test } from 'vitest'
import { sortOf, withSort } from '../src/library/remember'

describe('the remembered sorts', () => {
  const by = { field: 'title', isReversed: false } as const
  test('a playlist named like an Object property has no sort until it is given one', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(sortOf({}, name)).toBeUndefined()
      const sorts = withSort({}, name, by)
      expect(sortOf(sorts, name)).toEqual(by)
      expect(Object.keys(sorts)).toEqual([name])
      expect(sortOf(withSort(sorts, name), name)).toBeUndefined()
    }
  })
})
