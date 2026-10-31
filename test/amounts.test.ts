import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, exposureBounds } from '../src/amounts.ts';

test('money is exact across asset precisions without IEEE-754 rounding', () => {
  for (const decimals of [0, 6, 8, 18, 24]) {
    const values = decimals === 0 ? ['0', '-1', '12345678901234567890'] : ['0', '-0.1', '12345678901234567890.123456'];
    for (const value of values) assert.equal(formatAmount(parseAmount(value, decimals), decimals), value);
  }
  assert.throws(() => parseAmount('1e-8', 8));
  assert.throws(() => parseAmount('0.000000001', 8));
  assert.equal(parseAmount('-0.00000001', 8), -1n);
});

test('pending buys and sells are bounded independently for every fill combination', () => {
  let combinations = 0;
  for (let p = -4; p <= 4; p++) for (let b = 0; b <= 4; b++) for (let s = 0; s <= 4; s++) {
    const bounds = exposureBounds(BigInt(p), BigInt(b), BigInt(s));
    let peak = 0n;
    for (let fb = 0; fb <= b; fb++) for (let fs = 0; fs <= s; fs++) {
      const value = BigInt(Math.abs(p + fb - fs));
      if (value > peak) peak = value;
      combinations++;
    }
    assert.equal(bounds.peak, peak);
  }
  assert.equal(combinations, 2025);
});
