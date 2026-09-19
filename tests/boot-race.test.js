// 起動直後の競合の確認(H4 段階4b の追加調査)。
//   起動時の処理は、(1) DOMContentLoaded の中で同期的に実行される(名簿変更の復旧・児童IDの付与・pfの移行など。この時点では IndexedDB は未準備で、
//   検証付きの削除は「準備後に鏡から消す」一覧 __pendingIdbDeletes に積まれる)。(2) そのあと非同期で IndexedDB を開き、localStorage を鏡へコピーし、
//   キャッシュへ読み込み、最後に flushPendingIdbDeletes で一覧のキーを鏡・キャッシュから消す。
//   競合: 一覧に積まれたキーが、IndexedDB の準備が終わる前に再び書かれる(名簿変更のスナップショットなど)と、flushPendingIdbDeletes が
//   「新しく書かれた値」まで鏡とキャッシュから消してしまい、localStorage にはあるのに StorageManager から見えない状態になっていた。
//   - IndexedDB の準備を遅らせて、その隙間に書き込み → 準備後も localStorage・キャッシュ・鏡が一致していること
//   - 本当に消えたキー(書き直されていない)は、これまでどおり鏡・キャッシュから消えること
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node boot-race.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// IndexedDB(spa_classroom_db)を開く処理の完了通知を DELAY ミリ秒遅らせる(遅い端末・負荷の高い起動を再現する)
const SLOW_IDB = (delay) => {
    const orig = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(name) {
        const req = orig.apply(this, arguments);
        if (name === 'spa_classroom_db') {
            let handler = null;
            Object.defineProperty(req, 'onsuccess', { configurable: true, get() { return handler; }, set(fn) { handler = fn; req.addEventListener('success', (e) => { setTimeout(() => fn && fn.call(req, e), delay); }); } });
        }
        return req;
    };
};

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const idbAll = () => page.evaluate(() => new Promise((res) => { const q = indexedDB.open('spa_classroom_db'); q.onsuccess = (e) => { const db = e.target.result; const g = db.transaction('kv', 'readonly').objectStore('kv').getAll(); g.onsuccess = () => { db.close(); const m = {}; g.result.forEach(x => { m[x.key] = x.value; }); res(m); }; }; }));
    const state = (key) => page.evaluate((k) => ({ ls: localStorage.getItem(k), cache: StorageManager.getRaw(k) }), key);

    try {
        // 準備: 端末に「ジャーナルの無いスナップショット」(名簿変更の途中で中断した残り)がある。起動時の復旧が、これを検証付きで削除する。
        await page.evaluate((K) => {
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            StorageManager.setImmediate(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1 }, students: [{ studentId: 'stu_race0001', name: '甲' }] }));
            StorageManager.setImmediate(K.roster_snapshot, JSON.stringify({ v: 1, txnId: 'old', keys: {} }));
            StorageManager.setImmediate('spa_race_other', 'unrelated');
        }, K);
        await page.evaluate(() => storageIdbFlush());

        // ---------- 1. 通常の起動(競合なし)の確認: 起動時に削除された残りは、鏡・キャッシュからも消える ----------
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        let st = await state(K.roster_snapshot);
        let idb = await idbAll();
        check('通常の起動: 残っていたスナップショットは起動時に削除され、localStorage・キャッシュ・鏡のどれにも無い', st.ls === null && st.cache === null && idb[K.roster_snapshot] === undefined, JSON.stringify({ st, inIdb: idb[K.roster_snapshot] !== undefined }));

        // ---------- 2. IndexedDB の準備が遅い起動で、準備の前に同じキーが書き直される ----------
        await page.evaluate((K) => { StorageManager.setImmediate(K.roster_snapshot, JSON.stringify({ v: 1, txnId: 'orphan', keys: {} })); }, K); // また残りを作る
        await page.evaluate(() => storageIdbFlush());
        const id = await page.evaluateOnNewDocument(SLOW_IDB, 800);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof StorageManager !== 'undefined' && typeof storageVerifiedWrite === 'function' && document.readyState !== 'loading');
        await sleep(150); // DOMContentLoaded の同期処理(復旧による削除)は終わっている。IndexedDB の準備はまだ(約800ms後)
        const early = await page.evaluate((K) => ({ ready: !!StorageManager._idb, cacheLoaded: StorageManager._cacheLoaded, ls: localStorage.getItem(K.roster_snapshot), pending: (window.__pendingIdbDeletes || []).slice() }), K);
        check('前提: IndexedDB の準備前で、起動時の削除(残りのスナップショット)が「準備後に鏡から消す」一覧にある', !early.ready && !early.cacheLoaded && early.ls === null && early.pending.indexOf(K.roster_snapshot) !== -1, JSON.stringify(early));
        // 準備の前に、同じキーへ新しい値が書かれる(名簿変更のスナップショットなど。ここでは検証付き書き込みで再現)
        const NEW = JSON.stringify({ v: 1, txnId: 'fresh-during-boot', keys: {} });
        await page.evaluate((K, v) => { storageVerifiedWrite(K.roster_snapshot, v); }, K, NEW);
        await sleep(1800); // IndexedDB の準備 → 鏡へのコピー → キャッシュ読み込み → 削除の一覧の処理
        const late = await page.evaluate((K) => ({ ready: !!StorageManager._idb, cacheLoaded: StorageManager._cacheLoaded, ls: localStorage.getItem(K.roster_snapshot), cache: StorageManager.getRaw(K.roster_snapshot) }), K);
        idb = await idbAll();
        check('準備後: localStorage に新しい値がある', late.cacheLoaded && late.ls === NEW, JSON.stringify(late).slice(0, 160));
        check('準備後: キャッシュ(StorageManager から見える値)も新しい値のまま(消されない)', late.cache === NEW, String(late.cache).slice(0, 80));
        check('準備後: IndexedDB の鏡にも新しい値がある(localStorage と一致する)', idb[K.roster_snapshot] === NEW, String(idb[K.roster_snapshot]).slice(0, 80));
        await page.removeScriptToEvaluateOnNewDocument(id.identifier);

        // ---------- 3. 書き直されなかったキーは、これまでどおり消える ----------
        await page.evaluate((K) => { StorageManager.setImmediate(K.roster_snapshot, JSON.stringify({ v: 1, txnId: 'orphan2', keys: {} })); }, K);
        await page.evaluate(() => storageIdbFlush());
        const id2 = await page.evaluateOnNewDocument(SLOW_IDB, 800);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof StorageManager !== 'undefined' && document.readyState !== 'loading');
        await sleep(1900);
        st = await state(K.roster_snapshot); idb = await idbAll();
        check('遅い起動でも、書き直されなかった残りは準備後に鏡・キャッシュから消える(これまでどおり)', st.ls === null && st.cache === null && idb[K.roster_snapshot] === undefined, JSON.stringify({ st, inIdb: idb[K.roster_snapshot] !== undefined }));
        check('無関係のキーは影響を受けない', (await state('spa_race_other')).cache === 'unrelated' && idb['spa_race_other'] === 'unrelated', '');
        await page.removeScriptToEvaluateOnNewDocument(id2.identifier);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== boot-race: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
