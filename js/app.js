import * as db from './db.js';
import { totalRemaining } from './lottery.js';

const ANIMATION_MS = 1500;
const $ = (id) => document.getElementById(id);

const el = {
  main: $('main-screen'),
  settings: $('settings-screen'),
  box: $('box'),
  remaining: $('remaining'),
  rank: $('result-rank'),
  name: $('result-name'),
  message: $('message'),
  openSettings: $('open-settings'),
  closeSettings: $('close-settings'),
  list: $('prize-list'),
  addForm: $('add-form'),
  settingsError: $('settings-error'),
};

let state = { prizes: [], lastResult: null };
let ready = false;
let drawing = false; // 抽選ロック

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCount(text) {
  const t = String(text).trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n <= db.MAX_COUNT ? n : null;
}

// ---------- メイン画面 ----------

function renderMain() {
  const total = totalRemaining(state.prizes);
  el.remaining.textContent = ready ? `残り ${total}個` : '';
  if (!drawing) {
    const r = state.lastResult;
    el.rank.textContent = r ? r.rank : '';
    el.name.textContent = r ? r.name : '';
  }
  const empty = ready && total === 0;
  el.box.classList.toggle('empty', empty);
  el.box.disabled = !ready || drawing || empty;
  el.openSettings.disabled = !ready || drawing;
  if (empty && !drawing) setMessage('すべての景品がなくなりました');
}

function setMessage(text, isError = false) {
  el.message.textContent = text;
  el.message.classList.toggle('error', isError);
}

async function refresh() {
  state = await db.getState();
  renderMain();
}

async function onDraw() {
  if (drawing || !ready) return; // 二重抽選防止
  drawing = true; // 1. ロック
  el.box.disabled = true;
  el.openSettings.disabled = true;
  setMessage('');
  try {
    // 2〜5. 当選決定・個数減算・同一トランザクションで保存・成功確認
    const outcome = await db.draw();
    if (outcome.empty) {
      drawing = false;
      await refresh();
      return;
    }
    // 6. 演出
    el.rank.textContent = '';
    el.name.textContent = '';
    el.box.classList.add('shaking');
    await sleep(ANIMATION_MS);
    el.box.classList.remove('shaking');
    // 7. 結果表示
    drawing = false;
    await refresh();
  } catch (e) {
    console.error(e);
    el.box.classList.remove('shaking');
    drawing = false;
    try { await refresh(); } catch (_) { renderMain(); }
    setMessage('保存に失敗しました。抽選は行われていません。', true);
  } finally {
    drawing = false; // 8. ロック解除
    renderMain();
  }
}

// ---------- 設定画面 ----------

function rankOptions(select, selected) {
  select.replaceChildren(...db.RANKS.map((r) => {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r;
    o.selected = r === selected;
    return o;
  }));
}

function renderSettings() {
  el.list.replaceChildren(...state.prizes.map((p) => {
    const li = document.createElement('li');
    li.className = 'prize-row';
    li.dataset.id = p.id;

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'name';
    name.maxLength = 50;
    name.value = p.name;
    name.setAttribute('aria-label', '景品名');
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) { name.value = p.name; showSettingsError('景品名を入力してください'); return; }
      save(p.id, { name: v });
    });

    const controls = document.createElement('div');
    controls.className = 'row-controls';

    const rank = document.createElement('select');
    rank.setAttribute('aria-label', 'ランク');
    rankOptions(rank, p.rank);
    rank.addEventListener('change', () => save(p.id, { rank: rank.value }));

    const count = document.createElement('input');
    count.type = 'text';
    count.inputMode = 'numeric';
    count.pattern = '[0-9]*';
    count.className = 'count';
    count.value = String(p.remaining);
    count.setAttribute('aria-label', '残り個数');
    count.addEventListener('change', () => {
      const n = parseCount(count.value);
      if (n === null) {
        count.value = String(p.remaining);
        showSettingsError(`個数は0〜${db.MAX_COUNT}の整数で入力してください`);
        return;
      }
      save(p.id, { remaining: n });
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn';
    del.textContent = '削除';
    del.addEventListener('click', async () => {
      if (!confirm(`「${p.name}」を削除しますか？`)) return;
      await apply(() => db.deletePrize(p.id));
    });

    controls.append(rank, count, del);
    li.append(name, controls);
    return li;
  }));
}

function showSettingsError(text) {
  el.settingsError.textContent = text;
}

async function apply(op) {
  showSettingsError('');
  try {
    await op();
  } catch (e) {
    console.error(e);
    showSettingsError('保存に失敗しました');
  }
  state = await db.getState();
  renderSettings();
}

function save(id, fields) {
  return apply(() => db.updatePrize(id, fields));
}

el.addForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = el.addForm.elements;
  const name = f.name.value.trim();
  const remaining = parseCount(f.remaining.value);
  if (!name) { showSettingsError('景品名を入力してください'); return; }
  if (remaining === null) { showSettingsError(`個数は0〜${db.MAX_COUNT}の整数で入力してください`); return; }
  await apply(() => db.addPrize({ name, rank: f.rank.value, remaining }));
  if (!el.settingsError.textContent) {
    f.name.value = '';
    f.remaining.value = '1';
  }
});

function openSettings() {
  if (drawing || !ready) return; // 抽選演出中は設定不可
  showSettingsError('');
  renderSettings();
  el.main.hidden = true;
  el.settings.hidden = false;
  window.scrollTo(0, 0);
}

async function closeSettings() {
  // 入力中の欄の変更を確定させる
  if (document.activeElement && el.settings.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  el.settings.hidden = true;
  el.main.hidden = false;
  setMessage('');
  await refresh();
}

// ---------- 起動 ----------

el.box.addEventListener('click', onDraw);
el.openSettings.addEventListener('click', openSettings);
el.closeSettings.addEventListener('click', closeSettings);
rankOptions(el.addForm.elements.rank, '当たり');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ready && !drawing && !el.main.hidden) {
    refresh().catch(() => {});
  }
});

async function start() {
  renderMain();
  try {
    await db.initialize();
    state = await db.getState();
    ready = true;
  } catch (e) {
    console.error(e);
    setMessage('データを読み込めませんでした。端末の保存領域を確認してください。', true);
    return;
  }
  renderMain();
  db.requestPersistence();
}

start();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.error(e));
}
