// ブラウザ（Chromium / Playwright）による結合テスト
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const PORT = 8765;
const URL = `http://localhost:${PORT}/`;
const SHOT_DIR = process.env.SHOT_DIR || '';

const SEED_TOTAL = 20;

// IndexedDB の書き込み失敗を注入する（window.__failWrites = 'throw' | 'abort'）
const INJECT = `(() => {
  const orig = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...a) {
    if (window.__failWrites === 'throw') throw new DOMException('injected', 'UnknownError');
    const r = orig.apply(this, a);
    if (window.__failWrites === 'abort') this.transaction.abort();
    return r;
  };
})();`;

async function launch(dir, opts = {}) {
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 390, height: 844 }, ...opts });
  await ctx.addInitScript(INJECT);
  return ctx;
}

async function open(ctx) {
  const page = ctx.pages()[0] || await ctx.newPage();
  if (!page.__wired) {
    page.__wired = true;
    page.on('pageerror', (e) => console.error('pageerror', e));
    page.on('dialog', (d) => d.accept());
  }
  await page.goto(URL);
  await page.waitForFunction(() => /残り/.test(document.getElementById('remaining').textContent));
  return page;
}

const readDB = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('omikuji');
  req.onsuccess = () => {
    const tx = req.result.transaction(['prizes', 'meta'], 'readonly');
    const p = tx.objectStore('prizes').getAll();
    const r = tx.objectStore('meta').get('lastResult');
    const i = tx.objectStore('meta').get('initialized');
    tx.oncomplete = () => {
      const prizes = p.result.sort((a, b) => a.order - b.order);
      req.result.close();
      resolve({
        prizes,
        total: prizes.reduce((s, x) => s + x.remaining, 0),
        lastResult: r.result ? r.result.value : null,
        initialized: i.result ? i.result.value : null,
      });
    };
  };
  req.onerror = () => reject(req.error);
}));

const shownTotal = async (page) => Number((await page.textContent('#remaining')).match(/\d+/)[0]);

async function drawOnce(page) {
  await page.click('#box');
  await page.waitForFunction(() => {
    const box = document.getElementById('box');
    return !box.classList.contains('shaking') && !document.getElementById('open-settings').disabled;
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omikuji-'));

const tests = [];
const t = (name, fn) => tests.push({ name, fn });

// ------------------------------------------------------------------

t('初回起動時に20個の景品が登録される', async () => {
  const ctx = await launch(tmp());
  const page = await open(ctx);
  const s = await readDB(page);
  assert.equal(s.prizes.length, 17);
  assert.equal(s.total, SEED_TOTAL);
  assert.equal(s.initialized, true);
  const byRank = {};
  for (const p of s.prizes) byRank[p.rank] = (byRank[p.rank] || 0) + p.remaining;
  assert.deepEqual(byRank, { '特大当たり': 3, '大当たり': 6, '当たり': 11 });
  assert.equal(await shownTotal(page), 20);
  assert.equal(await page.textContent('#result-name'), '');
  await ctx.close();
});

t('抽選ごとに1個減り、20回で全てなくなり、それ以上は抽選できない', async () => {
  const ctx = await launch(tmp());
  const page = await open(ctx);
  const initial = Object.fromEntries((await readDB(page)).prizes.map((p) => [p.name, p.remaining]));
  const won = {};
  for (let i = 1; i <= 20; i++) {
    const before = await readDB(page);
    await drawOnce(page);
    const s = await readDB(page);
    assert.equal(s.total, SEED_TOTAL - i);
    assert.equal(await shownTotal(page), SEED_TOTAL - i);
    // 当選した景品は抽選前に在庫があったもの
    const prev = before.prizes.find((p) => p.name === s.lastResult.name);
    assert.ok(prev.remaining > 0, '在庫0の景品が当選した');
    assert.equal(await page.textContent('#result-rank'), s.lastResult.rank);
    assert.equal(await page.textContent('#result-name'), s.lastResult.name);
    won[s.lastResult.name] = (won[s.lastResult.name] || 0) + 1;
  }
  assert.deepEqual(won, initial, '当選回数が初期個数と一致しない');
  assert.equal(await page.textContent('#message'), 'すべての景品がなくなりました');
  assert.equal(await page.isDisabled('#box'), true);
  // 強制的にクリックイベントを送っても抽選されない
  await page.evaluate(() => { const b = document.getElementById('box'); b.disabled = false; b.click(); });
  await page.waitForTimeout(300);
  assert.equal((await readDB(page)).total, 0);
  await ctx.close();
});

t('連打しても二重抽選されない', async () => {
  const ctx = await launch(tmp());
  const page = await open(ctx);
  await page.evaluate(() => { const b = document.getElementById('box'); for (let i = 0; i < 10; i++) b.click(); });
  for (let i = 0; i < 5; i++) await page.click('#box', { force: true, noWaitAfter: true }).catch(() => {});
  await page.waitForFunction(() => !document.getElementById('box').classList.contains('shaking'));
  await page.waitForTimeout(300);
  assert.equal((await readDB(page)).total, 19);
  assert.equal(await shownTotal(page), 19);
  await ctx.close();
});

t('再読み込み・ブラウザ再起動後も状態が復元され、初期景品は再登録されない', async () => {
  const dir = tmp();
  let ctx = await launch(dir);
  let page = await open(ctx);
  await drawOnce(page);
  await drawOnce(page);
  const s1 = await readDB(page);
  await page.reload();
  await page.waitForFunction(() => /残り/.test(document.getElementById('remaining').textContent));
  assert.equal(await shownTotal(page), 18);
  assert.equal(await page.textContent('#result-name'), s1.lastResult.name);
  await ctx.close();
  ctx = await launch(dir);
  page = await open(ctx);
  const s2 = await readDB(page);
  assert.equal(s2.total, 18);
  assert.equal(s2.prizes.length, 17);
  assert.deepEqual(s2.lastResult, s1.lastResult);
  assert.equal(await page.textContent('#result-name'), s1.lastResult.name);
  assert.equal(await page.textContent('#result-rank'), s1.lastResult.rank);
  await ctx.close();
});

t('抽選演出中に終了しても結果が失われない／演出中は設定を開けない', async () => {
  const dir = tmp();
  let ctx = await launch(dir);
  let page = await open(ctx);
  await page.click('#box');
  await page.waitForSelector('#box.shaking');
  assert.equal(await page.isDisabled('#open-settings'), true);
  assert.equal(await page.textContent('#result-name'), '');
  const saved = await readDB(page);
  assert.equal(saved.total, 19); // 演出前に保存済み
  await ctx.close(); // 演出中に強制終了
  ctx = await launch(dir);
  page = await open(ctx);
  assert.equal(await shownTotal(page), 19);
  assert.equal(await page.textContent('#result-name'), saved.lastResult.name);
  await ctx.close();
});

for (const mode of ['throw', 'abort']) {
  t(`保存に失敗した場合は景品が消費されない（${mode}）`, async () => {
    const dir = tmp();
    let ctx = await launch(dir);
    let page = await open(ctx);
    await drawOnce(page);
    const before = await readDB(page);
    await page.evaluate((m) => { window.__failWrites = m; }, mode);
    await drawOnce(page);
    assert.match(await page.textContent('#message'), /保存に失敗しました/);
    const after = await readDB(page);
    assert.deepEqual(after, before);
    assert.equal(await shownTotal(page), 19);
    assert.equal(await page.textContent('#result-name'), before.lastResult.name);
    await page.evaluate(() => { window.__failWrites = null; });
    await drawOnce(page); // 復旧後は正常に抽選できる
    assert.equal((await readDB(page)).total, 18);
    await ctx.close();
  });
}

t('抽選途中でも景品の追加・変更・削除ができ、変更後も正しく抽選できる', async () => {
  const ctx = await launch(tmp());
  const page = await open(ctx);
  for (let i = 0; i < 3; i++) await drawOnce(page);
  const s0 = await readDB(page);
  await page.click('#open-settings');
  const rows = page.locator('#prize-list .prize-row');
  assert.equal(await rows.count(), 17);
  // 消費済みの個数が設定画面で残り個数として表示される
  for (let i = 0; i < 17; i++) {
    assert.equal(await rows.nth(i).locator('.count').inputValue(), String(s0.prizes[i].remaining));
  }
  const row = (name) => page.locator(`#prize-list [data-id="${s0.prizes.find((p) => p.name === name).id}"]`);

  // 名前変更
  await row('飲み物').locator('.name').fill('お茶');
  await row('飲み物').locator('.name').press('Tab');
  // ランク変更
  await row('お米券').locator('select:not(.count)').selectOption('大当たり');
  // 個数変更（その時点の残り個数として）
  await row('カップ麺系').locator('.count').selectOption('5');
  // 個数は選択式で、選択肢は 0〜99 の整数のみ
  const optionValues = await row('映画関連').locator('.count option').evaluateAll((os) => os.map((o) => o.value));
  assert.deepEqual(optionValues, Array.from({ length: 100 }, (_, i) => String(i)));
  assert.equal(await page.locator('#prize-list input.count, #add-form input[name=remaining]').count(), 0, '個数の入力欄が残っている');
  // 万一不正な値が送られても拒否され元に戻る（選択肢を不正に書き換えて確認）
  for (const bad of ['-1', '1.5', 'abc', '100']) {
    const c = row('映画関連').locator('.count');
    const prev = await c.inputValue();
    await c.evaluate((sel, v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.append(o); }, bad);
    await c.selectOption(bad);
    await page.waitForTimeout(100);
    assert.equal(await c.inputValue(), prev, `不正値 "${bad}" が受け付けられた`);
    assert.match(await page.textContent('#settings-error'), /選んでください/);
  }
  // 空の景品名は拒否
  await row('映画関連').locator('.name').fill('  ');
  await row('映画関連').locator('.name').press('Tab');
  assert.equal(await row('映画関連').locator('.name').inputValue(), '映画関連');
  // 削除
  await row('アマギフ5万').locator('button', { hasText: '削除' }).click();
  // 追加
  await page.fill('#add-form [name=name]', 'テスト景品');
  await page.selectOption('#add-form [name=rank]', '特大当たり');
  await page.selectOption('#add-form [name=remaining]', '2');
  await page.click('#add-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#prize-list .prize-row').length === 17);
  // 不正値での追加は拒否
  await page.fill('#add-form [name=name]', 'NG');
  await page.locator('#add-form [name=remaining]').evaluate((sel) => { const o = document.createElement('option'); o.value = '-3'; sel.append(o); });
  await page.selectOption('#add-form [name=remaining]', '-3');
  await page.click('#add-form button[type=submit]');
  await page.waitForTimeout(200);
  await page.click('#close-settings');
  await page.waitForTimeout(200);

  const s1 = await readDB(page);
  const get = (n) => s1.prizes.find((p) => p.name === n);
  assert.equal(get('お茶').remaining, s0.prizes.find((p) => p.name === '飲み物').remaining);
  assert.equal(get('飲み物'), undefined);
  assert.equal(get('お米券').rank, '大当たり');
  assert.equal(get('カップ麺系').remaining, 5);
  assert.equal(get('アマギフ5万'), undefined);
  assert.deepEqual([get('テスト景品').rank, get('テスト景品').remaining], ['特大当たり', 2]);
  assert.equal(get('NG'), undefined);
  assert.equal(s1.prizes[s1.prizes.length - 1].name, 'テスト景品');
  assert.equal(await shownTotal(page), s1.total);

  // 変更後の在庫どおりに引き切れる
  const expect = Object.fromEntries(s1.prizes.filter((p) => p.remaining > 0).map((p) => [p.name, p.remaining]));
  const won = {};
  for (let i = 0; i < s1.total; i++) {
    await drawOnce(page);
    const n = (await readDB(page)).lastResult.name;
    won[n] = (won[n] || 0) + 1;
  }
  assert.deepEqual(won, expect);
  assert.equal(await page.textContent('#message'), 'すべての景品がなくなりました');

  // 在庫0でも個数を増やせば再び抽選できる
  await page.click('#open-settings');
  await page.locator(`[data-id="${get('お茶').id}"] .count`).selectOption('1');
  await page.click('#close-settings');
  await page.waitForFunction(() => !document.getElementById('box').disabled);
  await drawOnce(page);
  assert.equal((await readDB(page)).lastResult.name, 'お茶');
  await ctx.close();
});

t('全景品を削除すると抽選できない', async () => {
  const ctx = await launch(tmp());
  const page = await open(ctx);
  await page.click('#open-settings');
  while (await page.locator('#prize-list .prize-row').count()) {
    const n = await page.locator('#prize-list .prize-row').count();
    await page.locator('#prize-list .prize-row').first().locator('button').click();
    await page.waitForFunction((k) => document.querySelectorAll('#prize-list .prize-row').length === k - 1, n);
  }
  await page.click('#close-settings');
  await page.waitForTimeout(200);
  assert.equal(await page.textContent('#message'), 'すべての景品がなくなりました');
  assert.equal(await page.isDisabled('#box'), true);
  await page.reload();
  await page.waitForTimeout(500);
  assert.equal((await readDB(page)).prizes.length, 0, '再読み込みで初期景品が復活した');
  await ctx.close();
});

t('オフライン（機内モード相当）でも起動・抽選・設定変更・保存ができる', async () => {
  const dir = tmp();
  let ctx = await launch(dir);
  let page = await open(ctx);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => /残り/.test(document.getElementById('remaining').textContent));
  await drawOnce(page);
  await page.click('#open-settings');
  await page.fill('#add-form [name=name]', 'オフライン景品');
  await page.click('#add-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#prize-list .prize-row').length === 18);
  await page.click('#close-settings');
  await page.waitForTimeout(200);
  assert.equal(await shownTotal(page), 20);
  await ctx.close();
  // オフラインのままブラウザ再起動
  ctx = await launch(dir, { offline: true });
  page = await open(ctx);
  const s = await readDB(page);
  assert.equal(s.total, 20);
  assert.ok(s.prizes.some((p) => p.name === 'オフライン景品'));
  assert.ok(s.lastResult);
  await ctx.close();
});

t('PWA：manifest とアイコン、Service Worker が有効', async () => {
  const ctx = await launch(tmp());
  const page = await open(ctx);
  const m = await page.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    const j = await (await fetch(link.href)).json();
    const icons = await Promise.all(j.icons.map(async (i) => (await fetch(i.src)).ok));
    const reg = await navigator.serviceWorker.ready;
    const apple = (await fetch(document.querySelector('link[rel=apple-touch-icon]').href)).ok;
    return { j, icons, active: !!reg.active, apple };
  });
  assert.equal(m.j.display, 'standalone');
  assert.equal(m.j.start_url, './');
  assert.ok(m.j.icons.some((i) => i.sizes === '192x192') && m.j.icons.some((i) => i.sizes === '512x512'));
  assert.ok(m.icons.every(Boolean));
  assert.ok(m.active);
  assert.ok(m.apple);
  await ctx.close();
});

t('スマートフォンの画面から要素がはみ出さない', async () => {
  const targets = [
    ['iPhone SE', devices['iPhone SE']],
    ['iPhone 15', devices['iPhone 15']],
    ['Pixel 7', devices['Pixel 7']],
    ['320px', { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true }],
  ];
  const browser = await chromium.launch();
  for (const [label, dev] of targets) {
    const { defaultBrowserType, ...opts } = dev;
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(INJECT);
    ctx.on('page', (p) => p.on('dialog', (d) => d.accept()));
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.waitForFunction(() => /残り/.test(document.getElementById('remaining').textContent));
    // 長い景品名でもはみ出さないか
    await page.click('#open-settings');
    await page.fill('#add-form [name=name]', 'とても長い景品名のテストとても長い景品名のテストとても長い景品名のテスト');
    await page.selectOption('#add-form [name=remaining]', '99');
    await page.click('#add-form button[type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('#prize-list .prize-row').length === 18);
    const overflowS = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflowS <= 0, `${label} 設定画面が横にはみ出し ${overflowS}px`);
    if (SHOT_DIR && label === 'iPhone 15') await page.screenshot({ path: path.join(SHOT_DIR, 'settings.png') });
    // 長い名前の景品だけ残す
    while (await page.locator('#prize-list .prize-row').count() > 1) {
      const n = await page.locator('#prize-list .prize-row').count();
      await page.locator('#prize-list .prize-row').first().locator('button').click();
      await page.waitForFunction((k) => document.querySelectorAll('#prize-list .prize-row').length === k - 1, n);
    }
    await page.click('#close-settings');
    await page.waitForTimeout(200);
    await page.click('#box');
    await page.waitForFunction(() => document.getElementById('result-name').textContent !== '');
    const box = await page.evaluate(() => {
      const els = ['box', 'remaining', 'result-rank', 'result-name', 'open-settings'].map((id) => document.getElementById(id).getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        maxRight: Math.max(...els.map((r) => r.right)),
        minLeft: Math.min(...els.map((r) => r.left)),
        width: innerWidth,
        btnH: document.getElementById('open-settings').getBoundingClientRect().height,
        maxBottom: Math.max(...els.map((r) => r.bottom)),
        height: innerHeight,
        resultBottom: document.getElementById('result').getBoundingClientRect().bottom,
        boxTop: document.getElementById('box').getBoundingClientRect().top,
      };
    });
    assert.ok(box.overflow <= 0 && box.maxRight <= box.width && box.minLeft >= 0, `${label} メイン画面がはみ出し ${JSON.stringify(box)}`);
    assert.ok(box.btnH >= 44, `${label} ボタンが小さい`);
    assert.ok(box.maxBottom <= box.height, `${label} 縦にはみ出し ${JSON.stringify(box)}`);
    assert.ok(box.resultBottom <= box.boxTop, `${label} 結果が箱の上にない`);
    await ctx.close();
  }
  await browser.close();
});

// ------------------------------------------------------------------

const server = await startServer(PORT);
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`NG - ${name}\n   ${e.stack || e}`);
  }
}
server.close();
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
