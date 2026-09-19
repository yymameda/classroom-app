// 単体ページ pf.html の暫定ガード(H4 段階4b の安全策・4e の前倒しの最小版)。
//   - 新方式(記録のキー=児童ID)のデータがある端末で pf.html を開いても、localStorage・IndexedDB に一切書き込まず、
//     「アプリ内の新体力テストタブを使ってください」という案内だけを表示する(全キーが1バイトも変わらない)
//   - 旧方式の端末・データなしの端末では、これまでどおり使える(ガードは働かない)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(環境変数 PF_BASE で変更可)
// 実行: cd tests && node pf-guard.test.js

const puppeteer = require('puppeteer-core');

const BASE = process.env.PF_BASE || 'http://localhost:8123/';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 書き込みの監視(ページのスクリプトより前に差し込む)。書き換え不可にして、ページ側が差し替えても監視が残るようにする。
const SPY = () => {
    window.__w = { ls: 0, idb: 0, open: 0, log: [] };
    const lock = (proto, name, wrap) => { const o = proto[name]; Object.defineProperty(proto, name, { value: wrap(o), writable: false, configurable: false }); };
    ['setItem', 'removeItem', 'clear'].forEach(n => lock(Storage.prototype, n, (o) => function() { if (this === window.localStorage) { window.__w.ls++; window.__w.log.push('LS.' + n + ':' + arguments[0]); } return o.apply(this, arguments); }));
    ['put', 'add', 'delete', 'clear'].forEach(n => lock(IDBObjectStore.prototype, n, (o) => function() { window.__w.idb++; window.__w.log.push('IDB.' + n); return o.apply(this, arguments); }));
    lock(IDBFactory.prototype, 'open', (o) => function() { window.__w.open++; window.__w.log.push('IDB.open'); return o.apply(this, arguments); });
};

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const main = await browser.newPage();
    let dialogs = 0;
    main.on('dialog', d => { dialogs++; d.dismiss(); });
    let probeDialogs = 0; // 直接呼んだ関数(confirmClearData など)が出したもの。ガードが自分で出すダイアログは 0 であること(dialogs)
    await main.goto(BASE + 'index.html', { waitUntil: 'networkidle0' });
    await sleep(300);
    const realBackup = await main.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });

    // 端末の状態を作る(localStorage と IndexedDB の鏡の両方)
    async function seed(map) {
        await main.evaluate((map) => {
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            Object.keys(map).forEach(k => StorageManager.setImmediate(k, map[k]));
        }, map);
        await main.evaluate(() => storageIdbFlush());
        await sleep(200);
    }
    // localStorage と IndexedDB(kv)の全内容
    const dump = (pg) => pg.evaluate(() => new Promise((res) => {
        const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
        try {
            const q = indexedDB.open('spa_classroom_db');
            q.onupgradeneeded = (e) => { try { e.target.transaction.abort(); } catch (_) {} };
            q.onsuccess = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains('kv')) { db.close(); res({ ls, idb: {} }); return; } const g = db.transaction('kv', 'readonly').objectStore('kv').getAll(); g.onsuccess = () => { db.close(); const m = {}; g.result.forEach(x => { m[x.key] = x.value; }); res({ ls, idb: m }); }; };
            q.onerror = () => res({ ls, idb: {} });
        } catch (e) { res({ ls, idb: {} }); }
    }));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const S = (n) => 'stu_' + String(n).padStart(8, '0');
    const roster1 = JSON.stringify([{ id: 1, name: '甲', gender: '男', age: 10 }, { id: 2, name: '乙', gender: '女', age: 10 }]);
    const rosterV2 = JSON.stringify([{ id: 1, studentId: S(0), name: '甲', gender: '男', age: 10 }, { id: 2, studentId: S(1), name: '乙', gender: '女', age: 10 }]);
    const recV1 = JSON.stringify({ 1: { 握力: 20 }, 2: { 握力: 22 } });
    const recV2 = JSON.stringify({ [S(0)]: { 握力: 20 }, [S(1)]: { 握力: 22 } });
    const setting = JSON.stringify({ year: 2026, grade: 5, className: '5年1組' });
    const base = { spa_master: JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1 }, students: [{ studentId: S(0), name: '甲' }, { studentId: S(1), name: '乙' }] }), pf_setting: setting };
    const V2_CASES = [
        ['新方式(名簿に児童ID・記録も児童IDのキー・集計あり)', { pf_roster: rosterV2, pf_records_2026: recV2, pf_records_2025: recV2, pf_fitness_2026: recV2, migration_pfStudentId_v1: JSON.stringify({ at: '2026-09-19T00:00:00.000Z', records: 2 }) }],
        ['名簿は旧方式の形だが、記録のキーが児童ID(新旧混在)', { pf_roster: roster1, pf_records_2026: recV2 }],
        ['集計だけが児童IDのキー', { pf_roster: roster1, pf_fitness_2026: recV2 }],
        ['名簿に児童IDがあり、記録なし', { pf_roster: rosterV2 }],
        ['手入力の児童(pfm_)だけの記録', { pf_roster: roster1, pf_records_2026: JSON.stringify({ pfm_abcd1234: { 握力: 5 } }) }],
        ['移行の完了の印だけがある', { migration_pfStudentId_v1: JSON.stringify({ at: '2026-09-19T00:00:00.000Z', records: 0 }) }]
    ];

    try {
        // ================= 1. 新方式の端末: 案内だけを表示し、何も書かない =================
        console.log('--- 1. 新方式の端末で pf.html を開く ---');
        for (const [label, pf] of V2_CASES) {
            await seed(Object.assign({}, base, pf));
            const pre = await dump(main);
            // (1) 監視つきで開く
            const pg = await browser.newPage();
            pg.on('dialog', d => { dialogs++; d.dismiss(); });
            const errs = []; pg.on('pageerror', e => errs.push(e.message));
            await pg.evaluateOnNewDocument(SPY);
            await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' });
            await sleep(500);
            const ui = await pg.evaluate(() => ({ notice: !!document.getElementById('pfGuardNotice'), text: document.body.textContent, grid: !!document.getElementById('inputGridWrap'), tabs: document.querySelectorAll('.tab-btn, .subnav-btn, [onclick*="switchView"]').length, link: (document.querySelector('#pfGuardNotice a') || {}).getAttribute && document.querySelector('#pfGuardNotice a').getAttribute('href'), linkH: document.querySelector('#pfGuardNotice a') ? document.querySelector('#pfGuardNotice a').getBoundingClientRect().height : 0, inputs: document.querySelectorAll('input, textarea, select').length, w: window.__w }));
            check('[' + label + '] 案内だけが表示される(「アプリ内の新体力テストタブを使ってください」)。名簿・入力欄・タブは無い', ui.notice && ui.text.indexOf('アプリ内の新体力テストタブを使ってください') !== -1 && !ui.grid && ui.inputs === 0, JSON.stringify({ notice: ui.notice, grid: ui.grid, inputs: ui.inputs }));
            check('[' + label + '] 案内に「記録は何も変えていません」の説明と、アプリを開くリンク(44px以上)がある', ui.text.indexOf('記録は何も変えていません') !== -1 && ui.link === './index.html' && ui.linkH >= 44, JSON.stringify({ link: ui.link, h: ui.linkH }));
            check('[' + label + '] 開いている間、localStorage・IndexedDB への書き込み・削除・DBを開く操作が0回(監視で確認)', ui.w.ls === 0 && ui.w.idb === 0 && ui.w.open === 0, JSON.stringify(ui.w));
            const mid = await dump(main);
            check('[' + label + '] 開いたあと、localStorage と IndexedDB の全キーが1バイトも変わらない', same(pre, mid), Object.keys(mid.ls).filter(k => pre.ls[k] !== mid.ls[k]).join(','));
            check('[' + label + '] ページの処理が止まっている(以降のスクリプトは動かず、入力欄も作られない)', errs.some(m => /pf\.html guard/.test(m)), errs.join('|').slice(0, 100));
            await pg.close();
            // (2) 監視なしで開き、書き込みの関数と直接の書き込みを試みても、何も変わらない(二重の防御)
            const pg2 = await browser.newPage();
            pg2.on('dialog', d => { probeDialogs++; d.dismiss(); }); // 呼ばれた関数が confirm を出しても、ページが止まらないようにする(件数は数える)
            await pg2.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' });
            await sleep(400);
            const tried = await pg2.evaluate(async () => {
                const t = [];
                const attempt = (name, f) => { try { f(); t.push(name + ':ok'); } catch (e) { t.push(name + ':' + (e && e.name)); } };
                ['saveAll', 'saveSetting', 'loadFromSpa', 'applyManualRoster', 'clearRoster', 'confirmClearData', 'transferToSpa'].forEach(n => attempt(n, () => window[n]()));
                attempt('pfRemoveKey', () => window.pfRemoveKey('pf_roster'));
                attempt('setRecord', () => window.setRecord(1, '握力', '30'));
                attempt('ls.setItem', () => localStorage.setItem('zz_probe', '1'));
                attempt('ls.removeItem', () => localStorage.removeItem('pf_roster'));
                attempt('ls.clear', () => localStorage.clear());
                attempt('idb.open', () => { const r = indexedDB.open('spa_classroom_db'); r.onsuccess = (e) => { const db = e.target.result; try { db.transaction('kv', 'readwrite').objectStore('kv').delete('pf_roster'); } catch (_) {} }; });
                await new Promise(r => setTimeout(r, 300));
                return t;
            });
            await sleep(300);
            const post = await dump(main);
            check('[' + label + '] 書き込みの関数(保存・名簿の読み込み・削除など)や直接の書き込み・削除を試みても、全キーが1バイトも変わらない', same(pre, post), Object.keys(post.ls).concat(Object.keys(pre.ls)).filter(k => pre.ls[k] !== post.ls[k]).join(',') + ' / ' + tried.join(','));
            await pg2.close();
        }

        // ================= 2. 旧方式・データなしの端末: これまでどおり使える =================
        console.log('--- 2. 旧方式・データなしの端末(ガードは働かない) ---');
        const LEGACY = [
            ['旧方式(名簿・記録・集計のキーが位置番号)', { pf_roster: roster1, pf_records_2026: recV1, pf_fitness_2026: recV1 }],
            ['新体力テストのデータなし', {}],
            ['名簿だけ(旧方式)', { pf_roster: roster1 }],
            ['名簿が壊れている', { pf_roster: '{broken' }]
        ];
        for (const [label, pf] of LEGACY) {
            await seed(Object.assign({}, base, pf));
            const pre = await dump(main);
            const pg = await browser.newPage();
            pg.on('dialog', d => { dialogs++; d.dismiss(); });
            const errs = []; pg.on('pageerror', e => errs.push(e.message));
            await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' });
            await sleep(500);
            const ui = await pg.evaluate(() => ({ notice: !!document.getElementById('pfGuardNotice'), grid: !!document.getElementById('inputGridWrap'), guard: window.__PF_GUARD === true, fn: typeof window.saveAll }));
            check('[' + label + '] ガードは働かず、従来の画面(入力欄の領域)が表示される', !ui.notice && !ui.guard && ui.grid && ui.fn === 'function', JSON.stringify(ui));
            check('[' + label + '] 開いただけでは何も書き込まない(従来どおり)・ガードの例外も出ない', same(pre, await dump(main)) && !errs.some(m => /pf\.html guard/.test(m)), errs.join('|').slice(0, 100));
            if (label.indexOf('旧方式(名簿・記録') === 0) {
                // 従来どおり保存できる(旧方式のデータの操作は変えていない)
                await pg.evaluate(() => { records['1'] = { 握力: 31 }; saveAll(); });
                await sleep(200);
                const d = await dump(main);
                check('[' + label + '] 従来どおり保存できる(位置番号のキーに書ける)', JSON.parse(d.ls.pf_records_2026)['1']['握力'] === 31, '');
            }
            await pg.close();
        }
        check('案内・従来の画面を開いただけでは、確認ダイアログは出ない(直接呼んだ関数が出したものは別に数える)', dialogs === 0, 'dialogs=' + dialogs + ' probe=' + probeDialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await main.evaluate((b) => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== pf-guard: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
