// H4 案B 段階4d-1: バックアップの復元(importBackup)の安全化。
//   - 計画(書き込みなし): 形式の検証、復元しないキー、変わらないキーは書かない
//   - 復元前の自動退避(スナップショット・ジャーナル kind:'backup-restore')・検証付き書き込み・失敗時のロールバック・
//     起動時の自動復旧・復元の取り消し
//   - 容量が足りず退避できないときは、警告して復元を続ける(消す操作はしない)
//   - バックアップに無いキーの扱い: 児童別データは名簿が違うときだけ消す(取り消しで戻る)/ それ以外のアプリのキーは触らない /
//     別アプリのキーは端末に無いときだけ書く
//   - 保存待ちの古い値で、復元したデータを上書きしない
//   - 実際の画面(バックアップ画面のファイル選択と復元ボタン)での操作
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node backup-restore.test.js

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
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;
const OTHER_APP = 'doc-index-v1';

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { window.__spaSkipPfMigration = true; }); // このテストの対象は復元。起動時の pf の新方式への移行(pf-migration.test.js で検証)で値が変わらないようにする
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1 && t.indexOf('crash') === -1 && t.indexOf('quota') === -1 && t.indexOf('flushSaveQueue') === -1) consoleErrors.push(t); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });

    // ---------- 端末の状態を作る ----------
    // students: 名簿 / tag: 値の目印 / opts.pf: pf のデータを作る / opts.omit: 作らないキー
    const pfData = (students, tag) => {
        const roster = [], rec = {};
        students.forEach((s, i) => { roster.push({ id: i + 1, name: s.name, gender: s.gender || '', age: 10 }); rec[String(i + 1)] = { 握力: 20 + i, tag }; });
        return { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec), pf_records_2025: JSON.stringify(rec) };
    };
    async function seed(students, tag, opts) {
        opts = opts || {};
        const raws = buildRaws(K, students);
        const pf = opts.pf === false ? {} : pfData(students, tag);
        const extras = {
            [K.tests]: JSON.stringify([{ id: 1, subject: '算数', name: 'テスト' + tag, category: '知識・技能', maxScore: 100, date: '2026-05-10', term: '1' }]),
            [K.forgotten_items]: JSON.stringify(['ハンカチ' + tag]),
            [K.backup_meta]: JSON.stringify({ lastExportAt: '2026-09-01T00:00:00.000Z', tag })
        };
        await page.evaluate((K, raws, extras, pf, students, tag, keepOther, omit) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).concat(Object.keys(extras)).forEach(k => { if (omit.indexOf(k) === -1) storageVerifiedWrite(k, raws[k] !== undefined ? raws[k] : extras[k]); });
            Object.keys(pf).forEach(k => { if (omit.indexOf(k) === -1) storageVerifiedWrite(k, pf[k]); });
            if (keepOther !== false) storageVerifiedWrite('doc-index-v1', 'other-app-' + tag);
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' + tag }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, extras, pf, students, tag, opts.otherApp, opts.omit || []);
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (a, b, ignoreInfra) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(k => !NOISE.test(k) && (!ignoreInfra || (k !== K.roster_snapshot && k !== K.roster_txn && k !== K.undo_br_snapshot && k !== K.undo_br_txn)) && a[k] !== b[k]);
    const makeBackup = () => page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
    const plan = (backup) => page.evaluate((b) => { const dev = { get: k => localStorage.getItem(k), keys: () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)) }; return window.brPlanRestore(b, dev); }, backup);
    const restore = (backup) => page.evaluate((b) => window.brRestoreFromBackup(b), backup);
    const journal = () => page.evaluate((k) => { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; }, K.undo_br_txn); // バックアップの復元の取り消し点(v1.57.0: 種類ごとの専用の枠)
    const toastHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 2000, polling: 50 }, t).then(() => true).catch(() => false);
    const reloadWait = async () => { await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200); };
    // 失敗注入: keys(復元が書く・消すキー)への書き込み/削除を、mode に従って失敗させる。順番(ordinal)で指定。
    //   quota: at 番目の setItem で容量超過 / corrupt: at 番目の setItem の内容を壊す / crash: at 番目以降のすべての書き込み・削除が失敗 /
    //   quotaKey: 指定キーへの setItem を常に容量超過 / probe: 容量確認の一時キーへの書き込みが失敗 / snapshot: スナップショットの書き込みが失敗
    const fault = (mode, at, keys, keyName) => page.evaluate((mode, at, keys, keyName, K) => {
        const set = new Set(keys), state = { n: 0, log: [] };
        const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
        window.__fault = { state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
        Storage.prototype.setItem = function(k, v) {
            if (mode === 'probe' && k === 'spa_capacity_probe') throw new DOMException('quota', 'QuotaExceededError');
            if (mode === 'snapshot' && k === K.undo_br_snapshot) throw new DOMException('quota', 'QuotaExceededError');
            if (mode === 'quotaKey' && k === keyName) throw new DOMException('quota', 'QuotaExceededError');
            if (set.has(k) && (mode === 'quota' || mode === 'corrupt' || mode === 'crash')) {
                if (mode === 'crash' && state.n >= at) throw new Error('crash');
                const i = state.n++; state.log.push(k);
                if (mode === 'quota' && i === at) throw new DOMException('quota', 'QuotaExceededError');
                if (mode === 'corrupt' && i === at) return oSet.call(this, k, String(v).slice(0, Math.max(0, String(v).length - 3)));
            }
            return oSet.apply(this, arguments);
        };
        Storage.prototype.removeItem = function(k) {
            if (set.has(k) && mode === 'crash') { if (state.n >= at) throw new Error('crash'); state.n++; }
            return oRem.apply(this, arguments);
        };
    }, mode, at === undefined ? 1e9 : at, keys || [], keyName || '', K);
    const unfault = () => page.evaluate(() => { const s = window.__fault ? window.__fault.state : null; if (window.__fault) { window.__fault.restore(); window.__fault = null; } return s; });
    const writeTmp = (name, obj) => { const p = path.join(os.tmpdir(), name); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };

    const A = mkStudents(6);                                            // バックアップの名簿
    const Brev = mkStudents(6).reverse().map((s, i) => Object.assign({}, s, { studentId: 'stu_b' + String(i).padStart(7, '0') })); // 端末の名簿(違う)
    const planKeys = (p) => p.writes.map(w => w[0]).concat(p.stale);

    try {
        // ================= 1. 計画(書き込みなし)・形式の検証 =================
        console.log('--- 1. 計画と形式の検証 ---');
        await seed(A, 'old');
        const bk = await makeBackup();
        await seed(Brev, 'new');
        const pre1 = await dump();
        const bads = [
            ['null', null], ['配列', []], ['空のオブジェクト', {}], ['rawLocalStorage が配列', { rawLocalStorage: [1] }],
            ['SPA形式でデータなし', { appType: 'classroom-spa', version: 10 }],
            ['値が文字列でない', { appType: 'classroom-spa', data: { [K.tests]: { a: 1 } } }],
            ['名簿が読めない', { appType: 'classroom-spa', data: { [K.master]: '{broken' } }],
            ['名簿に students がない', { appType: 'classroom-spa', data: { [K.master]: '{"version":2}' } }]
        ];
        for (const [label, b] of bads) {
            const r = await restore(b);
            const post = await dump();
            check('不正な形式(' + label + '): 復元を中止(ok:false)し、全キーが1バイトも変わらない・退避もジャーナルも作らない', r && r.ok === false && /^invalid-/.test(r.error) && diffKeys(pre1, post).length === 0 && post[K.roster_snapshot] === undefined && post[K.roster_txn] === undefined && post[K.undo_br_snapshot] === undefined && post[K.undo_br_txn] === undefined, JSON.stringify(r).slice(0, 120) + ' diff=' + diffKeys(pre1, post).join(','));
        }
        const pl = await plan(bk);
        check('計画は書き込まない: 計画だけ呼んでも全キー不変', diffKeys(pre1, await dump()).length === 0, '');
        check('計画: 書くキー(差のあるもの)・変わらないキー・消すキー(名簿が違う)が決まる', pl.ok && pl.writes.length > 0 && pl.unchanged >= 0 && pl.rosterChanged === true, JSON.stringify({ w: pl.writes.length, u: pl.unchanged, s: pl.stale.length }));
        // レイヤーの優先順(rawLocalStorage → data。data が優先)
        const lay = await plan({ appType: 'classroom-spa', rawLocalStorage: { [K.tests]: '[1]', zz_layer: 'raw' }, data: { [K.tests]: '[2]' } });
        check('計画: rawLocalStorage と data が重なるキーは data が優先(従来と同じ)', lay.ok && lay.writes.filter(w => w[0] === K.tests)[0][1] === '[2]', JSON.stringify(lay.writes.slice(0, 3)));
        // 復元しないキー
        const sk = await plan({ appType: 'classroom-spa', data: { [K.roster_txn]: JSON.stringify({ state: 'applying' }), [K.roster_snapshot]: '{"keys":{}}', spa_capacity_probe: 'x', spa_wiped: '1', [K.tests]: '[]' } });
        check('復元しないキー(名簿変更のジャーナル・スナップショット・容量確認の一時キー・退勤モードの印)は計画に入らない', sk.ok && sk.skipped.length === 4 && !sk.writes.some(w => [K.roster_txn, K.roster_snapshot, 'spa_capacity_probe', 'spa_wiped'].indexOf(w[0]) !== -1), JSON.stringify(sk.skipped));
        const rs = await restore({ appType: 'classroom-spa', data: { [K.roster_txn]: JSON.stringify({ id: 'x', state: 'applying', kind: 'roster', at: 'now' }), [K.roster_snapshot]: JSON.stringify({ v: 1, keys: { [K.master]: null } }) } });
        const jk = await journal();
        check('悪意のある/古いバックアップの「applying」ジャーナルを復元しても、次の起動で名簿が消えない(ジャーナルは復元されない)', rs.ok && (jk === null || jk.state !== 'applying'), JSON.stringify(jk));

        // ================= 2. 正常系(同じ名簿) =================
        console.log('--- 2. 正常系(名簿が同じ) ---');
        await seed(A, 'old');
        const bk2 = await makeBackup();
        await seed(A, 'new', { omit: [K.forgotten_items] });          // 端末: 同じ名簿・値が新しい・forgotten_items はバックアップにあるが端末に無い
        await page.evaluate((K) => { storageVerifiedWrite(K.seating_groups, '["extra-group"]'); }, K); // バックアップに無い(非児童別)キー
        const pre2 = await dump();
        const pl2 = await plan(bk2);
        check('同じ名簿: 消すキーなし・バックアップに無いキーは「触らない」に分類', pl2.ok && pl2.rosterChanged === false && pl2.stale.length === 0 && pl2.kept.indexOf(K.seating_groups) !== -1, JSON.stringify({ stale: pl2.stale, kept: pl2.kept.slice(0, 5) }));
        const r2 = await restore(bk2);
        const post2 = await dump();
        check('復元: mode=snapshot・ok', r2.ok && r2.mode === 'snapshot', JSON.stringify(r2).slice(0, 200));
        const bkData = Object.assign({}, bk2.rawLocalStorage, bk2.data);
        const skipSet = new Set([K.roster_snapshot, K.roster_txn, K.undo_br_snapshot, K.undo_br_txn]);
        const diffBk = Object.keys(bkData).filter(k => !skipSet.has(k) && k !== OTHER_APP && !NOISE.test(k) && post2[k] !== bkData[k]);
        check('復元: バックアップの全キー(別アプリのキーを除く)が、端末の値と1バイトも違わない', diffBk.length === 0, diffBk.join(','));
        check('復元: バックアップに無い非児童別キー(seating_groups)は触らない', post2[K.seating_groups] === pre2[K.seating_groups], '');
        check('復元: 変わらないキーは書き込まない(端末とバックアップが同じ値のキーは不変)', pl2.unchanged >= 0 && Object.keys(pre2).filter(k => bkData[k] === pre2[k]).every(k => post2[k] === pre2[k]), '');
        check('別アプリのキー: 端末に既にある場合は上書きしない(バックアップの古い値で壊さない)', post2[OTHER_APP] === pre2[OTHER_APP] && post2[OTHER_APP] === 'other-app-new', post2[OTHER_APP]);
        const j2 = await journal();
        check('復元後: ジャーナルは committed・kind=backup-restore・ハッシュあり', j2 && j2.state === 'committed' && j2.kind === 'backup-restore' && j2.hashes && Object.keys(j2.hashes).length === r2.written + r2.removed, JSON.stringify(j2).slice(0, 160));
        const snap2 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), K.undo_br_snapshot);
        check('復元後: スナップショットに復元前の値(復元前に無かったキーは null)が入っている', snap2 && snap2.kind === 'backup-restore' && Object.keys(snap2.keys).every(k => snap2.keys[k] === (pre2[k] === undefined ? null : pre2[k])), '');

        // 取り消し: 復元前と1バイトも変わらない
        const ur = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        const post2u = await dump();
        check('復元の取り消し: ok・全キーが復元前と1バイトも変わらない(復元で増えたキーも消える)', ur.ok && diffKeys(pre2, post2u, true).length === 0, diffKeys(pre2, post2u, true).join(','));
        check('復元の取り消し後: スナップショット・ジャーナルは残らない', post2u[K.undo_br_snapshot] === undefined && post2u[K.undo_br_txn] === undefined, '');
        // 取り消しの拒否(復元後に入力があった)
        await seed(A, 'new'); await page.evaluate((K) => { storageVerifiedWrite(K.seating_groups, '["g"]'); }, K);
        await restore(bk2);
        await page.evaluate((K) => { storageVerifiedWrite(K.tests, '[{"id":9,"name":"復元後の入力"}]'); }, K);
        const ur2 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('復元のあとに入力があると取り消さない・専用の文言(バックアップを復元したあとに入力が…)', ur2.ok === false && ur2.error === 'changed-since' && (await toastHas('バックアップを復元したあとに入力があった')), JSON.stringify(ur2).slice(0, 120));
        check('取り消しを拒否したときデータは変わらない(入力した値が残る)', (await dump())[K.tests].indexOf('復元後の入力') !== -1, '');

        // ================= 3. バックアップに無い児童別キー =================
        console.log('--- 3. バックアップに無い児童別データの扱い ---');
        const missing = [K.karte_life, K.patrol, 'pf_records_2025'];
        // バックアップ(名簿A)から、児童別の3キーを除く(その時点では空だった想定)
        const bkMiss = JSON.parse(JSON.stringify(bk2)); missing.forEach(k => { delete bkMiss.data[k]; delete bkMiss.rawLocalStorage[k]; });
        // 3a: 名簿が違う端末(Brev)
        await seed(Brev, 'new');
        const pre3 = await dump();
        const p3 = await plan(bkMiss);
        check('名簿が違う: バックアップに無い児童別キー(カルテ生活・机間巡視・pf記録)は「消す」に分類', missing.every(k => p3.stale.indexOf(k) !== -1) && p3.stale.every(k => pre3[k] !== undefined), JSON.stringify(p3.stale));
        check('名簿が違う: 児童別でないキーは「消す」に入らない', p3.stale.indexOf(K.forgotten_items) === -1 && p3.stale.indexOf(K.tests) === -1 && p3.stale.indexOf(K.backup_meta) === -1, '');
        const r3 = await restore(bkMiss);
        const post3 = await dump();
        check('名簿が違う: 復元後、バックアップに無い児童別キーが端末から消えている(別の児童のデータとして残らない)', r3.ok && r3.removed >= missing.length && missing.every(k => post3[k] === undefined), JSON.stringify({ removed: r3.removed }));
        const u3 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('名簿が違う: 取り消すと、消えたキーも含めて復元前と1バイトも変わらない', u3.ok && diffKeys(pre3, await dump(), true).length === 0, diffKeys(pre3, await dump(), true).join(','));
        // 3b: 名簿が同じ端末(A)は消さない
        await seed(A, 'new');
        const pre3b = await dump();
        const p3b = await plan(bkMiss);
        const r3b = await restore(bkMiss);
        const post3b = await dump();
        check('名簿が同じ: バックアップに無い児童別キーも消さない(添字が同じ名簿を指すため安全)', p3b.stale.length === 0 && r3b.ok && missing.every(k => post3b[k] === pre3b[k]), JSON.stringify(p3b.stale));
        // 3c: pf: 名簿は同じだが pf の名簿がバックアップと違う → pf の記録(バックアップに無い)は消す
        await seed(A, 'new');
        const pfOther = pfData(A.slice().reverse(), 'x');                                            // 端末の pf 名簿は逆順
        await page.evaluate((pfOther) => { Object.keys(pfOther).forEach(k => storageVerifiedWrite(k, pfOther[k])); }, pfOther);
        const bkPf = JSON.parse(JSON.stringify(bk2)); ['pf_records_2025', 'pf_records_2026'].forEach(k => { delete bkPf.data[k]; delete bkPf.rawLocalStorage[k]; });
        const p3c = await plan(bkPf);
        check('名簿は同じだが pf の名簿が違う: バックアップに無い pf の記録は「消す」(pf の id は pf 名簿の位置なので)', !p3c.rosterChanged && p3c.stale.indexOf('pf_records_2025') !== -1 && p3c.stale.indexOf('pf_records_2026') !== -1, JSON.stringify(p3c.stale));
        // 3d: 名簿が違っても、バックアップに名簿(spa_master)が無ければ「名簿は変わらない」
        const bkNoMaster = JSON.parse(JSON.stringify(bk2)); delete bkNoMaster.data[K.master]; delete bkNoMaster.rawLocalStorage[K.master];
        await seed(Brev, 'new');
        const p3d = await plan(bkNoMaster);
        check('バックアップに名簿が無い: 名簿は変わらないので児童別キーは消さない', p3d.ok && p3d.rosterChanged === false && p3d.stale.length === 0, JSON.stringify(p3d.stale));
        // 別アプリのキーが端末に無ければ書く
        await seed(A, 'new', { otherApp: false });
        const pf3 = await plan(bk2);
        check('別アプリのキー: 端末に無ければ書く対象(foreignFill)', pf3.foreignFill.some(w => w[0] === OTHER_APP), '');
        const rf = await restore(bk2);
        check('別アプリのキー: 端末に無かったときはバックアップの値が入る', rf.ok && (await dump())[OTHER_APP] === 'other-app-old', (await dump())[OTHER_APP]);

        // ================= 4. 失敗注入(退避あり): すべての書き込み位置 =================
        console.log('--- 4. 失敗注入: 容量超過・内容破損・強制終了(各書き込み位置) ---');
        await seed(A, 'old');
        const bkF = await makeBackup();
        ['spa_karte_life', 'spa_patrol', 'pf_records_2025'].forEach(k => { delete bkF.data[k]; delete bkF.rawLocalStorage[k]; }); // バックアップに無い児童別キー → 名簿が違う端末では「消す」対象(消す操作の途中でも注入する)
        await seed(Brev, 'new');
        const preF = await dump();
        const pF = await plan(bkF);
        const fkeys = planKeys(pF);
        const nSet = pF.writes.length, nAll = fkeys.length;
        check('注入の前提: 書くキーと消すキー(3件)が十分ある', nSet >= 12 && pF.stale.length === 3, 'writes=' + nSet + ' stale=' + pF.stale.length);
        let badQuota = [], badCorrupt = [], badCrash = [];
        for (let i = 0; i < nSet; i++) {
            await seed(Brev, 'new');
            await fault('quota', i, fkeys);
            const r = await restore(bkF);
            await unfault();
            const post = await dump();
            if (!(r.ok === false && r.error === 'apply-failed' && r.rolledBack === true && diffKeys(preF, post).length === 0)) badQuota.push(i + ':' + JSON.stringify(r).slice(0, 80) + ':' + diffKeys(preF, post).slice(0, 2).join(','));
        }
        check('容量超過を各書き込み位置(' + nSet + '通り)で注入: すべてロールバックされ、全キーが復元前と1バイトも変わらない(スナップショット・ジャーナルも残らない)', badQuota.length === 0, badQuota.slice(0, 3).join(' | '));
        for (let i = 0; i < nSet; i++) {
            await seed(Brev, 'new');
            await fault('corrupt', i, fkeys);
            const r = await restore(bkF);
            await unfault();
            const post = await dump();
            if (!(r.ok === false && r.error === 'apply-failed' && r.rolledBack === true && diffKeys(preF, post).length === 0)) badCorrupt.push(i + ':' + JSON.stringify(r).slice(0, 80) + ':' + diffKeys(preF, post).slice(0, 2).join(','));
        }
        check('内容の破損(読み戻しの不一致)を各書き込み位置(' + nSet + '通り)で注入: すべてロールバックされ、全キーが復元前と同一', badCorrupt.length === 0, badCorrupt.slice(0, 3).join(' | '));
        for (let i = 0; i < nAll; i++) {
            await seed(Brev, 'new');
            const pre = await dump();
            await fault('crash', i, fkeys);
            const r = await restore(bkF);           // 強制終了: 以降の書き込み・削除がすべて失敗(ロールバックも失敗する)
            await unfault();
            await reloadWait();                     // 再起動 → 起動時の自動復旧
            const post = await dump();
            const sane = await page.evaluate(() => typeof master !== 'undefined' && Array.isArray(master.students));
            if (!(diffKeys(pre, post).length === 0 && post[K.undo_br_txn] === undefined && post[K.undo_br_snapshot] === undefined && post[K.roster_txn] === undefined && post[K.roster_snapshot] === undefined && sane)) badCrash.push(i + ':' + diffKeys(pre, post).slice(0, 3).join(',') + ':' + r.error);
        }
        check('強制終了を各書き込み・削除の位置(' + nAll + '通り)で再現: 再起動で自動的に復元前へ戻り、全キーが1バイトも変わらない(ジャーナル・スナップショットも消える)', badCrash.length === 0, badCrash.slice(0, 3).join(' | '));
        await seed(Brev, 'new');
        await fault('crash', 3, fkeys); await restore(bkF); await unfault();
        await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(600);
        check('強制終了からの復旧: 「バックアップの復元が途中で中断したため、復元前の状態に戻しました」を起動時に表示', await toastHas('バックアップの復元が途中で中断'), '');

        const sk2 = await plan({ appType: 'classroom-spa', data: Object.assign({ [K.tests]: '[]' }, ...['undo_br', 'undo_pft', 'undo_pfr', 'undo_imf', 'undo_pfm'].map(p => ({ [K[p + '_snapshot']]: '{"keys":{}}', [K[p + '_txn']]: JSON.stringify({ state: 'applying' }) }))) });
        check('復元しないキー: 種類別の取り消し点(バックアップの復元・引き継ぎ・pfの復元・入力形式・pf移行)のスナップショット・ジャーナルも計画に入らない', sk2.ok && sk2.skipped.length === 10 && sk2.writes.every(w => !/^spa_undo_/.test(w[0])), JSON.stringify(sk2.skipped).slice(0, 200));

        // ================= 5. 容量が足りず退避できない → 警告して続行 =================
        console.log('--- 5. 退避できないとき: 警告して復元を続行 ---');
        for (const [mode, label] of [['probe', '容量確認が失敗'], ['snapshot', 'スナップショットの書き込みが失敗']]) {
            await seed(Brev, 'new');
            const prevSnap = JSON.stringify({ v: 1, txnId: 'prev', at: '2026-01-01T00:00:00.000Z', kind: 'roster', keys: {} });
            const prevJ = JSON.stringify({ id: 'prev', state: 'committed', at: '2026-01-01T00:00:00.000Z', kind: 'roster', hashes: {} });
            await page.evaluate((K, a, b) => { storageVerifiedWrite(K.undo_br_snapshot, a); storageVerifiedWrite(K.undo_br_txn, b); }, K, prevSnap, prevJ);
            const pre = await dump();
            await fault(mode, 0, []);
            const r = await restore(bkF);
            await unfault();
            const post = await dump();
            const bkAll = Object.assign({}, bkF.rawLocalStorage, bkF.data);
            const wrong = pF.writes.filter(w => post[w[0]] !== w[1]).map(w => w[0]);
            check('退避できない(' + label + '): 復元は続行される(ok・mode=no-snapshot・書くキーがすべてバックアップの値になる)', r.ok && r.mode === 'no-snapshot' && wrong.length === 0, JSON.stringify(r).slice(0, 160) + ' wrong=' + wrong.join(','));
            check('退避できない(' + label + '): 消す操作はしない(バックアップに無い児童別キーは残り、staleKept に報告)', r.staleKept.length === pF.stale.length && pF.stale.every(k => post[k] === pre[k]), JSON.stringify(r.staleKept));
            check('退避できない(' + label + '): 以前の取り消し点(スナップショット・ジャーナル)は壊さない', post[K.undo_br_snapshot] === prevSnap && post[K.undo_br_txn] === prevJ, '');
        }
        // 退避なし + あるキーが常に書けない → 部分的な失敗として報告(ok:false, partial-restore)、他のキーは書かれる
        await seed(Brev, 'new');
        const failKey = pF.writes[5][0];
        await fault('probe', 0, []);
        await page.evaluate((k) => { window.__fault2 = true; const o = Storage.prototype.setItem; const c = window.__fault.restore; Storage.prototype.setItem = function(key, v) { if (key === k) throw new DOMException('quota', 'QuotaExceededError'); return o.apply(this, arguments); }; window.__fault.restore = function() { Storage.prototype.setItem = o; c(); }; }, failKey);
        const rp = await restore(bkF);
        await unfault();
        const postp = await dump();
        check('退避なしで1キーだけ書けない: ok:false・partial-restore・失敗したキーを報告・書けたキーはバックアップの値', rp.ok === false && rp.error === 'partial-restore' && rp.failed.length === 1 && rp.failed[0] === failKey && pF.writes.filter(w => w[0] !== failKey).every(w => postp[w[0]] === w[1]), JSON.stringify(rp).slice(0, 200));
        // 退避なしで、書き込みが1回だけ壊れる(内容破損) → 再試行で回復
        await seed(Brev, 'new');
        await fault('probe', 0, []);
        await page.evaluate((keys) => { const set = new Set(keys); let n = 0; const o = Storage.prototype.setItem; const c = window.__fault.restore; Storage.prototype.setItem = function(key, v) { if (set.has(key) && n++ === 2) return o.call(this, key, String(v).slice(0, -3)); return o.apply(this, arguments); }; window.__fault.restore = function() { Storage.prototype.setItem = o; c(); }; }, fkeys);
        const rr = await restore(bkF);
        await unfault();
        const postr = await dump();
        check('退避なしで書き込みが1回壊れる: 再試行で回復し、全キーがバックアップの値になる', rr.ok && rr.mode === 'no-snapshot' && pF.writes.every(w => postr[w[0]] === w[1]), JSON.stringify(rr).slice(0, 160));

        // ================= 6. 保存待ちの古い値で上書きしない =================
        console.log('--- 6. 保存待ち(デバウンス)の古い値 ---');
        await seed(A, 'old'); const bk6 = await makeBackup();
        await seed(A, 'new');
        const goodTests = bk6.data[K.tests];
        await page.evaluate((K) => { StorageManager.set(K.tests, JSON.stringify([{ id: 77, name: '保存待ちの古い値' }])); StorageManager.set(K.forgotten_items, JSON.stringify(['保存待ちの古い値'])); }, K);
        const r6 = await restore(bk6);
        await sleep(1800);
        const post6 = await dump();
        check('保存待ちの値がある状態で復元しても、しばらく後(デバウンスの時間が過ぎたあと)もバックアップの値のまま', r6.ok && post6[K.tests] === goodTests && post6[K.forgotten_items] === bk6.data[K.forgotten_items], (post6[K.tests] || '').slice(0, 60));

        // ================= 7. 古い形式のバックアップ(児童IDなし)・再読み込み後の取り消し =================
        console.log('--- 7. 児童IDのない古いバックアップ・再読み込み後の取り消し ---');
        await seed(A, 'old');
        const bkOld = await makeBackup();
        // 古い形式: 児童IDなし・appType なし(rawLocalStorage のみ)・version 10 相当
        const stripId = (raw) => { const m = JSON.parse(raw); m.students = m.students.map(s => { const c = Object.assign({}, s); delete c.studentId; return c; }); return JSON.stringify(m); };
        const legacy = { version: 9, rawLocalStorage: Object.assign({}, bkOld.rawLocalStorage) };
        legacy.rawLocalStorage[K.master] = stripId(bkOld.data[K.master]);
        await seed(A, 'new');
        const preL = await dump();
        const fileL = writeTmp('legacy-backup.json', legacy);
        await page.evaluate(() => { openBackupModal(); });
        const inp = await page.$('#restoreFile');
        await inp.uploadFile(fileL);
        await page.click('button[onclick="importBackup()"]');
        await sleep(1800);
        await page.waitForFunction(() => typeof StorageManager !== 'undefined' && document.readyState === 'complete');
        await sleep(1500);
        const postL = await dump();
        const mL = JSON.parse(postL[K.master]);
        check('古い形式のバックアップ(appType なし・児童IDなし): 復元でき、再読み込み後に児童IDが付与される', mL.students.length === 6 && mL.students.every(s => /^stu_/.test(s.studentId)) && postL[K.tests] === legacy.rawLocalStorage[K.tests], '');
        check('再読み込み後: 「復元を取り消す」が使える(起動時の児童ID付与で名簿が書き換わっていても、入力があったと誤判定しない)', await page.evaluate(() => srUndoStatus().available && srUndoStatus().kind === 'backup-restore'), JSON.stringify(await page.evaluate(() => srUndoStatus())));
        check('再読み込み後: 復元を知らせるトーストに「元に戻す」が付く', await page.waitForFunction(() => { const b = document.getElementById('toastUndoBtn'); const t = document.getElementById('toast'); return !!b && b.style.display !== 'none' && t.classList.contains('show') && (document.getElementById('toastMsg').textContent || '').indexOf('復元') !== -1; }, { timeout: 8000, polling: 100 }).then(() => true).catch(() => false), '');
        await page.evaluate(() => { showView('settings'); }); await sleep(300);
        const barText = await page.evaluate(() => { const b = document.getElementById('rosterUndoBtn'); return b ? b.textContent : null; });
        check('設定の名簿カードの取り消しボタンが「バックアップの復元を取り消す」表記になる', barText && barText.indexOf('バックアップの復元を取り消す') !== -1, barText);
        // トーストの「元に戻す」は約8秒で消えるため、ボタンで取り消す(画面の実操作)
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#rosterUndoBtn')]);
        check('取り消し後の再読み込み: 「バックアップの復元を取り消しました」と表示', await toastHas('復元を取り消しました', 5000), '');
        await sleep(1500); await page.waitForFunction(() => typeof StorageManager !== 'undefined');
        const postLU = await dump();
        check('取り消し: 復元前の値に戻る(テスト・名簿の目印)', JSON.parse(postLU[K.master]).classInfo.teacher === 'Tnew' && postLU[K.tests] === preL[K.tests], '');

        // ================= 8. 名簿の読み込みに失敗している端末(復旧の道) =================
        console.log('--- 8. 名簿が壊れている端末への復元 ---');
        await seed(A, 'old'); const bk8 = await makeBackup();
        await seed(A, 'new');
        await page.evaluate((K) => { localStorage.setItem(K.master, '{broken'); masterLoadFailed = true; }, K);
        const r8 = await restore(bk8);
        check('名簿が壊れて読み込みに失敗している端末にも復元できる(復旧の道を塞がない)', r8.ok && (await dump())[K.master] === bk8.data[K.master], JSON.stringify(r8).slice(0, 100));
        await page.evaluate(() => { masterLoadFailed = false; });

        // ================= 9. 画面(バックアップ画面)での操作 =================
        console.log('--- 9. 画面の操作(ファイル選択 → 復元ボタン) ---');
        await seed(A, 'old'); const bk9 = await makeBackup();
        delete bk9.data[K.karte_life]; delete bk9.rawLocalStorage[K.karte_life];   // バックアップに無い児童別キー(端末は名簿が違う)
        await seed(Brev, 'new');
        const pre9 = await dump();
        const file9 = writeTmp('good-backup.json', bk9);
        await page.evaluate(() => { openBackupModal(); });
        const inp9 = await page.$('#restoreFile');
        await inp9.uploadFile(file9);
        await page.click('button[onclick="importBackup()"]');
        check('復元ボタン: 「バックアップを復元しました」のトースト', await toastHas('バックアップを復元しました', 3000), '');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        check('再読み込み後: 名簿が違うためバックアップに無い児童別データを消去したことを通知', await toastHas('名簿が違うため消去しました', 4000), '');
        await sleep(1500); await page.waitForFunction(() => typeof StorageManager !== 'undefined');
        check('画面から復元: バックアップに無かった児童別キー(カルテ生活)が消えている', (await dump())[K.karte_life] === undefined && pre9[K.karte_life] !== undefined, '');
        const post9 = await dump();
        check('画面から復元: 名簿・テスト・児童別データがバックアップの内容になる', post9[K.master] !== undefined && JSON.parse(post9[K.master]).students[0].name === A[0].name && post9[K.tests] === bk9.data[K.tests], '');
        check('画面から復元: 再読み込み後、取り消せる(kind=backup-restore)', await page.evaluate(() => srUndoStatus().available && srUndoStatus().kind === 'backup-restore'), '');
        // 不正なファイル(再読み込み後の通知(警告→取り消しトースト)が出終わるのを待ってから)
        await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'), { timeout: 20000, polling: 200 });
        await seed(A, 'new'); const pre9b = await dump();
        for (const [label, content] of [['JSONでない文字列(暗号化扱いになる)', 'not json at all'], ['JSONだが形式が違う', '{"hello":1}'], ['壊れたJSON', '{"appType":"classroom-spa",']]) {
            await page.evaluate(() => { openBackupModal(); });
            const f = writeTmp('bad-backup.json', content);
            const inp2 = await page.$('#restoreFile'); await inp2.uploadFile(f);
            await page.click('button[onclick="importBackup()"]');
            await sleep(700);
            const p = await dump();
            check('不正なファイル(' + label + '): データは変更されない', diffKeys(pre9b, p).length === 0, diffKeys(pre9b, p).join(','));
            if (label !== 'JSONでない文字列(暗号化扱いになる)') check('不正なファイル(' + label + '): エラーのトーストを表示(「変更されていません」)', await toastHas('変更されていません', 1500), '');
            await page.evaluate(() => { closeBackupModal(); document.getElementById('dec-password-area').style.display = 'none'; });
        }
        // 容量が足りず退避できない端末(画面から): 警告を出して復元を続行
        await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'), { timeout: 20000, polling: 200 });
        await seed(Brev, 'new');
        const bk9c = JSON.parse(JSON.stringify(bk9));
        await fault('probe', 0, []);
        await page.evaluate(() => { openBackupModal(); });
        const inp9c = await page.$('#restoreFile'); await inp9c.uploadFile(writeTmp('good-backup2.json', bk9c));
        await page.click('button[onclick="importBackup()"]');
        check('容量が足りず退避できない(画面から): 復元は続行され「復元しました」と表示', await toastHas('バックアップを復元しました', 3000), '');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        check('容量が足りず退避できない(画面から): 再読み込み後に「復元前の状態は保存されていません(取り消せません)」の警告', await toastHas('復元前の状態は保存されていません', 4000), '');
        await sleep(1500); await page.waitForFunction(() => typeof StorageManager !== 'undefined');
        const post9c = await dump();
        check('容量が足りず退避できない(画面から): データはバックアップの内容になり、取り消しは提供されない', JSON.parse(post9c[K.master]).students[0].name === A[0].name && post9c[K.tests] === bk9c.data[K.tests] && !(await page.evaluate(() => srUndoStatus().available)), '');
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);

        // ================= 10. バックアップの書き出し(変更なしの確認) =================
        console.log('--- 10. 書き出し ---');
        await seed(A, 'new');
        await page.evaluate((K, s, t) => { Object.keys(K).filter(k => /^(roster_|undo_)/.test(k)).forEach(k => { storageVerifiedWrite(K[k], /snapshot$/.test(k) ? s : t); }); }, K, '{"v":1,"keys":{}}', '{"state":"committed"}');
        const ex = await makeBackup();
        check('書き出し: version 10・appType・スナップショット/ジャーナルを含めない・pf を含める', ex.version === 10 && ex.appType === 'classroom-spa' && Object.keys(K).filter(k => /^(roster_|undo_)/.test(k)).every(k => ex.data[K[k]] === undefined && ex.rawLocalStorage[K[k]] === undefined) && ex.rawLocalStorage['pf_roster'] !== undefined, '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし(注入した意図的なエラーを除く)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== backup-restore: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
