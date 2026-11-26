// IndexedDB による端末内保存
import { pickPrize } from './lottery.js';

const DB_NAME = 'omikuji';
const DB_VERSION = 1;

export const RANKS = ['特大当たり', '大当たり', '当たり'];
export const MAX_COUNT = 99; // 個数の選択肢は 0〜MAX_COUNT

const SEED = [
  ['特大当たり', 'アマギフ5万', 1],
  ['特大当たり', 'PC周りのグッズ4万', 1],
  ['特大当たり', 'JTBトラベル4万', 1],
  ['大当たり', 'アマギフ3万', 1],
  ['大当たり', '音楽系2万', 1],
  ['大当たり', 'JTBナイス2万', 1],
  ['大当たり', 'ディズニーペアチケット', 1],
  ['大当たり', '家電2万', 1],
  ['大当たり', '健康グッズ2万', 1],
  ['当たり', 'アマギフ1万', 1],
  ['当たり', 'ユニクロギフト', 1],
  ['当たり', 'カップ麺系', 3],
  ['当たり', '飲み物', 2],
  ['当たり', 'モバイルバッテリー', 1],
  ['当たり', '映画関連', 1],
  ['当たり', '使い捨てカメラ', 1],
  ['当たり', 'お米券', 1],
];

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('prizes')) {
          db.createObjectStore('prizes', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

/**
 * 読み書きトランザクションを実行する。
 * body の中（リクエストのコールバックは step() で包む）で例外が起きたら
 * トランザクションを中止し、全変更を取り消して reject する。
 * トランザクションの完了（＝保存成功）を確認してから resolve する。
 * cancel(v) は変更を取り消したうえで v を返す（エラー扱いにしない）。
 */
async function runTx(storeNames, body) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    let value;
    let failure = null;
    let cancelled = false;
    const abort = () => { try { tx.abort(); } catch (_) { /* 既に終了 */ } };
    const fail = (e) => {
      if (failure || cancelled) return;
      failure = e || new Error('transaction failed');
      abort();
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => (cancelled ? resolve(value) : reject(failure || tx.error || new Error('aborted')));
    const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
    const ctl = {
      step: (fn) => (...args) => {
        if (failure || cancelled) return;
        try { fn(...args); } catch (e) { fail(e); }
      },
      set: (v) => { value = v; },
      cancel: (v) => { value = v; cancelled = true; abort(); },
    };
    try { body(stores, ctl); } catch (e) { fail(e); }
  });
}

/** 初回起動時のみ初期景品を登録（同一トランザクションで初期化済みフラグも保存） */
export function initialize() {
  return runTx(['prizes', 'meta'], ({ prizes, meta }, { step }) => {
    const req = meta.get('initialized');
    req.onsuccess = step(() => {
      if (req.result && req.result.value === true) return;
      SEED.forEach(([rank, name, remaining], order) => {
        prizes.add({ name, rank, remaining, order });
      });
      meta.put({ key: 'initialized', value: true });
    });
  });
}

/** 景品一覧（表示順）と直前の抽選結果を取得 */
export async function getState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['prizes', 'meta'], 'readonly');
    const pReq = tx.objectStore('prizes').getAll();
    const rReq = tx.objectStore('meta').get('lastResult');
    tx.oncomplete = () => {
      const prizes = pReq.result.sort((a, b) => a.order - b.order || a.id - b.id);
      resolve({ prizes, lastResult: rReq.result ? rReq.result.value : null });
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

/**
 * 抽選：残り景品から当選を決定し、残り個数を1減らし、当選結果と共に
 * 同一トランザクションで保存する。保存完了後に結果を返す。
 * 景品がない場合は { empty: true }。失敗時は reject（何も変更されない）。
 */
export function draw() {
  return runTx(['prizes', 'meta'], ({ prizes, meta }, { step, set, cancel }) => {
    const req = prizes.getAll();
    req.onsuccess = step(() => {
      const list = req.result.sort((a, b) => a.order - b.order || a.id - b.id);
      const won = pickPrize(list);
      if (!won) {
        cancel({ empty: true });
        return;
      }
      won.remaining -= 1;
      prizes.put(won);
      const result = { name: won.name, rank: won.rank, drawnAt: Date.now() };
      meta.put({ key: 'lastResult', value: result });
      set({ result });
    });
  });
}

export function addPrize({ name, rank, remaining }) {
  return runTx(['prizes'], ({ prizes }, { step }) => {
    const req = prizes.getAll();
    req.onsuccess = step(() => {
      const order = req.result.reduce((m, p) => Math.max(m, p.order), -1) + 1;
      prizes.add({ name, rank, remaining, order });
    });
  });
}

/** 指定項目のみ変更（残り個数はその時点の残り個数として上書き） */
export function updatePrize(id, fields) {
  return runTx(['prizes'], ({ prizes }, { step }) => {
    const req = prizes.get(id);
    req.onsuccess = step(() => {
      if (!req.result) return;
      prizes.put({ ...req.result, ...fields });
    });
  });
}

export function deletePrize(id) {
  return runTx(['prizes'], ({ prizes }) => {
    prizes.delete(id);
  });
}

/** 端末内データの自動削除リスクを下げる（対応環境のみ） */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist();
    }
  } catch (_) { /* 非対応 */ }
}
