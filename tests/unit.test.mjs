import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPrize, totalRemaining, randomInt } from '../js/lottery.js';

test('残り個数に比例して抽選される（A3:B2:C1 → 3/6:2/6:1/6）', () => {
  const prizes = [{ name: 'A', remaining: 3 }, { name: 'B', remaining: 2 }, { name: 'C', remaining: 1 }];
  const N = 120000;
  const counts = { A: 0, B: 0, C: 0 };
  for (let i = 0; i < N; i++) counts[pickPrize(prizes).name]++;
  const expected = { A: N * 3 / 6, B: N * 2 / 6, C: N / 6 };
  const chi2 = Object.keys(counts).reduce((s, k) => s + (counts[k] - expected[k]) ** 2 / expected[k], 0);
  // 自由度2、有意水準0.1%の臨界値 13.82
  assert.ok(chi2 < 13.82, `chi2=${chi2} counts=${JSON.stringify(counts)}`);
});

test('乱数の各値が正しい景品に対応する', () => {
  const prizes = [{ name: 'A', remaining: 3 }, { name: 'Z', remaining: 0 }, { name: 'B', remaining: 2 }, { name: 'C', remaining: 1 }];
  const got = [0, 1, 2, 3, 4, 5].map((r) => pickPrize(prizes, () => r).name);
  assert.deepEqual(got, ['A', 'A', 'A', 'B', 'B', 'C']);
});

test('残り0個の景品は当選しない', () => {
  const prizes = [{ name: 'A', remaining: 0 }, { name: 'B', remaining: 5 }, { name: 'C', remaining: 0 }];
  for (let i = 0; i < 5000; i++) assert.equal(pickPrize(prizes).name, 'B');
});

test('景品がなければ null', () => {
  assert.equal(pickPrize([]), null);
  assert.equal(pickPrize([{ name: 'A', remaining: 0 }]), null);
  assert.equal(totalRemaining([{ remaining: 2 }, { remaining: 3 }]), 5);
});

test('randomInt は範囲内', () => {
  for (let i = 0; i < 10000; i++) {
    const v = randomInt(7);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 7);
  }
});
