// H8: 削除したデータ(特に氏名)が IndexedDB の鏡に残り、あとで復活しないこと。
//
// 背景: StorageManager は localStorage を真実とし、IndexedDB を鏡にしている。起動のたびに migrateFromLS が
// localStorage の全キーを IndexedDB へ上書きコピーし、loadCache が IndexedDB の全キーをメモリキャッシュへ読む。
// **キーの削除は鏡に反映されない**ため、localStorage だけから消したキーが IndexedDB に残り、次回起動でキャッシュに
// 復活し、バックアップ(exportAll はキャッシュのキーを使う)に入り、復元すると localStorage に戻る。
//   (1) 退勤モードの端末データ消去は KEYS の全キーしか消さず、新体力テスト(pf_*)の名簿・記録・旧バックアップが残る。
//   (2) pf の「名簿リセット」「記録データ削除」(index.html 内蔵版と pf.html)は localStorage.removeItem だけ。
//   (3) 過去に(2)で消した pf キーの鏡が、実機の IndexedDB に既に残っている可能性がある。
// 課題の削除・記録の削除は IndexedDB の値も更新されるため残存しない(回帰確認として含める)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node idb-residue.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://localhost:8123/';
const NAME = '削除確認太郎';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const launch = () => puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });

// ページ内の IndexedDB(鏡)の全内容 / localStorage の全内容 / キャッシュの全キー
const idbAll = (page) => page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('spa_classroom_db');
    r.onsuccess = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains('kv')) { db.close(); res(null); return; } const q = db.transaction('kv', 'readonly').objectStore('kv').getAll(); q.onsuccess = () => { db.close(); res(q.result); }; };
    r.onerror = () => res(null);
}));
const lsAll = (page) => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
const withName = (obj) => Object.keys(obj).filter(k => String(obj[k]).indexOf(NAME) !== -1);

(async () => {
    // ================= 1. 退勤モードの端末データ消去 =================
    console.log('--- 1. 退勤モードの端末データ消去(wipeLocalData) ---');
    let browser = await launch();
    let page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error' && (msg.location().url || '').indexOf('favicon') === -1) consoleErrors.push(msg.text()); });
    page.on('dialog', d => d.accept());
    try {
        await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' });
        await page.evaluate((NAME) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: NAME }], classInfo: { year: 2026, grade: 5, class: 1 } }));
            StorageManager.setImmediate(KEYS.karte_life, JSON.stringify({ '0': [{ id: 1, summary: NAME + 'の記録' }] }));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([{ id: 1, studentIndex: 0, testId: 1, score: 50 }]));
            // pf(新体力テスト)は localStorage へ直接書く。旧バックアップ類も同様
            localStorage.setItem('pf_roster', JSON.stringify([{ id: 1, name: NAME, gender: '男', age: 10 }]));
            localStorage.setItem('pf_records_2026', JSON.stringify({ 1: { 握力: 20 } }));
            localStorage.setItem('pf_setting', JSON.stringify({ year: 2026, grade: 5, className: '5年1組' }));
            localStorage.setItem('scoreDataBackup_1700000000000', JSON.stringify([{ studentIndex: 0, score: 50 }]));
            localStorage.setItem('spa_kanji_backup_v1851', JSON.stringify({ checks: { 0: { 0: 'o' } } }));
            localStorage.setItem('spa_submissions_removed_v1863', JSON.stringify([{ studentIndex: 0 }]));
            // 同じオリジンの別アプリのキーは消してはいけない
            localStorage.setItem('doc-index-v1', 'other-app-index');
            localStorage.setItem('taskListOther', 'other-app-task');
        }, NAME);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);   // 鏡(IndexedDB)が作られる
        const pre = await idbAll(page);
        check('前提: 氏名が localStorage と IndexedDB(鏡)の両方にある(pf_roster を含む)', withName(await lsAll(page)).indexOf('pf_roster') !== -1 && pre.some(x => x.key === 'pf_roster' && String(x.value).indexOf(NAME) !== -1), '');

        await page.evaluate(() => { wipeLocalData(); });
        await sleep(3200); // 1.5秒後に自動再読み込み
        await page.waitForFunction(() => typeof StorageManager !== 'undefined'); await sleep(900);
        const ls = await lsAll(page), idb = await idbAll(page);
        const cache = await page.evaluate(() => { const o = {}; Object.keys(StorageManager._cache).forEach(k => { o[k] = StorageManager._cache[k]; }); return o; });
        const personal = (k) => /^(pf_|scoreDataBackup_|spa_kanji_backup_|spa_submissions_removed_)/.test(k) || /^spa_(master|karte_|scores|tests|attendance|kanji|seating|patrol|submissions_)/.test(k);
        check('消去後: 氏名が localStorage のどのキーにも残らない', withName(ls).length === 0, JSON.stringify(withName(ls)));
        check('消去後: 氏名が IndexedDB(鏡)のどのキーにも残らない', idb.filter(x => String(x.value).indexOf(NAME) !== -1).length === 0, JSON.stringify(idb.filter(x => String(x.value).indexOf(NAME) !== -1).map(x => x.key)));
        check('消去後: 氏名がメモリキャッシュにも残らない', withName(cache).length === 0, JSON.stringify(withName(cache)));
        check('消去後: 新体力テスト(pf_*)・旧バックアップの各キーが localStorage / IndexedDB のどちらにも残らない', Object.keys(ls).filter(personal).length === 0 && idb.filter(x => personal(x.key)).length === 0, JSON.stringify(Object.keys(ls).filter(personal).concat(idb.filter(x => personal(x.key)).map(x => 'idb:' + x.key))));
        check('消去後: 同じオリジンの別アプリのキー(doc-index-v1・task系)は消さない', ls['doc-index-v1'] === 'other-app-index' && ls['taskListOther'] === 'other-app-task', JSON.stringify([ls['doc-index-v1'], ls['taskListOther']]));
        const exported = await page.evaluate(async () => { let t = null; window.universalShare = (blob) => blob.text().then(x => { t = x; }); await exportBackup(false); return t; });
        check('消去後にバックアップを書き出しても氏名が入らない', exported.indexOf(NAME) === -1, '');

        // ================= 2. pf の削除操作(index.html 内蔵版) =================
        console.log('--- 2. pf の名簿リセット・記録データ削除(内蔵版) ---');
        await page.evaluate((NAME) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: NAME }], classInfo: { year: 2026, grade: 5, class: 1 } }));
            localStorage.setItem('pf_roster', JSON.stringify([{ id: 1, name: NAME, gender: '男', age: 10 }]));
            localStorage.setItem('pf_records_2026', JSON.stringify({ 1: { 握力: 20 } }));
        }, NAME);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        await page.evaluate(() => { pf_clearRoster(); pf_confirmClearData(); });
        await sleep(300);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
        const ls2 = await lsAll(page), idb2 = await idbAll(page);
        const cache2 = await page.evaluate(() => Object.keys(StorageManager._cache));
        check('pf名簿リセット・記録データ削除: localStorage から消える', !('pf_roster' in ls2) && !('pf_records_2026' in ls2), JSON.stringify(Object.keys(ls2).filter(k => /^pf_/.test(k))));
        check('pf名簿リセット・記録データ削除: IndexedDB(鏡)からも消える(次回起動で復活しない)', !idb2.some(x => x.key === 'pf_roster' || x.key === 'pf_records_2026'), JSON.stringify(idb2.filter(x => /^pf_/.test(x.key)).map(x => x.key)));
        check('pf名簿リセット・記録データ削除: 再読み込み後のキャッシュにも現れない', cache2.indexOf('pf_roster') === -1 && cache2.indexOf('pf_records_2026') === -1, JSON.stringify(cache2.filter(k => /^pf_/.test(k))));
        const exported2 = await page.evaluate(async () => { let t = null; window.universalShare = (blob) => blob.text().then(x => { t = x; }); await exportBackup(false); return t; });
        check('pf削除後のバックアップに、削除した氏名・記録が入らない(復元しても復活しない)', exported2.indexOf('pf_roster') === -1 && exported2.indexOf('pf_records_2026') === -1, '');

        // ================= 3. 過去の削除で既に残っている鏡の掃除 =================
        console.log('--- 3. 過去の削除で残った鏡(pf_* のみ)の起動時掃除 ---');
        await page.evaluate((NAME) => new Promise((res) => {
            // localStorage に無く IndexedDB にだけある pf キー(過去の pf 削除の残り)と、IndexedDB にだけある通常キー(容量超過で localStorage へ書けなかった新しい値などの可能性)
            const r = indexedDB.open('spa_classroom_db');
            r.onsuccess = (e) => { const db = e.target.result; const tx = db.transaction('kv', 'readwrite'); const st = tx.objectStore('kv');
                st.put({ key: 'pf_roster', value: JSON.stringify([{ id: 1, name: NAME }]) });
                st.put({ key: 'spa_forgotten_items', value: JSON.stringify(['IDBだけにある品目']) });
                tx.oncomplete = () => { db.close(); res(); }; };
        }), NAME);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
        const idb3 = await idbAll(page);
        const cache3 = await page.evaluate(() => ({ pf: StorageManager._cache['pf_roster'], other: StorageManager._cache['spa_forgotten_items'] }));
        check('起動時: localStorage に無い pf キーは鏡(IndexedDB)から削除され、キャッシュにも復活しない', !idb3.some(x => x.key === 'pf_roster') && cache3.pf === undefined, JSON.stringify({ idb: idb3.some(x => x.key === 'pf_roster'), cache: cache3.pf }));
        check('起動時: pf 以外のキーは、IndexedDB にだけあっても消さない(新しい値を失わないため)', idb3.some(x => x.key === 'spa_forgotten_items') && cache3.other !== undefined, JSON.stringify(cache3.other));

        // ================= 4. 課題・記録の削除は残らない(回帰確認) =================
        console.log('--- 4. 課題・記録の削除 ---');
        await page.evaluate((NAME) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: NAME }], classInfo: { year: 2026, grade: 5, class: 1 } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([{ id: 1, subject: '算数', name: 't', category: '知識・技能', maxScore: 100, date: '2026-05-10', term: '1' }]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([{ id: 1, studentIndex: 0, testId: 1, score: 50 }]));
        }, NAME);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        await page.evaluate(() => { showView('records'); recShowSub('tests'); recDeleteTest(1); });
        await sleep(400);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        const idb4 = await idbAll(page), ls4 = await lsAll(page);
        const val = (k) => (idb4.find(x => x.key === k) || {}).value;
        check('課題の削除: IndexedDB(鏡)の課題・記録も空になり、localStorage と一致する', val('spa_tests') === '[]' && val('spa_scores') === '[]' && ls4['spa_tests'] === '[]' && ls4['spa_scores'] === '[]', JSON.stringify([val('spa_tests'), val('spa_scores')]));
        const mismatch = Object.keys(ls4).filter(k => (idb4.find(x => x.key === k) || {}).value !== ls4[k]);
        check('課題の削除後: localStorage の全キーの値が IndexedDB(鏡)と一致する', mismatch.length === 0, JSON.stringify(mismatch));
    } catch (e) {
        check('テスト実行中に例外なし(内蔵版)', false, e && e.stack || String(e));
    }
    await page.evaluate(() => { try { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); } catch (e) {} }).catch(() => {});
    await browser.close();

    // ================= 5. pf.html(単体ページ)の削除操作 =================
    console.log('--- 5. pf.html の名簿リセット・記録データ削除 ---');
    browser = await launch();
    try {
        // 5a: index.html を先に開いて鏡ができている状態で、pf.html から削除
        let pg = await browser.newPage(); pg.on('dialog', d => d.accept());
        await pg.goto(BASE + 'index.html', { waitUntil: 'networkidle0' });
        await pg.evaluate((NAME) => {
            localStorage.setItem('pf_roster', JSON.stringify([{ id: 1, name: NAME, gender: '男', age: 10 }]));
            localStorage.setItem('pf_records_2026', JSON.stringify({ 1: { 握力: 20 } }));
        }, NAME);
        await pg.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        check('前提: 鏡(IndexedDB)に pf_roster がある', (await idbAll(pg)).some(x => x.key === 'pf_roster'), '');
        await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' }); await sleep(400);
        await pg.evaluate(() => { clearRoster(); confirmClearData(); });
        await sleep(600);
        await pg.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await sleep(900);
        const idb5 = await idbAll(pg), ls5 = await lsAll(pg);
        const cache5 = await pg.evaluate(() => Object.keys(StorageManager._cache));
        check('pf.html の名簿リセット・記録データ削除: localStorage・IndexedDB・キャッシュのどれにも残らない', !('pf_roster' in ls5) && !idb5.some(x => /^pf_(roster|records)/.test(x.key)) && !cache5.some(k => /^pf_(roster|records)/.test(k)), JSON.stringify({ ls: Object.keys(ls5).filter(k => /^pf_/.test(k)), idb: idb5.filter(x => /^pf_/.test(x.key)).map(x => x.key), cache: cache5.filter(k => /^pf_/.test(k)) }));
        await pg.close();
        await browser.close();

        // 5b: pf.html を最初に開く(IndexedDB がまだ無い)場合、pf.html が空の IndexedDB を作って index.html の初期化を壊さない
        browser = await launch();
        pg = await browser.newPage(); pg.on('dialog', d => d.accept());
        await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' }); await sleep(300);
        await pg.evaluate(() => { localStorage.setItem('pf_roster', JSON.stringify([{ id: 1, name: 'x' }])); clearRoster(); confirmClearData(); });
        await sleep(500);
        await pg.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await sleep(900);
        const phase = await pg.evaluate(() => ({ phase: StorageManager._phase, idb: !!StorageManager._idb, loaded: StorageManager._cacheLoaded }));
        check('pf.html を最初に開いても、index.html の IndexedDB 初期化(Phase C)が壊れない', phase.idb === true && phase.loaded === true && phase.phase === 'C', JSON.stringify(phase));
        await pg.close();
    } catch (e) {
        check('テスト実行中に例外なし(pf.html)', false, e && e.stack || String(e));
    }
    check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    await browser.close();
    const fail = results.filter(r => !r.pass).length;
    console.log('\n=== idb-residue: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
    process.exit(fail ? 1 : 0);
})();
