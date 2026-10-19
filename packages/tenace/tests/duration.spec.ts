import { test } from '@japa/runner'

import { type Duration, toMs } from '../src/duration.ts'

test.group('toMs', () => {
  test('converts {0} to {1}ms')
    .with<[Duration, number][]>([
      [0, 0],
      [250, 250],
      ['250ms', 250],
      ['1s', 1000],
      ['1.5s', 1500],
      ['.5s', 500],
      ['2m', 120_000],
      ['1h', 3_600_000],
      ['1d', 86_400_000],
      ['1e3ms', 1000],
      ['1.5E1s', 15_000],
      ['+1s', 1000],
      ['5.s', 5000],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    ])
    .run(({ assert }, [input, expected]) => {
      assert.equal(toMs(input), expected)
    })

  test('rejects {0}')
    .with([
      -1,
      Number.NaN,
      '',
      'abc',
      '1',
      '10 s',
      ' 1s',
      '-1s',
      '0x10ms',
      '1e400ms',
      '1e305d',
      '1MS',
      '1sec',
      '.s',
      's',
    ])
    .run(({ assert }, input) => {
      assert.throws(() => toMs(input as Duration), RangeError)
    })
})
