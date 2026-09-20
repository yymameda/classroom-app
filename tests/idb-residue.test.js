// H8: 削除したデータ(特に氏名)が IndexedDB の鏡に残り、あとで復活しないこと。
//
// 背景: StorageManager は localStorage を真実とし、IndexedDB を鏡にしている。起動のたびに migrateFromLS が
// localStorage の全キーを IndexedDB へ上書きコピーし、loadCache が IndexedDB の全キーをメモリキャッシュへ読む。
// **キーの削除は鏡に反映されない**ため、localStorage だけから消したキーが IndexedDB に残り、次回起動でキャッシュに
// 復活し、バックアップ(exportAll はキャッシュのキーを使う)に入り、復元すると localStorage に戻る。
//   (1) 退勤モードの端末データ消去は KEYS の全キーしか消さず、新体力テスト(pf_*)の名簿・記録・旧バックアップが残る。
//   (2) pf の「名簿リセット」「記録データ削除」(index.html 内蔵版。単体ページ pf.html は v1.59.0 で案内ページになり削除操作を持たない)は localStorage.removeItem だけ。
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
                st.put({ key: 'zz_unowned_key', value: JSON.stringify(['アプリのキーではない']) });
                tx.oncomplete = () => { db.close(); res(); }; };
        }), NAME);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
        const idb3 = await idbAll(page);
        const cache3 = await page.evaluate(() => ({ pf: StorageManager._cache['pf_roster'], other: StorageManager._cache['zz_unowned_key'] }));
        check('起動時: localStorage に無い pf キーは鏡(IndexedDB)から削除され、キャッシュにも復活しない', !idb3.some(x => x.key === 'pf_roster') && cache3.pf === undefined, JSON.stringify({ idb: idb3.some(x => x.key === 'pf_roster'), cache: cache3.pf }));
        check('起動時: アプリが所有しないキー(別アプリ等)は、IndexedDB にだけあっても消さない', idb3.some(x => x.key === 'zz_unowned_key') && cache3.other !== undefined, JSON.stringify(cache3.other));

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

        // ================= 6. 実機に既に残っている鏡の一回限りの掃除(所有キー全般) =================
        console.log('--- 6. 既存の残りの一回限りの掃除(localStorage に無い所有キーを IndexedDB から削除) ---');
        const putIdb = (items) => page.evaluate((items) => new Promise((res) => {
            const r = indexedDB.open('spa_classroom_db');
            r.onsuccess = (e) => { const db = e.target.result; const tx = db.transaction('kv', 'readwrite'); const st = tx.objectStore('kv'); items.forEach(it => st.put(it)); tx.oncomplete = () => { db.close(); res(); }; };
        }), items);
        const resetAll = () => page.evaluate(() => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); });
        const boot = async () => { await page.reload({ waitUntil: 'networkidle0' }); await sleep(900); };
        const ghostItems = [
            { key: 'spa_karte_life', value: JSON.stringify({ '0': [{ summary: NAME + 'の生活記録' }] }) },
            { key: 'spa_scores', value: JSON.stringify([{ studentIndex: 0, testId: 1, score: 50 }]) },
            { key: 'spa_forgotten_items', value: JSON.stringify(['IDBだけの品目']) },
            { key: 'pf_records_2025', value: JSON.stringify({ 1: { 握力: 20 } }) },
            { key: 'scoreDataBackup_1700000001', value: '[]' },
            { key: 'doc-index-v1', value: 'other-app-idb-only' },       // 別アプリ(所有しない)
            { key: 'taskOtherApp', value: 'other-app-task' },
            { key: 'zz_unowned_key', value: 'x' }
        ];
        // 6a: localStorage が生きている(所有キーがある)状態で、鏡にだけ残った所有キーを1回だけ掃除する
        await resetAll();
        await page.evaluate((NAME) => { StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: NAME }], classInfo: { year: 2026 } })); StorageManager.setImmediate(KEYS.tests, '[]'); }, NAME);
        await boot();                                   // 鏡ができる(この起動で一回限りの印が付くため、更新前の端末を再現するために印を消す)
        await page.evaluate(() => { localStorage.removeItem('migration_idbGhostPurge_v1'); });
        const lsBefore = await lsAll(page);
        await putIdb(ghostItems);
        await boot();
        const idb6 = await idbAll(page), cache6 = await page.evaluate(() => Object.keys(StorageManager._cache)), ls6 = await lsAll(page);
        const owned6 = ['spa_karte_life', 'spa_scores', 'spa_forgotten_items', 'pf_records_2025', 'scoreDataBackup_1700000001'];
        check('一回限りの掃除: localStorage に無い所有キー(KEYS・pf・旧バックアップ)が IndexedDB(鏡)から消える', owned6.every(k => !idb6.some(x => x.key === k)), JSON.stringify(idb6.filter(x => owned6.indexOf(x.key) !== -1).map(x => x.key)));
        check('一回限りの掃除: キャッシュにも復活しない(氏名を含む生活記録が見えない)', owned6.every(k => cache6.indexOf(k) === -1), JSON.stringify(cache6.filter(k => owned6.indexOf(k) !== -1)));
        check('一回限りの掃除: アプリが所有しないキー(別アプリ・task系・未知のキー)は IndexedDB にもキャッシュにも残す', ['doc-index-v1', 'taskOtherApp', 'zz_unowned_key'].every(k => idb6.some(x => x.key === k) && cache6.indexOf(k) !== -1), '');
        check('一回限りの掃除: localStorage の既存キーは1つも書き換えない(氏名を含む名簿・課題はそのまま)', ['spa_master', 'spa_tests'].every(k => ls6[k] === lsBefore[k]), '');
        check('一回限りの掃除: 完了の印(migration_idbGhostPurge_v1)が localStorage に残る', !!ls6['migration_idbGhostPurge_v1'] && JSON.parse(ls6['migration_idbGhostPurge_v1']).removed >= 4, ls6['migration_idbGhostPurge_v1']);
        // 6b: 一回限り: 完了後に新しく鏡だけに現れたキーは、この処理では消さない(以後の残存は削除処理の修正で防ぐ)
        await putIdb([{ key: 'spa_karte_health', value: JSON.stringify({ '0': { familyMemo: NAME } }) }]);
        await boot();
        const idb6b = await idbAll(page);
        check('一回限り: 完了の印がある起動では、掃除を繰り返さない(以後は削除処理の修正で残存を防ぐ)', idb6b.some(x => x.key === 'spa_karte_health'), '');
        // 6c: localStorage が空(所有キーが1つも無い)で退勤モードの印も無い場合は、掃除しない(localStorage だけが消えた場合の唯一の写しを守る)
        await resetAll();
        await putIdb([{ key: 'spa_master', value: JSON.stringify({ version: 2, students: [{ name: NAME }], classInfo: {} }) }]);
        await boot();
        const idb6c = await idbAll(page), ls6c = await lsAll(page), cache6c = await page.evaluate(() => StorageManager._cache['spa_master']);
        check('localStorage が空で退勤モードの印も無い場合は掃除しない(IndexedDB が唯一の写しかもしれない)', idb6c.some(x => x.key === 'spa_master') && cache6c !== undefined && !ls6c['migration_idbGhostPurge_v1'], JSON.stringify(Object.keys(ls6c)));
        // 6d: 直前が退勤モード消去(印あり)なら、localStorage が空でも掃除する(消したはずの氏名が鏡に残っている)
        await page.evaluate(() => { localStorage.setItem('spa_wiped', '1'); });
        await boot();
        const idb6d = await idbAll(page), cache6d = await page.evaluate(() => StorageManager._cache['spa_master']);
        check('退勤モード消去の直後(印あり)なら、localStorage が空でも鏡の残りを掃除する(氏名が残らない)', !idb6d.some(x => x.key === 'spa_master') && cache6d === undefined && !idb6d.some(x => String(x.value).indexOf(NAME) !== -1), JSON.stringify(idb6d.map(x => x.key)));
        await resetAll();
    } catch (e) {
        check('テスト実行中に例外なし(内蔵版)', false, e && e.stack || String(e));
    }
    await page.evaluate(() => { try { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); } catch (e) {} }).catch(() => {});
    await browser.close();

    // ================= 5. pf.html(単体ページ。v1.59.0 から案内ページ) =================
    console.log('--- 5. pf.html(案内ページ)は鏡(IndexedDB)・localStorage に触れない ---');
    browser = await launch();
    try {
        // 5a: index.html を先に開いて鏡ができている状態で pf.html を開いても、pf のキーは残る(削除操作は pf.html に無い)
        let pg = await browser.newPage(); pg.on('dialog', d => d.accept());
        await pg.goto(BASE + 'index.html', { waitUntil: 'networkidle0' });
        await pg.evaluate((NAME) => {
            localStorage.setItem('pf_roster', JSON.stringify([{ id: 1, name: NAME, gender: '男', age: 10 }]));
            localStorage.setItem('pf_records_2026', JSON.stringify({ 1: { 握力: 20 } }));
        }, NAME);
        await pg.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        check('前提: 鏡(IndexedDB)に pf_roster がある', (await idbAll(pg)).some(x => x.key === 'pf_roster'), '');
        const before5 = { ls: await lsAll(pg), idb: await idbAll(pg) };
        await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' }); await sleep(400);
        const gone = await pg.evaluate(() => ({ clearRoster: typeof window.clearRoster, confirmClearData: typeof window.confirmClearData, scripts: document.scripts.length }));
        check('pf.html に削除操作(名簿リセット・記録データ削除)の関数もスクリプトも無い', gone.clearRoster === 'undefined' && gone.confirmClearData === 'undefined' && gone.scripts === 0, JSON.stringify(gone));
        await pg.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await sleep(900);
        const after5 = { ls: await lsAll(pg), idb: await idbAll(pg) };
        const sameKeys = (a, b) => JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]]));
        check('pf.html を開いて戻っても、pf_roster・pf_records は localStorage と鏡に残ったまま(案内ページは何も消さない)', 'pf_roster' in after5.ls && 'pf_records_2026' in after5.ls && after5.idb.some(x => x.key === 'pf_roster') && sameKeys(before5.ls, after5.ls), JSON.stringify({ ls: Object.keys(after5.ls).filter(k => before5.ls[k] !== after5.ls[k]) }));
        await pg.close();
        await browser.close();

        // 5b: pf.html を最初に開く(IndexedDB がまだ無い)場合、pf.html が空の IndexedDB を作って index.html の初期化を壊さない
        browser = await launch();
        pg = await browser.newPage(); pg.on('dialog', d => d.accept());
        await pg.goto(BASE + 'pf.html', { waitUntil: 'networkidle0' }); await sleep(300);
        await pg.evaluate(() => { localStorage.setItem('pf_roster', JSON.stringify([{ id: 1, name: 'x' }])); });
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
