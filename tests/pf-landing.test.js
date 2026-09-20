// 単体ページ pf.html の案内ページ化(H4 段階4e。v1.53.1 の暫定ガードを置き換えた)。
//   - pf.html は「アプリの新体力テストを使ってください」の案内だけ。スクリプトを持たず、localStorage・IndexedDB を
//     読みも書きもしない(どの状態の端末で開いても全キーが1バイトも変わらない)
//   - 案内どおりに(アプリを開く → 【記録】の「📝 児童の記録」→「🏃 新体力」)操作すると、実際に新体力テストの画面に着く
//   - sw.js のキャッシュ対象には残す／アプリ本体から pf.html への移動・リンクは無い
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(環境変数 PF_BASE で変更可)
// 実行: cd tests && node pf-landing.test.js

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
    ['getItem', 'key', 'setItem', 'removeItem', 'clear'].forEach(n => lock(Storage.prototype, n, (o) => function() { if (this === window.localStorage) { window.__w.ls++; window.__w.log.push('LS.' + n + ':' + arguments[0]); } return o.apply(this, arguments); }));
    ['put', 'add', 'delete', 'clear'].forEach(n => lock(IDBObjectStore.prototype, n, (o) => function() { window.__w.idb++; window.__w.log.push('IDB.' + n); return o.apply(this, arguments); }));
    lock(IDBFactory.prototype, 'open', (o) => function() { window.__w.open++; window.__w.log.push('IDB.open'); return o.apply(this, arguments); });
};

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const main = await browser.newPage();
    let dialogs = 0;
    main.on('dialog', d => { dialogs++; d.dismiss(); });
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

    // 端末の状態(新方式6種・旧方式・データなし・壊れた名簿)。どの状態でも案内ページは同じ動きをする
    const LEGACY = [
        ['旧方式(名簿・記録・集計のキーが位置番号)', { pf_roster: roster1, pf_records_2026: recV1, pf_fitness_2026: recV1 }],
        ['新体力テストのデータなし', {}],
        ['名簿だけ(旧方式)', { pf_roster: roster1 }],
        ['名簿が壊れている', { pf_roster: '{broken' }]
    ];
    const ALL_CASES = V2_CASES.concat(LEGACY);

    try {
        // ================= 1. どの状態の端末でも、案内だけを表示し、読みも書きもしない =================
        console.log('--- 1. 案内ページを開く(全状態) ---');
        for (const [label, pf] of ALL_CASES) {
            await seed(Object.assign({}, base, pf));
            const pre = await dump(main);
            const pg = await browser.newPage();
            pg.on('dialog', d => { dialogs++; d.dismiss(); });
            const errs = []; pg.on('pageerror', e => errs.push(e.message));
            await pg.evaluateOnNewDocument(SPY);
            const resp = await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' });
            await sleep(400);
            const ui = await pg.evaluate(() => {
                const a = document.getElementById('pfOpenApp');
                return {
                    landing: !!document.getElementById('pfLanding'), text: document.body.textContent,
                    scripts: document.scripts.length, controls: document.querySelectorAll('input, textarea, select, button').length,
                    link: a && a.getAttribute('href'), linkH: a ? a.getBoundingClientRect().height : 0, linkW: a ? a.getBoundingClientRect().width : 0,
                    w: window.__w, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
                };
            });
            check('[' + label + '] 200 で開け、案内が表示される(「アプリ内の新体力テストの画面を使ってください」)', resp.status() === 200 && ui.landing && ui.text.indexOf('アプリ内の新体力テストの画面を使ってください') !== -1, resp.status() + ' ' + ui.landing);
            check('[' + label + '] 案内に、行き先(【記録】の「📝」→「🏃 新体力」)と、アプリを開くリンク(44px以上)がある', ui.text.indexOf('【記録】') !== -1 && ui.text.indexOf('児童の記録') !== -1 && ui.text.indexOf('🏃 新体力') !== -1 && ui.link === './index.html' && ui.linkH >= 44 && ui.linkW >= 44, JSON.stringify({ link: ui.link, h: ui.linkH }));
            check('[' + label + '] スクリプト・入力欄・ボタンが無い(旧データの読み書き処理は残っていない)・横にはみ出さない', ui.scripts === 0 && ui.controls === 0 && !ui.overflowX && errs.length === 0, JSON.stringify({ scripts: ui.scripts, controls: ui.controls, overflowX: ui.overflowX, errs }));
            check('[' + label + '] 開いている間、localStorage の読み書き・IndexedDB の操作が0回(監視で確認)', ui.w.ls === 0 && ui.w.idb === 0 && ui.w.open === 0, JSON.stringify(ui.w));
            const post = await dump(main);
            check('[' + label + '] 開いたあと、localStorage と IndexedDB の全キーが1バイトも変わらない', same(pre, post), Object.keys(post.ls).concat(Object.keys(pre.ls)).filter(k => pre.ls[k] !== post.ls[k]).join(','));
            await pg.close();
        }

        // ================= 2. 案内どおりに操作すると、実際に新体力テストの画面に着く =================
        console.log('--- 2. 案内どおりの操作(リンク → 📝児童の記録 → 🏃新体力) ---');
        for (const [label, pf] of [ALL_CASES[0], ALL_CASES[ALL_CASES.length - 4]]) {
            await seed(Object.assign({}, base, pf));
            const pre = await dump(main);
            const pg = await browser.newPage();
            pg.on('dialog', d => { dialogs++; d.dismiss(); });
            await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' });
            await Promise.all([pg.waitForNavigation({ waitUntil: 'networkidle0' }), pg.click('#pfOpenApp')]);
            await sleep(600);
            const app = await pg.evaluate(() => ({ url: location.pathname, hasApp: typeof showView === 'function' }));
            check('[' + label + '] 「アプリを開く」を押すと、アプリ本体(index.html)が開く', /index\.html$/.test(app.url) && app.hasApp, JSON.stringify(app));
            // 案内の語が実際の画面の表示と一致する(【記録】のグループ・📝のボタンの名前・「🏃 新体力」のボタンの文字)
            const words = await pg.evaluate(() => ({
                group: Array.from(document.querySelectorAll('.nav-group-label')).some(e => e.textContent.trim() === '【記録】'),
                navName: (document.getElementById('nav-records') || {}).getAttribute ? document.getElementById('nav-records').getAttribute('data-tooltip') : null,
                navIcon: document.getElementById('nav-records') && document.getElementById('nav-records').textContent.trim(),
                sub: Array.from(document.querySelectorAll('.rec-subnav-btn')).map(b => b.textContent.trim())
            }));
            check('[' + label + '] 案内の語が画面と一致(【記録】のグループ・「📝」の名前が児童の記録・上の行に「🏃 新体力」)', words.group && words.navName === '児童の記録' && words.navIcon === '📝' && words.sub.indexOf('🏃 新体力') !== -1, JSON.stringify(words));
            await pg.click('#nav-records'); await sleep(400);
            const btn = await pg.evaluateHandle(() => Array.from(document.querySelectorAll('.rec-subnav-btn')).find(b => b.textContent.trim() === '🏃 新体力'));
            await btn.asElement().click(); await sleep(600);
            const reached = await pg.evaluate(() => { const v = document.getElementById('view-pf'); return { active: !!v && v.classList.contains('active'), shown: !!v && v.getBoundingClientRect().height > 100, title: (document.querySelector('#view-pf h2') || {}).textContent }; });
            check('[' + label + '] 案内どおりにタップすると、新体力テストの画面が表示される', reached.active && reached.shown && /新体力テスト/.test(reached.title || ''), JSON.stringify(reached));
            await pg.close();
            // アプリを開いて移動しただけでは、新体力テストの記録は変わらない(pf_* の値が同じ)
            const post = await dump(main);
            const pfKeys = Object.keys(pre.ls).filter(k => /^pf_(roster|records|fitness)/.test(k));
            check('[' + label + '] 案内→アプリ→新体力テスト画面を開いただけで、新体力テストの記録・名簿(pf_roster/pf_records/pf_fitness)は変わらない(起動時の自動移行が働く旧方式の端末を除く)', label.indexOf('旧方式(名簿・記録') === 0 ? true : pfKeys.every(k => pre.ls[k] === post.ls[k]), pfKeys.filter(k => pre.ls[k] !== post.ls[k]).join(','));
        }

        // ================= 3. 中身と、ほかのファイルとの整合 =================
        console.log('--- 3. ソースと整合 ---');
        const get = async (f) => { const r = await main.evaluate(async (u) => (await fetch(u, { cache: 'no-store' })).text(), BASE + f); return r; };
        const pfSrc = await get('pf.html'), sw = await get('sw.js'), idx = await get('index.html');
        check('pf.html のソースに <script>・localStorage・indexedDB・pf_ のキー名・暫定ガードの名前が無い', !/<script/i.test(pfSrc) && !/localStorage|sessionStorage|indexedDB|StorageManager|pf_roster|pf_records|pf_fitness|__PF_GUARD/.test(pfSrc), '');
        check('pf.html のソースは短い案内だけ(100行未満)', pfSrc.split('\n').length < 100, pfSrc.split('\n').length + '行');
        check('sw.js のキャッシュ対象に ./pf.html が残っている(古いブックマークが開ける)・./index.html もある', /'\.\/pf\.html'/.test(sw) && /'\.\/index\.html'/.test(sw), '');
        const links = idx.split('\n').filter(l => /(href|location|window\.open|src)\s*[=(]?\s*['"`][^'"`]*pf\.html/.test(l));
        check('アプリ本体(index.html)から pf.html へのリンク・移動は無い(コメント・診断の文言だけ)', links.length === 0, links.join(' | ').slice(0, 200));
        check('案内ページを開いただけでは、確認ダイアログは出ない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await main.evaluate((b) => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== pf-landing: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
