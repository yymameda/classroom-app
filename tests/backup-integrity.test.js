// H4 案B 段階4d-2: バックアップの版の印(version 11・studentIdSchema・pfSchema)、版の判別、復元後の整合性検査。
//   1. 書き出し: version 11・studentIdSchema 1・pfSchema(端末の pf の実際の方式: 新=2 / 旧=1 / データなし=印なし)。中身(data・rawLocalStorage)は変えない
//   2. 版の判別(brPlanRestore の format): 新しい版(12以上)・古い形式(児童IDなし・pf が旧方式)・現行を、内容で判別する。復元は止めない
//   3. 整合性検査(spaIntegrityCheck): 児童IDの欠落・重複 / pf の新旧混在 / 退避の重複・読み取れない退避。読み取り専用(何も書かない)
//   4. 実際の画面: バックアップ画面から復元 → 再読み込み後の通知と、設定の確認カード。確認ダイアログは使わない
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node backup-integrity.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRaws, mkStudents } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1 && t.indexOf('quota') === -1) consoleErrors.push(t); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });

    // ---------- 端末の状態を作る ----------
    // pfMode: 'v2'(児童IDキー) / 'v1'(位置番号キー) / 'none'
    const pfRaws = (students, mode) => {
        if (mode === 'none') return {};
        const roster = [], rec = {};
        students.forEach((s, i) => {
            const e = { id: i + 1, name: s.name, gender: s.gender || '', age: 10 };
            if (mode === 'v2') e.studentId = s.studentId;
            roster.push(e);
            rec[mode === 'v2' ? s.studentId : String(i + 1)] = { 握力: 20 + i };
        });
        return { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec) };
    };
    async function seed(students, pfMode, extra) {
        const raws = buildRaws(K, students);
        const pf = pfRaws(students, pfMode || 'v2');
        await page.evaluate((K, raws, pf, students, extra) => {
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).forEach(k => storageVerifiedWrite(k, raws[k]));
            Object.keys(pf).forEach(k => storageVerifiedWrite(k, pf[k]));
            Object.keys(extra || {}).forEach(k => storageVerifiedWrite(k, extra[k]));
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, pf, students, extra || null);
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const makeBackup = () => page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
    const plan = (backup) => page.evaluate((b) => { const dev = { get: k => localStorage.getItem(k), keys: () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)) }; return window.brPlanRestore(b, dev); }, backup);
    const integrity = () => page.evaluate(() => window.spaIntegrityCheck());
    const codes = (r) => (r && r.issues ? r.issues.map(i => i.code + (i.count !== undefined ? ':' + i.count : '')).sort().join(',') : 'NO-RESULT');
    const toastSeen = (t, ms) => page.waitForFunction((t) => { const el = document.getElementById('toastMsg'); const box = document.getElementById('toast'); return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 15000, polling: 50 }, t).then(() => true).catch(() => false);
    const writeTmp = (name, obj) => { const p = path.join(os.tmpdir(), name); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };
    const openRestoreAndUpload = async (file) => {
        await page.evaluate(() => { openBackupModal(); });
        await sleep(400);
        const inp = await page.$('#restoreFile');
        await inp.uploadFile(file);
        await page.evaluate(() => { importBackup(); });
    };
    const N = 6;
    const S = mkStudents(N);

    try {
        // ================= 1. 書き出し =================
        console.log('--- 1. 書き出しの印 ---');
        await seed(S, 'v2');
        const b2 = await makeBackup();
        check('新方式の端末: version 11・studentIdSchema 1・pfSchema 2', b2.version === 11 && b2.studentIdSchema === 1 && b2.pfSchema === 2, JSON.stringify({ v: b2.version, s: b2.studentIdSchema, p: b2.pfSchema }));
        check('appType・data・rawLocalStorage は従来どおり(pf を含める・名簿に studentId が入る)', b2.appType === 'classroom-spa' && !!b2.data && !!b2.rawLocalStorage && b2.rawLocalStorage['pf_roster'] !== undefined && JSON.parse(b2.data[K.master]).students[0].studentId === S[0].studentId, '');
        await seed(S, 'v1');
        const b1 = await makeBackup();
        check('旧方式の pf の端末: pfSchema 1(端末の実際の状態を記録する)', b1.version === 11 && b1.pfSchema === 1, 'pfSchema=' + b1.pfSchema);
        await seed(S, 'none');
        const b0 = await makeBackup();
        check('pf のデータなしの端末: pfSchema の印なし', b0.version === 11 && b0.studentIdSchema === 1 && b0.pfSchema === undefined, 'pfSchema=' + b0.pfSchema);

        // ================= 2. 版の判別(復元は止めない) =================
        console.log('--- 2. 版の判別 ---');
        await seed(S, 'v2');
        const cur = await makeBackup();
        await seed(S.map(s => Object.assign({}, s, { name: s.name + 'x' })), 'v2'); // 端末の名簿は違う(復元で変わるようにする)
        const pCur = await plan(cur);
        check('現行(version 11): format.kind=current・古い形式の注意なし', pCur.ok && pCur.format && pCur.format?.kind === 'current' && !pCur.format?.legacyStudentId && !pCur.format?.legacyPf, JSON.stringify(pCur.format));
        const v10Same = Object.assign({}, cur, { version: 10 }); delete v10Same.studentIdSchema; delete v10Same.pfSchema;
        const pV10 = await plan(v10Same);
        check('version 10 でも中身が新方式(児童IDあり・pf 新方式): 古い形式の注意は出さない(内容で判別する)', pV10.ok && pV10.format?.kind === 'legacy' && !pV10.format?.legacyStudentId && !pV10.format?.legacyPf, JSON.stringify(pV10.format));
        const noIds = JSON.parse(JSON.stringify(cur)); delete noIds.studentIdSchema; noIds.version = 10;
        const stripIds = (raw) => { const m = JSON.parse(raw); m.students = m.students.map(s => { const c = Object.assign({}, s); delete c.studentId; return c; }); return JSON.stringify(m); };
        noIds.data[K.master] = stripIds(cur.data[K.master]); noIds.rawLocalStorage[K.master] = noIds.data[K.master];
        const pNoId = await plan(noIds);
        check('児童IDのない名簿のバックアップ: legacyStudentId=true(復元は止めない)', pNoId.ok && pNoId.format?.legacyStudentId === true, JSON.stringify(pNoId.format));
        const pfV1Raws = pfRaws(S, 'v1');
        const oldPf = JSON.parse(JSON.stringify(cur)); oldPf.version = 10; delete oldPf.pfSchema;
        Object.keys(pfV1Raws).forEach(k => { oldPf.rawLocalStorage[k] = pfV1Raws[k]; });
        const pOldPf = await plan(oldPf);
        check('pf が旧方式のバックアップ: legacyPf=true(復元は止めない)', pOldPf.ok && pOldPf.format?.legacyPf === true && !pOldPf.format?.legacyStudentId, JSON.stringify(pOldPf.format));
        const newer = JSON.parse(JSON.stringify(cur)); newer.version = 12; newer.futureField = { x: 1 };
        const pNew = await plan(newer);
        check('新しい版(12)のバックアップ: format.kind=newer だが復元は止めない(ok)', pNew.ok && pNew.format?.kind === 'newer', JSON.stringify(pNew.format));
        const pUnk = await plan(Object.assign({}, cur, { version: 'abc' }));
        check('版が数字でない: format.kind=unknown だが復元は止めない(ok)', pUnk.ok && pUnk.format?.kind === 'unknown', JSON.stringify(pUnk.format));
        const preP = await dump(); await plan(newer); const postP = await dump();
        check('計画は何も書かない', JSON.stringify(preP) === JSON.stringify(postP), '');

        // ================= 3. 整合性検査(読み取り専用) =================
        console.log('--- 3. 整合性検査 ---');
        await seed(S, 'v2');
        const rOk = await integrity();
        check('正常な端末(新方式): 問題なし', rOk && rOk.ok === true && rOk.issues.length === 0, codes(rOk));
        await seed(S, 'v1');
        check('旧方式のままの pf(混在ではない): 問題にしない(連携状態カードの担当)', codes(await integrity()) === '', codes(await integrity()));
        await seed(S, 'none');
        check('pf のデータなし: 問題なし', codes(await integrity()) === '', '');
        // 児童IDの欠落
        await seed(S.map((s, i) => (i === 1 || i === 3) ? Object.assign({}, s, { studentId: undefined }) : s), 'v2', pfRaws(S, 'v2')); // pf は全員の児童IDを持つ(名簿だけ欠落)
        check('児童IDの欠落2名: student-id-missing:2', codes(await integrity()) === 'student-id-missing:2', codes(await integrity()));
        // 児童IDの重複(3人が同じID → 重なっている児童は「余分な」2名)
        await seed(S.map((s, i) => i <= 2 ? Object.assign({}, s, { studentId: 'stu_dup00000' }) : s), 'v2');
        check('児童IDの重複(3名が同じID): student-id-duplicate:2', /student-id-duplicate:2/.test(codes(await integrity())), codes(await integrity()));
        // pf の新旧混在
        {
            const roster = JSON.parse(pfRaws(S, 'v2').pf_roster), rec = JSON.parse(pfRaws(S, 'v2').pf_records_2026);
            await seed(S, 'v2', { pf_records_2025: JSON.stringify({ '1': { 握力: 10 }, '2': { 握力: 11 } }) });
            check('pf 名簿は新方式なのに、ある年度の記録が位置番号キー: pf-mixed', codes(await integrity()) === 'pf-mixed', codes(await integrity()));
            await seed(S, 'v2', { pf_records_2025: JSON.stringify(Object.assign({ '1': { 握力: 10 } }, { [S[2].studentId]: { 握力: 12 } })) });
            check('同じ年度の記録に位置番号キーと児童IDキーが同居: pf-mixed', codes(await integrity()) === 'pf-mixed', codes(await integrity()));
            const half = roster.map((e, i) => i === 0 ? Object.assign({}, e, { studentId: undefined }) : e);
            await seed(S, 'v2', { pf_roster: JSON.stringify(half) });
            check('pf 名簿の一部の項目だけ児童IDを持つ: pf-mixed', codes(await integrity()) === 'pf-mixed', codes(await integrity()));
            const manual = roster.concat([{ id: 99, studentId: 'pfm_abcd1234', name: '手入力の児童', gender: '', age: 10 }]);
            await seed(S, 'v2', { pf_roster: JSON.stringify(manual) });
            check('手入力の児童(pfm_ の ID)が pf 名簿にいるだけ: 問題にしない', codes(await integrity()) === '', codes(await integrity()));
            void rec;
        }
        // 退避
        {
            const arch = (entries) => ({ [K.student_archive]: JSON.stringify({ version: 1, entries }) });
            const ok = { archiveId: 'arc_1', archivedAt: '2026-09-01T00:00:00.000Z', studentId: 'stu_gone0001', reason: 'roster-delete', sourceIndex: 0, student: { name: '削除した児童' }, data: { scores: [] } };
            await seed(S, 'v2', arch([ok]));
            check('名簿にいない児童の退避(通常の退避): 問題なし', codes(await integrity()) === '', codes(await integrity()));
            const orphan = { archiveId: 'arc_2', archivedAt: '2026-09-01T00:00:00.000Z', reason: 'orphan', orphanIndex: 40, data: { scores: [] } };
            await seed(S, 'v2', arch([ok, orphan]));
            check('孤立データ(児童ではない退避)は問題にしない', codes(await integrity()) === '', codes(await integrity()));
            const dup = Object.assign({}, ok, { archiveId: 'arc_3', studentId: S[2].studentId });
            await seed(S, 'v2', arch([ok, dup]));
            check('名簿にもいる児童が退避にもある: archive-duplicate:1', codes(await integrity()) === 'archive-duplicate:1', codes(await integrity()));
            await seed(S, 'v2', arch([ok, { studentId: 'stu_gone0002', reason: 'roster-delete', data: {} }, { archiveId: 'arc_5', studentId: 'stu_gone0003', data: 'x' }]));
            check('退避の項目が読み取れない(archiveId なし・data が形式違い): archive-invalid:2', codes(await integrity()) === 'archive-invalid:2', codes(await integrity()));
            await seed(S, 'v2', { [K.student_archive]: '{broken' });
            check('退避のファイルが壊れている: archive-invalid', /archive-invalid/.test(codes(await integrity())), codes(await integrity()));
        }
        // 読み取り専用
        await seed(S.map((s, i) => i === 1 ? Object.assign({}, s, { studentId: undefined }) : s), 'v2', { pf_records_2025: JSON.stringify({ '1': {} }), [K.student_archive]: JSON.stringify({ version: 1, entries: [{ studentId: S[0].studentId, archiveId: 'a', data: {} }] }) });
        await page.evaluate(() => { window.__w = 0; const s = Storage.prototype.setItem, r = Storage.prototype.removeItem; Storage.prototype.setItem = function() { window.__w++; return s.apply(this, arguments); }; Storage.prototype.removeItem = function() { window.__w++; return r.apply(this, arguments); }; window.__wRestore = () => { Storage.prototype.setItem = s; Storage.prototype.removeItem = r; }; });
        const pre3 = await dump();
        const rBad = await integrity();
        const writes3 = await page.evaluate(() => { const n = window.__w; window.__wRestore(); return n; });
        check('複数の問題が同時にある: 3種とも検出し、何も書かない(localStorage の書き込み0回・内容不変)', /archive-duplicate:1/.test(codes(rBad)) && /pf-mixed/.test(codes(rBad)) && /student-id-missing:1/.test(codes(rBad)) && writes3 === 0 && JSON.stringify(pre3) === JSON.stringify(await dump()), codes(rBad) + ' writes=' + writes3);
        check('検査の結果に氏名を含めない', !/児童\d|削除した児童|手入力/.test(JSON.stringify(rBad)), JSON.stringify(rBad).slice(0, 200));

        // ================= 4. 実際の画面 =================
        console.log('--- 4. 実際の画面: 復元 → 再読み込み後の通知・設定の確認カード ---');
        // 4a. 古い形式(児童IDなし・pf 旧方式で名簿一致)を復元 → 起動時の移行のあと、問題なし
        await seed(S, 'v1');
        const bkLegacy = await makeBackup();
        bkLegacy.version = 10; delete bkLegacy.studentIdSchema; delete bkLegacy.pfSchema;
        bkLegacy.data[K.master] = stripIds(bkLegacy.data[K.master]); bkLegacy.rawLocalStorage[K.master] = bkLegacy.data[K.master];
        await seed(S.map(s => Object.assign({}, s, { name: s.name + 'x' })), 'v2'); // 端末は別の名簿
        const fLegacy = writeTmp('legacy-v10.json', bkLegacy);
        await openRestoreAndUpload(fLegacy);
        check('古い形式の復元: 再読み込み後に「古い形式」の案内が出る', await toastSeen('古い形式'), '');
        await page.waitForFunction(() => typeof StorageManager !== 'undefined' && document.readyState === 'complete');
        await sleep(9000); // 通知が出そろうのを待つ
        const afterLegacy = await page.evaluate(() => ({ integ: window.spaIntegrityCheck(), ids: JSON.parse(localStorage.getItem(KEYS.master)).students.every(s => !!s.studentId), pfV2: JSON.parse(localStorage.getItem('pf_roster')).every(e => !!e.studentId) }));
        check('古い形式の復元後: 起動時の移行で児童IDが付き pf も新方式になり、整合性の問題はなし', afterLegacy.ids && afterLegacy.pfV2 && afterLegacy.integ.ok === true, JSON.stringify(afterLegacy));

        // 4b. 児童IDが重なったバックアップを復元 → 再読み込み後に警告
        await seed(S, 'v2');
        const bkDup = await makeBackup();
        const dupMaster = JSON.parse(bkDup.data[K.master]); dupMaster.students[1].studentId = dupMaster.students[0].studentId;
        bkDup.data[K.master] = JSON.stringify(dupMaster); bkDup.rawLocalStorage[K.master] = bkDup.data[K.master];
        await seed(S.map(s => Object.assign({}, s, { name: s.name + 'x' })), 'v2');
        await openRestoreAndUpload(writeTmp('dup-v11.json', bkDup));
        check('児童IDが重なったバックアップの復元: 復元は止まらず、再読み込み後に警告が出る', await toastSeen('児童ごとの番号'), '');
        await page.waitForFunction(() => typeof StorageManager !== 'undefined' && document.readyState === 'complete');
        await sleep(9000);
        // 設定画面の確認カード
        await page.click('#nav-settings');
        await page.waitForSelector('#integrityBody .pfd-row', { timeout: 5000 });
        await sleep(300);
        const card = await page.evaluate(() => { const c = document.getElementById('integrityCard'), b = document.getElementById('integrityBody'); return { has: !!c, text: b ? b.textContent : '', ng: b ? b.querySelectorAll('.pfd-ng').length : 0 }; });
        check('設定の確認カード: 児童IDの重複を表示し、氏名を含めない', card.has && /児童ごとの番号/.test(card.text) && card.ng >= 1 && !/児童\d/.test(card.text), card.text.slice(0, 160));
        // 4c. 問題がない状態ではカードに「問題は見つかりませんでした」
        await seed(S, 'v2');
        await page.evaluate(() => { updateSettingsUI(); });
        await sleep(200);
        const cardOk = await page.evaluate(() => { const b = document.getElementById('integrityBody'); return { text: b ? b.textContent : '', ng: b ? b.querySelectorAll('.pfd-ng').length : -1 }; });
        check('問題がないとき、確認カードは「問題は見つかりませんでした」', /問題は見つかりませんでした/.test(cardOk.text) && cardOk.ng === 0, cardOk.text.slice(0, 120));
        // 4d. もう一度確認するボタン(問題を作って押す)
        await page.evaluate((K) => { const m = JSON.parse(localStorage.getItem(K.master)); m.students[1].studentId = m.students[0].studentId; storageVerifiedWrite(K.master, JSON.stringify(m)); }, K);
        await page.click('#integrityCard button[data-act="integrity-refresh"]');
        await sleep(300);
        check('「もう一度確認する」ボタンで最新の状態を表示する', /児童ごとの番号/.test(await page.evaluate(() => document.getElementById('integrityBody').textContent)), '');

        // 4e. 新しい版のバックアップ
        await seed(S, 'v2');
        const bkNew = await makeBackup(); bkNew.version = 12;
        await seed(S.map(s => Object.assign({}, s, { name: s.name + 'x' })), 'v2');
        await openRestoreAndUpload(writeTmp('newer-v12.json', bkNew));
        check('新しい版のバックアップ: 復元は行われ、再読み込み後に「新しい版」の注意が出る', await toastSeen('新しい版'), '');
        await page.waitForFunction(() => typeof StorageManager !== 'undefined' && document.readyState === 'complete');
        check('新しい版のバックアップを復元した結果、名簿がバックアップの内容になっている', await page.evaluate((n) => JSON.parse(localStorage.getItem(KEYS.master)).students[0].name === n, S[0].name), '');

        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { if (window.__wRestore) { try { window.__wRestore(); } catch (e) {} } StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        const pass = results.filter(r => r.pass).length;
        console.log('\n' + pass + '/' + results.length + ' PASS');
        await browser.close();
        process.exit(pass === results.length ? 0 : 1);
    }
})();
