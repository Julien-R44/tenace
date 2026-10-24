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
      ['250 milliseconds', 250],
      ['2 msecs', 2],
      ['1MS', 1],
      ['10 seconds', 10_000],
      ['10 s', 10_000],
      ['1sec', 1000],
      ['3 mins', 180_000],
      ['2.5 hrs', 9_000_000],
      ['2 days', 172_800_000],
      ['2 weeks', 1_209_600_000],
      ['2W', 1_209_600_000],
      ['1 year', 31_557_600_000],
      ['2 yrs', 63_115_200_000],
      ['100', 100],
      ['.5', 0.5],
      ['0s', 0],
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
      ' 1s',
      '1s ',
      '-1s',
      '-1 second',
      '-1',
      '0x10ms',
      '1e400ms',
      '1e305d',
      '9'.repeat(400) + ' years',
      '1 month',
      '1h30m',
      '.s',
      's',
    ])
    .run(({ assert }, input) => {
      assert.throws(() => toMs(input as Duration), RangeError)
    })
})
