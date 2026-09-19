// H4 案B 段階4a: 新体力テスト(pf)の連携状態の診断表示(設定画面。読み取り専用)。
//   - 表示内容: 名簿の一致/不一致(理由)・人数・pf_fitness_*(単体ページ pf.html を使った痕跡)・SPA名簿にいない児童の人数(手入力の痕跡)・記録の年度と人数
//   - **読み取り専用**: 診断・表示・再確認のどれも localStorage / IndexedDB / キャッシュに一切書かない
//   - **氏名を表示しない**(SPA名簿の氏名も、pf名簿にだけいる児童の氏名も)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pf-diagnosis.test.js

const puppeteer = require('puppeteer-core');
const { buildRaws, mkStudents } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SECRET = '手入力だけの秘密氏名';

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });

    const pfData = (students, opts) => {
        opts = opts || {};
        const roster = [], rec26 = {}, rec25 = {}, fit26 = {};
        students.forEach((s, i) => {
            if (!s.name) return;
            roster.push({ id: i + 1, name: s.name, gender: s.gender || '', age: 10 });
            rec26[String(i + 1)] = { 握力: 20 + i };
            if (i < 3) rec25[String(i + 1)] = { 握力: 10 + i };
            fit26[String(i + 1)] = { total: 30 + i, eval: 'B', year: 2026, detail: {} };
        });
        const o = { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec26), pf_records_2025: JSON.stringify(rec25) };
        if (opts.fitness !== false) o.pf_fitness_2026 = JSON.stringify(fit26);
        return o;
    };
    async function seed(n, pf, given) {
        const students = given || mkStudents(n || 6);
        const raws = buildRaws(K, students);
        await page.evaluate((K, raws, pf, students) => {
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).forEach(k => storageVerifiedWrite(k, raws[k]));
            Object.keys(pf || {}).forEach(k => { if (pf[k] !== null) storageVerifiedWrite(k, pf[k]); });
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, pf, students);
        return students;
    }
    const diag = () => page.evaluate(() => window.pfDiagnose());
    const openSettings = async () => { await page.evaluate(() => { showView('settings'); }); await page.waitForSelector('#pfDiagBody .pfd-row', { timeout: 5000 }); await sleep(100); };
    const rowText = (key) => page.evaluate((k) => { const el = document.querySelector('#pfDiagBody [data-pfd="' + k + '"]'); return el ? el.textContent : null; }, key);
    const cardText = () => page.evaluate(() => document.getElementById('pfDiagCard').textContent);
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } const c = {}; StorageManager.getAllKeys().forEach(k => { c[k] = StorageManager.getRaw(k); }); return { ls: o, cache: c }; });

    try {
        // ---------- 1. データなし ----------
        console.log('--- 1. 新体力テストのデータなし ---');
        await seed(6, {});
        let d = await diag();
        check('データなし: state=none・人数・年度が空', d.state === 'none' && d.pfRosterCount === null && d.extraCount === null && d.fitnessYears.length === 0 && d.recordYears.length === 0 && d.spaCount === 6, JSON.stringify(d));
        await openSettings();
        check('データなし: 画面に「新体力テストのデータはありません」', (await rowText('state')).indexOf('新体力テストのデータはありません') !== -1, await rowText('state'));
        check('データなし: 単体ページの痕跡「なし」・SPAにいない児童「確認できません」・記録「なし」', (await rowText('fitness')).indexOf('なし') !== -1 && (await rowText('extra')).indexOf('確認できません') !== -1 && (await rowText('records')).indexOf('なし') !== -1, '');

        // ---------- 2. 一致 ----------
        console.log('--- 2. 名簿が一致 ---');
        let st = await seed(6, pfData(mkStudents(6)));
        st = await seed(6, pfData(mkStudents(6)));
        d = await diag();
        check('一致: state=match・pf名簿6名・SPA6名・SPAにいない児童0', d.state === 'match' && d.pfRosterCount === 6 && d.spaCount === 6 && d.extraCount === 0, JSON.stringify(d));
        check('一致: 記録の年度と人数(2025年度=3名・2026年度=6名)', JSON.stringify(d.recordYears.sort((a, b) => a.year.localeCompare(b.year))) === JSON.stringify([{ year: '2025', count: 3 }, { year: '2026', count: 6 }]), JSON.stringify(d.recordYears));
        check('一致: pf_fitness_2026 があれば単体ページの痕跡に年度が出る', JSON.stringify(d.fitnessYears) === JSON.stringify(['2026']), JSON.stringify(d.fitnessYears));
        await openSettings();
        const t1 = await rowText('state');
        check('一致: 画面に「一致しています」', t1.indexOf('一致しています') !== -1 && t1.indexOf('一致していません') === -1, t1);
        check('一致: 画面に人数(SPA6名／新体力テスト6名)', (await rowText('counts')).indexOf('SPAの名簿 6名') !== -1 && (await rowText('counts')).indexOf('新体力テストの名簿 6名') !== -1, await rowText('counts'));
        check('一致: 画面に単体ページの痕跡「あり」と 2026年度', (await rowText('fitness')).indexOf('あり') !== -1 && (await rowText('fitness')).indexOf('2026年度') !== -1, await rowText('fitness'));
        check('一致: 画面に「SPAの名簿にいない児童 なし」・記録の年度別人数', (await rowText('extra')).trim().endsWith('なし') && (await rowText('records')).indexOf('2026年度：6名分') !== -1 && (await rowText('records')).indexOf('2025年度：3名分') !== -1, (await rowText('extra')) + ' / ' + (await rowText('records')));

        // ---------- 3. pf_fitness が無い(単体ページを使っていない) ----------
        console.log('--- 3. pf_fitness なし ---');
        await seed(6, pfData(mkStudents(6), { fitness: false }));
        d = await diag();
        check('pf_fitness なし: fitnessYears が空', d.fitnessYears.length === 0 && d.state === 'match', JSON.stringify(d));
        await openSettings();
        check('pf_fitness なし: 画面に「痕跡はありません」', (await rowText('fitness')).indexOf('痕跡はありません') !== -1, await rowText('fitness'));

        // ---------- 4. SPA名簿にいない児童(手入力) ----------
        console.log('--- 4. pf 名簿にだけいる児童(手入力の痕跡) ---');
        const base = mkStudents(6).map((s, i) => Object.assign({}, s, { name: '秘匿' + 'ABCDEF'[i] + '氏' })); // 固有の氏名(「児童」など画面の語と重ならない)
        const pf4 = pfData(base);
        const r4 = JSON.parse(pf4.pf_roster); r4.push({ id: 7, name: SECRET, gender: '男', age: 10 }); r4.push({ id: 8, name: SECRET + '2', gender: '女', age: 10 });
        pf4.pf_roster = JSON.stringify(r4);
        await seed(6, pf4, base);
        d = await diag();
        check('手入力の児童: 2名を数える・不一致(人数が違う)', d.extraCount === 2 && d.state === 'mismatch' && d.reason === 'length-differs', JSON.stringify(d));
        await openSettings();
        const ex = await rowText('extra');
        check('手入力の児童: 画面に「2名」と手入力の痕跡', ex.indexOf('2名') !== -1 && ex.indexOf('手入力') !== -1, ex);
        check('手入力の児童: 画面に「一致していません：人数が違います」', (await rowText('state')).indexOf('一致していません') !== -1 && (await rowText('state')).indexOf('人数が違います') !== -1, await rowText('state'));
        const txt4 = await cardText();
        check('氏名を表示しない: pf名簿にだけいる児童の氏名が画面(カード)にも診断結果にも無い', txt4.indexOf(SECRET) === -1 && JSON.stringify(await diag()).indexOf(SECRET) === -1, '');
        const spaNames = base.map(s => s.name).filter(Boolean);
        check('氏名を表示しない: SPA名簿の氏名も画面(カード)・診断結果に無い', spaNames.every(n => txt4.indexOf(n) === -1 && JSON.stringify(d).indexOf(n) === -1), spaNames.slice(0, 2).join(','));

        // ---------- 5. 不一致の各理由 ----------
        console.log('--- 5. 不一致の理由 ---');
        const mk = async (mut, expectReason, label) => {
            const stu = mkStudents(6); const pf = pfData(stu); mut(pf, stu);
            await seed(6, pf); const dd = await diag();
            check('不一致(' + label + '): reason=' + expectReason, dd.state === 'mismatch' && dd.reason === expectReason, JSON.stringify(dd));
            return dd;
        };
        await mk((pf) => { const r = JSON.parse(pf.pf_roster); const t = r[0]; r[0] = r[1]; r[1] = t; pf.pf_roster = JSON.stringify(r); }, 'name-or-order-differs', '順序違い');
        await mk((pf) => { const r = JSON.parse(pf.pf_roster); r[2].name = r[2].name + '改'; pf.pf_roster = JSON.stringify(r); }, 'name-or-order-differs', '氏名違い');
        await mk((pf) => { const r = JSON.parse(pf.pf_roster); r[3].id = 99; pf.pf_roster = JSON.stringify(r); }, 'id-not-position', 'idが位置+1でない');
        await mk((pf) => { delete pf.pf_roster; }, 'no-roster', '名簿なし(記録のみ)');
        let dd = await mk((pf) => { pf.pf_roster = '{broken'; }, 'roster-invalid', '壊れたJSON');
        check('壊れた名簿: 人数・SPAにいない児童は「確認できません」(null)', dd.pfRosterCount === null && dd.extraCount === null, JSON.stringify(dd));
        await openSettings();
        check('壊れた名簿: 画面に理由「読み取れません」と「確認できません」', (await rowText('state')).indexOf('読み取れません') !== -1 && (await rowText('extra')).indexOf('確認できません') !== -1, await rowText('state'));
        // 氏名が空のSPAの行は pf が除外して採番する(一致のまま)
        {
            const stu = mkStudents(6); stu[2] = Object.assign({}, stu[2], { name: '' });
            const roster = []; stu.forEach((s, i) => { if (s.name) roster.push({ id: i + 1, name: s.name, gender: s.gender || '', age: 10 }); });
            await seed(6, { pf_roster: JSON.stringify(roster) });
            await page.evaluate((stu, K) => { const m = JSON.parse(localStorage.getItem(K.master)); m.students = stu; storageVerifiedWrite(K.master, JSON.stringify(m)); }, stu, K);
            const de = await diag();
            check('氏名が空の行がある名簿: pf は除外して採番するため「一致」(id は位置+1のまま)', de.state === 'match' && de.spaCount === 5 && de.pfRosterCount === 5, JSON.stringify(de));
        }

        // ---------- 6. 読み取り専用 ----------
        console.log('--- 6. 読み取り専用(何も書かない) ---');
        await seed(6, pf4, base);
        const pre = await dump();
        const writes = await page.evaluate(() => {
            window.__w = { ls: 0, idb: 0, cache: 0 };
            const oS = Storage.prototype.setItem, oR = Storage.prototype.removeItem, oC = Storage.prototype.clear;
            const pP = IDBObjectStore.prototype.put, pD = IDBObjectStore.prototype.delete, pC = IDBObjectStore.prototype.clear, pA = IDBObjectStore.prototype.add;
            Storage.prototype.setItem = function() { window.__w.ls++; return oS.apply(this, arguments); };
            Storage.prototype.removeItem = function() { window.__w.ls++; return oR.apply(this, arguments); };
            Storage.prototype.clear = function() { window.__w.ls++; return oC.apply(this, arguments); };
            IDBObjectStore.prototype.put = function() { window.__w.idb++; return pP.apply(this, arguments); };
            IDBObjectStore.prototype.add = function() { window.__w.idb++; return pA.apply(this, arguments); };
            IDBObjectStore.prototype.delete = function() { window.__w.idb++; return pD.apply(this, arguments); };
            IDBObjectStore.prototype.clear = function() { window.__w.idb++; return pC.apply(this, arguments); };
            window.__unspy = () => { Storage.prototype.setItem = oS; Storage.prototype.removeItem = oR; Storage.prototype.clear = oC; IDBObjectStore.prototype.put = pP; IDBObjectStore.prototype.delete = pD; IDBObjectStore.prototype.clear = pC; IDBObjectStore.prototype.add = pA; };
            return true;
        });
        await page.evaluate(() => { window.pfDiagnose(); window.pfDiagnose(); });
        await openSettings();
        await page.click('#pfDiagCard button[data-act="pfdiag-refresh"]');
        await sleep(200);
        const w = await page.evaluate(() => { const r = window.__w; window.__unspy(); return r; });
        const post = await dump();
        check('読み取り専用: 診断・表示・再確認で localStorage への書き込み/削除が0回', w.ls === 0, JSON.stringify(w));
        check('読み取り専用: IndexedDB への書き込み/削除が0回', w.idb === 0, JSON.stringify(w));
        check('読み取り専用: localStorage の全キー・メモリキャッシュの全キーが1バイトも変わらない', JSON.stringify(pre) === JSON.stringify(post), '');

        // ---------- 7. 画面操作 ----------
        console.log('--- 7. 画面(設定)での表示と再確認ボタン ---');
        await seed(6, pfData(mkStudents(6)));
        await openSettings();
        check('設定画面の中にカードがある', await page.evaluate(() => { const c = document.getElementById('pfDiagCard'); return !!c && !!c.closest('#view-settings'); }), '');
        check('見出しに「確認用」・「データは変わりません」の説明', (await cardText()).indexOf('確認用') !== -1 && (await cardText()).indexOf('データは変わりません') !== -1, '');
        const btn = await page.$eval('#pfDiagCard button[data-act="pfdiag-refresh"]', el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
        check('再確認ボタンのタップ領域が44px以上', btn.h >= 44 && btn.w >= 44, JSON.stringify(btn));
        check('最初は「一致しています」', (await rowText('state')).indexOf('一致しています') !== -1, '');
        // 画面を開いたまま pf の名簿が変わった → 再確認ボタンで表示が変わる(実際にタップ)
        await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_roster')); r.pop(); localStorage.setItem('pf_roster', JSON.stringify(r)); });
        check('ボタンを押す前は古い表示のまま(自動では再計算しない)', (await rowText('state')).indexOf('一致しています') !== -1, '');
        await page.click('#pfDiagCard button[data-act="pfdiag-refresh"]');
        await sleep(150);
        check('ボタンを押すと「一致していません：人数が違います」に更新される', (await rowText('state')).indexOf('一致していません') !== -1 && (await rowText('state')).indexOf('人数が違います') !== -1, await rowText('state'));
        // 名簿の保存(applyRosterChange の再読み込み後)でも設定を開けば表示される: 設定を開き直す
        await page.evaluate(() => { showView('settings'); });
        await sleep(200);
        check('設定を開き直すと最新の状態を表示する', (await rowText('state')).indexOf('一致していません') !== -1, '');
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== pf-diagnosis: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
