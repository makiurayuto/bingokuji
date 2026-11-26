// 箱くじ方式の抽選ロジック（DOM・DBに依存しない純粋関数）

/** 残り個数の合計 */
export function totalRemaining(prizes) {
  return prizes.reduce((sum, p) => sum + p.remaining, 0);
}

/** 0 以上 max 未満の一様な整数（暗号学的乱数・剰余バイアスなし） */
export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

/**
 * 残り個数に比例した確率で景品を1つ選ぶ。残り0個の景品は選ばれない。
 * 景品がなければ null を返す。
 */
export function pickPrize(prizes, rand = randomInt) {
  const total = totalRemaining(prizes);
  if (total <= 0) return null;
  let r = rand(total);
  for (const p of prizes) {
    if (p.remaining <= 0) continue;
    if (r < p.remaining) return p;
    r -= p.remaining;
  }
  return null;
}
