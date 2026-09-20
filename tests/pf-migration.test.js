// H4 案B 段階4b: 新体力テスト(pf)の児童ID(studentId)化。
//   1. 起動時の移行(旧方式 v1: 記録のキー=位置+1 → 新方式 v2: 記録のキー=studentId)
//      - pf_roster がSPA名簿と一致するときだけ変換 / 移行前後で、pf 以外の全キーが1バイトも変わらない(全キー比較)
//      - 失敗注入(容量超過・内容破損・強制終了・容量不足・移行中に他のキーが変わる)で、記録は移行前のまま
//   2. v2 の名簿変更: 並べ替え・削除・転入・改名で、pf の記録が studentId に付いたまま(ずれ0)、削除は退避、取り消し・復元
//   3. 取り込み(grdImportFitnessTest): studentId で照合(同姓同名でも取り込める)
//   4. 内蔵版 pf 画面: 入力・保存・名簿の並べ替え後の表示・名簿の読み込み(年齢の引き継ぎ・手入力の児童の保持)
//   5. バックアップ(旧方式)の復元後の再移行
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pf-migration.test.js

const puppeteer = require('puppeteer-core');
const { buildRaws, ownersOf, misplaced, STORE_NAMES, mkStudents, OPS } = require('./helpers/roster-data');
const ui = require('./helpers/roster-ui');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;
const PF_KEYS = ['pf_fitness_2026', 'pf_records_2025', 'pf_records_2026', 'pf_roster'];
const isPf = (k) => /^pf_/.test(k);

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1 && !/crash|quota|verify failed|migratePfStudentIdV1|rolling back/.test(t)) consoleErrors.push(t); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const INFRA = [K.roster_snapshot, K.roster_txn, K.undo_pfm_snapshot, K.undo_pfm_txn]; // 起動時の自動移行は専用の枠(v1.57.0)

    // ---------- 端末の状態を作る ----------
    // 旧方式(v1)の pf: pf_roster(id=位置+1・age・note)・記録(2年度)・集計。値に持ち主(studentId)の目印(_owner)を埋め込む。氏名が空の児童は pf が除外する。
    const pfV1 = (students, opts) => {
        opts = opts || {};
        const roster = [], rec26 = {}, rec25 = {}, fit26 = {};
        students.forEach((s, i) => {
            if (!s.name) return;
            roster.push({ id: i + 1, name: s.name, gender: s.gender || '', age: 10 + (i % 2), note: 'n' + i });
            rec26[String(i + 1)] = { 握力: 20 + i, _owner: s.studentId };
            if (opts.y2025 !== false) rec25[String(i + 1)] = { 握力: 10 + i, _owner: s.studentId };
            if (opts.fitness !== false) fit26[String(i + 1)] = { total: 30 + i, eval: 'B', year: 2026, detail: {}, _owner: s.studentId };
        });
        const o = { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec26), pf_setting: JSON.stringify({ year: 2026, grade: 5, className: '5年1組' }) };
        if (opts.y2025 !== false) o.pf_records_2025 = JSON.stringify(rec25);
        if (opts.fitness !== false) o.pf_fitness_2026 = JSON.stringify(fit26);
        return o;
    };
    async function seed(n, o) {
        o = o || {};
        const students = mkStudents(n || 27);
        if (o.blank !== undefined) students[o.blank] = Object.assign({}, students[o.blank], { name: '' });
        if (o.dupNames) { students[1] = Object.assign({}, students[1], { name: students[0].name }); }
        const raws = buildRaws(K, students);
        const pf = o.pf === null ? {} : Object.assign(pfV1(students, o.pfOpts), o.pfOverride || {});
        const extras = { [K.tests]: '[{"id":1,"subject":"算数","name":"t","category":"知識・技能","maxScore":100,"date":"2026-05-10","term":"1"}]', 'doc-index-v1': 'other-app' };
        await page.evaluate((K, raws, extras, pf, students) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).concat(Object.keys(extras)).forEach(k => storageVerifiedWrite(k, raws[k] !== undefined ? raws[k] : extras[k]));
            Object.keys(pf).forEach(k => { if (pf[k] !== null) storageVerifiedWrite(k, pf[k]); });
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, extras, pf, students);
        return { students, raws, pf };
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (a, b, opt) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(k => !NOISE.test(k) && (!opt || !opt.infra || INFRA.indexOf(k) === -1) && a[k] !== b[k]);
    const reload = async (wait) => { await page.reload({ waitUntil: wait || 'networkidle0' }); await sleep(900); };
    const toastHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 1500, polling: 50 }, t).then(() => true).catch(() => false);
    const migrate = () => page.evaluate(() => window.migratePfStudentIdV1());
    const plan = (raws, students) => page.evaluate((r, s) => { const keyed = {}; Object.keys(r).forEach(k => { if (/^pf_(records|fitness)_\d+$/.test(k)) keyed[k] = r[k]; }); return window.planPfMigration({ roster: r.pf_roster === undefined ? null : r.pf_roster, keyed }, s); }, raws, students);
    // 期待値(アプリのコードを使わず、テスト側で独立に計算): 位置+1 の id → その位置の児童の studentId
    const expectV2 = (pf, students) => {
        const out = {}; const idToSid = {};
        JSON.parse(pf.pf_roster).forEach(e => { idToSid[e.id] = students[e.id - 1].studentId; });
        Object.keys(pf).forEach(k => {
            if (k === 'pf_roster') out[k] = JSON.parse(pf[k]).map(e => Object.assign({}, e, { studentId: idToSid[e.id] }));
            else if (/^pf_(records|fitness)_\d+$/.test(k)) { const o = {}; Object.keys(JSON.parse(pf[k])).forEach(id => { o[idToSid[id]] = JSON.parse(pf[k])[id]; }); out[k] = o; }
        });
        return out;
    };
    const fault = (mode, at, keys, sneak) => page.evaluate((mode, at, keys, sneak, K) => {
        const set = new Set(keys), state = { n: 0 };
        const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
        window.__fault = { state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
        Storage.prototype.setItem = function(k, v) {
            if (mode === 'probe' && k === 'spa_capacity_probe') throw new DOMException('quota', 'QuotaExceededError');
            if (mode === 'snapshot' && k === K.undo_pfm_snapshot) throw new DOMException('quota', 'QuotaExceededError');
            if (mode === 'sneak' && k === 'pf_roster') { oSet.call(this, sneak.key, sneak.value); }
            if (set.has(k) && (mode === 'quota' || mode === 'corrupt' || mode === 'crash')) {
                if (mode === 'crash' && state.n >= at) throw new Error('crash');
                const i = state.n++;
                if (mode === 'quota' && i === at) throw new DOMException('quota', 'QuotaExceededError');
                if (mode === 'corrupt' && i === at) return oSet.call(this, k, String(v).slice(0, Math.max(0, String(v).length - 3)));
            }
            return oSet.apply(this, arguments);
        };
        Storage.prototype.removeItem = function(k) { if (set.has(k) && mode === 'crash' && state.n >= at) throw new Error('crash'); return oRem.apply(this, arguments); };
    }, mode, at === undefined ? 1e9 : at, keys || [], sneak || null, K);
    const unfault = () => page.evaluate(() => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } });

    const OPSV = OPS;
    const applyNS = (ns) => page.evaluate((ns) => window.applyRosterChange(ns, { reload: false }), ns);
    const v2seed = async (n, o) => { const s = await seed(n, o); await reload(); await sleep(600); return s; };
    // 環境変数 PFM_ONLY=1,4 のように指定すると、その章だけを実行する(変異テストの短縮用。通常は全章)
    const on = (n) => !process.env.PFM_ONLY || process.env.PFM_ONLY.split(',').indexOf(String(n)) !== -1;

    try {
        // ================= 1. 計画(純関数) =================
        if (on(1)) {
        console.log('--- 1. 移行の計画(書き込みなし) ---');
        {
            const s = await seed(6, { pfOpts: { fitness: true } });
            const p = await plan(s.pf, s.students);
            const exp = expectV2(s.pf, s.students);
            check('一致: status=migrate・記録件数(2026年度6+2025年度6+集計6=18)', p.status === 'migrate' && p.records === 18 && p.keys === 3, JSON.stringify({ st: p.status, rec: p.records, keys: p.keys, viol: p.violations }));
            check('一致: 変換後の pf_roster・記録・集計が、テスト側で独立に計算した期待値と完全に一致する(キーは studentId)', Object.keys(exp).every(k => JSON.stringify(JSON.parse(p.newRaw[k])) === JSON.stringify(exp[k])), '');
            check('一致: 不変条件 M1〜M6 の違反なし', p.violations.length === 0, JSON.stringify(p.violations));
            const bl = await seed(6, { blank: 2 });
            const pb = await plan(bl.pf, bl.students);
            check('氏名が空の児童がいる名簿: pf が除外して採番した id(位置+1、欠番あり)のまま正しく変換される', pb.status === 'migrate' && pb.violations.length === 0 && JSON.parse(pb.newRaw.pf_roster).map(e => e.id).join() === '1,2,4,5,6' && Object.keys(JSON.parse(pb.newRaw.pf_records_2026)).indexOf(bl.students[3].studentId) !== -1, '');
            const again = await plan(Object.assign({}, s.pf, { pf_roster: pb.newRaw.pf_roster }), s.students);
            check('新方式(v2)に変換済みなら status=already(冪等)・pf のデータなしなら none', (await plan(Object.fromEntries(Object.keys(exp).map(k => [k, JSON.stringify(exp[k])])), s.students)).status === 'already' && (await plan({}, s.students)).status === 'none' && again.status !== undefined, '');
            const skipCase = async (label, mut, reason) => { const t = await seed(6); const pf = JSON.parse(JSON.stringify(t.pf)); const stu = mut(pf, t.students) || t.students; const r = await plan(pf, stu); check('移行しない(' + label + '): status=skip・reason=' + reason + '・何も書く計画がない', r.status === 'skip' && r.reason === reason && Object.keys(r.newRaw).length === 0, JSON.stringify(r).slice(0, 150)); };
            await skipCase('順序違い', (pf) => { const r = JSON.parse(pf.pf_roster); [r[0], r[1]] = [r[1], r[0]]; pf.pf_roster = JSON.stringify(r); }, 'name-or-order-differs');
            await skipCase('氏名違い', (pf) => { const r = JSON.parse(pf.pf_roster); r[2].name += '改'; pf.pf_roster = JSON.stringify(r); }, 'name-or-order-differs');
            await skipCase('人数違い', (pf) => { const r = JSON.parse(pf.pf_roster); r.pop(); pf.pf_roster = JSON.stringify(r); }, 'length-differs');
            await skipCase('idが位置+1でない', (pf) => { const r = JSON.parse(pf.pf_roster); r[3].id = 99; pf.pf_roster = JSON.stringify(r); }, 'id-not-position');
            await skipCase('名簿なし(記録のみ)', (pf) => { delete pf.pf_roster; }, 'no-roster');
            await skipCase('名簿が壊れている', (pf) => { pf.pf_roster = '{broken'; }, 'roster-invalid');
            await skipCase('記録が名簿に無い id(手入力・過去の削除の取り残し)を含む', (pf) => { const r = JSON.parse(pf.pf_records_2026); r['99'] = { 握力: 1 }; pf.pf_records_2026 = JSON.stringify(r); }, 'records-not-in-roster');
            await skipCase('記録が壊れている', (pf) => { pf.pf_records_2026 = '[1,2]'; }, 'records-invalid');
            await skipCase('記録のキーが名簿に無い文字列', (pf) => { const r = JSON.parse(pf.pf_records_2026); r['abc'] = {}; pf.pf_records_2026 = JSON.stringify(r); }, 'records-invalid');
            await skipCase('名簿の studentId がSPAの位置の児童と食い違う', (pf, st) => { const r = JSON.parse(pf.pf_roster); r[0].studentId = 'stu_other'; pf.pf_roster = JSON.stringify(r); }, 'studentid-conflict');
            await skipCase('SPAの児童に studentId が無い', (pf, st) => st.map((x, i) => i === 0 ? Object.assign({}, x, { studentId: undefined }) : x), 'no-student-id');
            await skipCase('数字のキーと同じ児童の studentId のキーが両方ある', (pf, st) => { const r = JSON.parse(pf.pf_records_2026); r[st[0].studentId] = { x: 1 }; pf.pf_records_2026 = JSON.stringify(r); const ro = JSON.parse(pf.pf_roster); pf.pf_roster = JSON.stringify(ro); }, 'collision');
        }

        }
        // ================= 2. 起動時の移行(27名・全キー比較) =================
        if (on(2)) {
        console.log('--- 2. 起動時の移行(27名。移行前後の全キー比較) ---');
        {
            const s = await seed(27, { blank: 4 });
            const exp = expectV2(s.pf, s.students);
            const pre = await dump();
            await reload('domcontentloaded');
            check('移行: 起動時に「新しい方式に更新しました(内容は変わっていません)」と通知される', await toastHas('新しい方式に更新しました', 3000), '');
            await sleep(1500);
            const post = await dump();
            const changed = diffKeys(pre, post);
            check('移行: 変わったキーは pf の4キー(名簿・記録2年度・集計)だけ', JSON.stringify(changed.sort()) === JSON.stringify(PF_KEYS.slice().sort()), changed.join(','));
            check('移行: pf 以外の全キー(' + Object.keys(pre).filter(k => !isPf(k)).length + '件。名簿・18ストア・別アプリのキー含む)が移行前と1バイトも変わらない', diffKeys(pre, post).filter(k => !isPf(k)).length === 0, '');
            check('移行: pf_roster・記録・集計がテスト側の期待値と完全に一致(キーは studentId・値は不変)', PF_KEYS.every(k => JSON.stringify(JSON.parse(post[k])) === JSON.stringify(exp[k])), '');
            const rec = JSON.parse(post.pf_records_2026);
            check('移行: 記録26名分(氏名が空の1名は除外)がすべて持ち主のキーに付いている(_owner=キー)・数字のキーが残らない', Object.keys(rec).length === 26 && Object.keys(rec).every(k => rec[k]._owner === k && /^stu_/.test(k)), Object.keys(rec).length + '');
            check('移行: pf_roster は id(位置+1・欠番あり)・age・note を保ち studentId が付く', JSON.parse(post.pf_roster).every(e => e.note === 'n' + (e.id - 1) && e.age === 10 + ((e.id - 1) % 2) && e.studentId === s.students[e.id - 1].studentId), '');
            check('移行: スナップショット・ジャーナルは残らない(確定後に掃除)', post[K.undo_pfm_snapshot] === undefined && post[K.undo_pfm_txn] === undefined && post[K.roster_snapshot] === undefined && post[K.roster_txn] === undefined, '');
            const flag = JSON.parse(post.migration_pfStudentId_v1 || 'null');
            check('移行: 完了の印に結果(記録数・比較した他のキー数)が残る', flag && flag.records === 26 * 3 && flag.keys === 3 && flag.compared >= 20 && flag.unchanged === true, JSON.stringify(flag));
            const mirror = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('spa_classroom_db'); q.onsuccess = (e) => { const db = e.target.result; const g = db.transaction('kv', 'readonly').objectStore('kv').getAll(); g.onsuccess = () => { db.close(); res(g.result); }; }; }));
            check('移行: IndexedDB(鏡)の pf キーが localStorage と一致', PF_KEYS.every(k => (mirror.find(x => x.key === k) || {}).value === post[k]), '');
            // 2回目の起動: 何も変わらない・通知しない
            await reload('domcontentloaded');
            check('2回目の起動: 移行しない(通知なし)', !(await toastHas('新しい方式に更新しました', 1200)), '');
            await sleep(1500);
            check('2回目の起動: 全キーが1バイトも変わらない(冪等)', diffKeys(post, await dump()).length === 0, diffKeys(post, await dump()).join(','));
            // 診断カード(4a)の表示
            await page.evaluate(() => { showView('settings'); }); await sleep(300);
            const mt = await page.$eval('#pfDiagBody [data-pfd="mode"]', el => el.textContent);
            check('診断カード: 「児童ごと（新方式）」と移行の結果(記録件数・ほかの全データが変化なし)を表示', mt.indexOf('児童ごと（新方式）') !== -1 && mt.indexOf('記録 78件') !== -1 && mt.indexOf('変化なし') !== -1, mt);
            check('診断カード: 名簿は「一致しています」のまま', (await page.$eval('#pfDiagBody [data-pfd="state"]', el => el.textContent)).indexOf('一致しています') !== -1, '');
        }

        }
        // ================= 3. 起動時に移行しない端末(触らない) =================
        if (on(3)) {
        console.log('--- 3. 移行しない端末: pf は1バイトも変わらない ---');
        {
            const cases = [
                ['順序違い', (pf) => { const r = JSON.parse(pf.pf_roster); [r[0], r[1]] = [r[1], r[0]]; pf.pf_roster = JSON.stringify(r); }],
                ['氏名違い', (pf) => { const r = JSON.parse(pf.pf_roster); r[2].name += '改'; pf.pf_roster = JSON.stringify(r); }],
                ['余分な児童(手入力の痕跡)', (pf) => { const r = JSON.parse(pf.pf_roster); r.push({ id: 7, name: '手入力', gender: '男', age: 10 }); pf.pf_roster = JSON.stringify(r); }],
                ['名簿なし', (pf) => { delete pf.pf_roster; }],
                ['壊れた名簿', (pf) => { pf.pf_roster = '{broken'; }]
            ];
            for (const [label, mut] of cases) {
                const t = await seed(6); const pf = JSON.parse(JSON.stringify(t.pf)); mut(pf);
                await seed(6, { pfOverride: Object.fromEntries(Object.keys(pf).map(k => [k, pf[k]])) });
                if (label === '名簿なし') await page.evaluate(() => localStorage.removeItem('pf_roster'));
                const pre = await dump();
                await reload();
                const post = await dump();
                check('移行しない(' + label + '): 全キー(pf を含む)が1バイトも変わらない・完了の印なし・通知なし', diffKeys(pre, post).length === 0 && post.migration_pfStudentId_v1 === undefined && !(await toastHas('新しい方式に更新しました', 300)), diffKeys(pre, post).join(','));
            }
            const t2 = await seed(6, { pfOverride: { pf_roster: (() => { const r = JSON.parse(pfV1(mkStudents(6)).pf_roster); [r[0], r[1]] = [r[1], r[0]]; return JSON.stringify(r); })() } });
            await reload(); await page.evaluate(() => { showView('settings'); }); await sleep(300);
            const mt = await page.$eval('#pfDiagBody [data-pfd="mode"]', el => el.textContent);
            check('診断カード(移行しない端末): 「位置番号（旧方式）」「自動では更新しません」', mt.indexOf('位置番号（旧方式）') !== -1 && mt.indexOf('自動では更新しません') !== -1, mt);
            void t2;
        }

        }
        // ================= 4. 失敗注入 =================
        if (on(4)) {
        console.log('--- 4. 移行の失敗注入 ---');
        {
            const N = PF_KEYS.length;
            const runInject = async (mode, label) => {
                let bad = [];
                for (let i = 0; i < N; i++) {
                    await seed(27);
                    const pre = await dump();
                    await fault(mode, i, PF_KEYS);
                    const r = await migrate();
                    await unfault();
                    const post = await dump();
                    if (mode === 'crash') {
                        // 強制終了: ロールバックも失敗 → 再起動相当(起動時の復旧)で元に戻る
                        const midOk = r.status === 'failed';
                        await page.evaluate(() => window.recoverRosterTxnOnStartup());
                        const post2 = await dump();
                        if (!(midOk && diffKeys(pre, post2).length === 0 && post2[K.undo_pfm_txn] === undefined && post2[K.undo_pfm_snapshot] === undefined && post2[K.roster_txn] === undefined && post2[K.roster_snapshot] === undefined)) bad.push(i + ':' + r.status + ':' + diffKeys(pre, post2).join(','));
                    } else if (!(r.status === 'failed' && r.rolledBack === true && diffKeys(pre, post).length === 0)) bad.push(i + ':' + JSON.stringify(r).slice(0, 80) + ':' + diffKeys(pre, post).join(','));
                }
                check(label + '(pf の各書き込み位置 ' + N + '通り): 記録は移行前のまま(全キー同一)・スナップショットもジャーナルも残らない', bad.length === 0, bad.slice(0, 3).join(' | '));
            };
            await runInject('quota', '容量超過を注入');
            await runInject('corrupt', '内容の破損(読み戻しの不一致)を注入');
            await runInject('crash', '強制終了を注入(ロールバックも失敗→起動時の自動復旧)');
            // 失敗後の再試行で成功する
            await seed(27); await fault('quota', 1, PF_KEYS); await migrate(); await unfault();
            const rr = await migrate();
            check('失敗したあと(空きができて)もう一度実行すると移行できる', rr.status === 'migrated', JSON.stringify(rr));
            // 実際の再読み込みをまたぐ強制終了: 次の起動で復旧 → 同じ起動で再移行される
            const s = await seed(27); const exp = expectV2(s.pf, s.students);
            await fault('crash', 2, PF_KEYS); await migrate(); await unfault();
            const mid = await dump();
            check('強制終了の直後: ジャーナル(applying/rollback-failed)とスナップショットが残っている(途中の状態)', !!mid[K.undo_pfm_txn] && !!mid[K.undo_pfm_snapshot], '');
            await reload('domcontentloaded'); await sleep(2500);
            const fin = await dump();
            check('再起動: 起動時の復旧で元に戻ったあと、同じ起動で移行がやり直され、pf が期待値になり、ジャーナルは残らない', PF_KEYS.every(k => JSON.stringify(JSON.parse(fin[k])) === JSON.stringify(exp[k])) && fin[K.undo_pfm_txn] === undefined && fin[K.undo_pfm_snapshot] === undefined && fin[K.roster_txn] === undefined && fin[K.roster_snapshot] === undefined, '');
            // 容量不足: 何も書かない
            await seed(27); const preP = await dump();
            await fault('probe'); const rp = await migrate(); await unfault();
            check('容量が足りない(容量確認の失敗): 何も書かずに見送る(全キー不変・旧方式のまま)', rp.status === 'skip' && rp.reason === 'insufficient-storage' && diffKeys(preP, await dump()).length === 0, JSON.stringify(rp));
            await seed(27); const preS = await dump();
            await fault('snapshot'); const rs = await migrate(); await unfault();
            check('スナップショットが書けない: 何も書かずに見送る(全キー不変)', rs.status === 'skip' && rs.reason === 'snapshot-failed' && diffKeys(preS, await dump()).length === 0, JSON.stringify(rs));
            // 移行中に、pf 以外のキーが変わってしまった(比較で検出してロールバック)
            await seed(27); const preX = await dump();
            await fault('sneak', 0, [], { key: K.tests, value: '[]' });
            const rx = await migrate(); await unfault();
            const postX = await dump();
            check('移行中にほかのキー(spa_tests)が変わった: 全キー比較で検出し、pf を移行前へ戻す', rx.status === 'failed' && rx.rolledBack === true && PF_KEYS.every(k => postX[k] === preX[k]) && /unrelated key changed/.test(rx.reason), JSON.stringify(rx).slice(0, 160));
            await seed(27);
            await fault('sneak', 0, [], { key: 'zz_new_key', value: '1' });
            const ry = await migrate(); await unfault();
            check('移行中に新しいキーが作られた: 検出してロールバック', ry.status === 'failed' && /unexpected new key/.test(ry.reason), JSON.stringify(ry).slice(0, 160));
            await page.evaluate(() => localStorage.removeItem('zz_new_key'));
        }

        }
        // ================= 5. v2 の名簿変更: 6操作 =================
        if (on(5)) {
        console.log('--- 5. 新方式での名簿変更(6操作): pf の記録は studentId に付いたまま ---');
        for (const op of OPSV) {
            const s = await v2seed(27, { blank: 4 });
            const ids = s.students.map(x => x.studentId);
            const pre = await dump();
            const ns = op.make(s.students);
            const r = await applyNS(ns);
            const post = await dump();
            const master = JSON.parse(post[K.master]).students;
            const delId = op === OPS[2] ? ids[1] : null;
            const recPre = JSON.parse(pre.pf_records_2026), recPost = JSON.parse(post.pf_records_2026);
            check(op.name + ': ok・pf は追従(followed)', r.ok && (r.noop ? true : true) && r.pf && (r.pf.status === 'followed' || r.pf.status === 'none'), JSON.stringify(r).slice(0, 140));
            check(op.name + ': 記録・集計のすべてのキーが持ち主に付いたまま(_owner=キー)', ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].every(k => { const o = JSON.parse(post[k]); return Object.keys(o).every(id => o[id]._owner === id); }), '');
            const survive = Object.keys(recPre).filter(id => id !== delId);
            check(op.name + ': 生き残る児童の記録は値まで不変・削除された児童の記録だけが消える(件数の保存則)', survive.every(id => JSON.stringify(recPost[id]) === JSON.stringify(recPre[id])) && Object.keys(recPost).length === survive.length, Object.keys(recPost).length + '/' + survive.length);
            if (op !== OPS[2]) check(op.name + ': 記録・集計のキーは1バイトも書き換えない(並べ替え・転入・改名では記録に触らない)', ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].every(k => post[k] === pre[k]), diffKeys(pre, post).join(','));
            const roster = JSON.parse(post.pf_roster);
            const expected = []; master.forEach((st, j) => { if (st.name) expected.push({ id: j + 1, studentId: st.studentId, name: st.name }); });
            check(op.name + ': pf_roster が新名簿(順序・氏名・id=位置+1・studentId)と一致する', roster.length === expected.length && roster.every((e, i) => e.studentId === expected[i].studentId && e.name === expected[i].name && e.id === expected[i].id), JSON.stringify(roster.slice(0, 2)));
            check(op.name + ': 生き残る児童の age・note を引き継ぎ、転入生は age=10 で note なし', roster.every(e => { const oi = ids.indexOf(e.studentId); return oi >= 0 ? (e.note === 'n' + oi && e.age === 10 + (oi % 2)) : (e.age === 10 && e.note === undefined); }), '');
            check(op.name + ': 核となる18ストアもずれ0', STORE_NAMES.every(nm => misplaced(ownersOf(K, post, ids), master)[nm].shifted === 0), '');
            check(op.name + ': 「新体力テストが一致しない」の通知は出ない', !(await toastHas('新体力テストの名簿がSPAの名簿と一致しない', 300)), '');
            if (delId) {
                const arch = JSON.parse(post[K.student_archive]).entries.filter(e => e.studentId === delId)[0];
                check(op.name + ': 削除された児童の記録・集計・pf_roster の項目が退避に入る(持ち主の目印つき)', arch && arch.data.pf_records_2026._owner === delId && arch.data.pf_records_2025._owner === delId && arch.data.pf_fitness_2026._owner === delId && arch.data.pf_roster.studentId === delId && arch.data.pf_roster.note === 'n1', JSON.stringify(arch && Object.keys(arch.data)));
                // 取り消し
                const u = await page.evaluate(() => window.undoRosterChange({ reload: false }));
                check(op.name + ': 取り消すと pf を含む全キーが変更前と1バイトも変わらない', u.ok && diffKeys(pre, await dump(), { infra: true }).length === 0, diffKeys(pre, await dump(), { infra: true }).join(','));
                // 復元
                await applyNS(ns);
                const arch2 = JSON.parse((await dump())[K.student_archive]).entries.filter(e => e.studentId === delId)[0];
                const rr = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), arch2.archiveId);
                const back = await dump();
                const recB = JSON.parse(back.pf_records_2026);
                check(op.name + ': 復元すると記録・集計が同じ studentId で戻り(件数=変更前)、pf_roster にも項目(age・note)が戻る', rr.ok && Object.keys(recB).length === Object.keys(recPre).length && recB[delId]._owner === delId && JSON.parse(back.pf_fitness_2026)[delId]._owner === delId && JSON.parse(back.pf_roster).some(e => e.studentId === delId && e.note === 'n1'), JSON.stringify(rr).slice(0, 120));
                // 復元: すでにその児童の記録が入力されていれば上書きしない
                await applyNS(ns);
                const arch3 = JSON.parse((await dump())[K.student_archive]).entries.filter(e => e.studentId === delId && !e.residual).pop();
                await page.evaluate((id) => { const r = JSON.parse(localStorage.getItem('pf_records_2026')); r[id] = { 握力: 99, _owner: 'typed' }; storageVerifiedWrite('pf_records_2026', JSON.stringify(r)); }, delId);
                const rr2 = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), arch3.archiveId);
                const back2 = JSON.parse((await dump()).pf_records_2026);
                check(op.name + ': 復元の前にその児童の記録が入力されていたら上書きしない(入力済みを優先)', rr2.ok && back2[delId]._owner === 'typed', JSON.stringify(rr2).slice(0, 100));
            }
        }
        // 手入力の児童(pfm_)は名簿変更でも末尾に残り、記録は触られない
        {
            const s = await v2seed(6);
            await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_roster')); r.push({ id: 1, studentId: 'pfm_abcd1234', name: '手入力の児童', gender: '男', age: 10 }); storageVerifiedWrite('pf_roster', JSON.stringify(r)); const rec = JSON.parse(localStorage.getItem('pf_records_2026')); rec.pfm_abcd1234 = { 握力: 5, _owner: 'pfm_abcd1234' }; storageVerifiedWrite('pf_records_2026', JSON.stringify(rec)); });
            const ns = OPS[1].make(s.students).filter((x, i) => i !== 3);
            const r = await applyNS(ns);
            const post = await dump(); const ro = JSON.parse(post.pf_roster);
            check('手入力の児童(pfm_): 名簿の並べ替え・削除のあとも pf_roster の末尾に残り、記録が不変', r.ok && ro[ro.length - 1].studentId === 'pfm_abcd1234' && JSON.parse(post.pf_records_2026).pfm_abcd1234._owner === 'pfm_abcd1234', JSON.stringify(ro.slice(-2)));
        }
        // 新旧が混在(roster は studentId 付きだが数字のキーの記録が残る): 触らない・通知する
        {
            const s = await v2seed(6);
            await page.evaluate(() => { const rec = JSON.parse(localStorage.getItem('pf_records_2026')); rec['3'] = { 握力: 1 }; storageVerifiedWrite('pf_records_2026', JSON.stringify(rec)); });
            const pre = await dump();
            const r = await applyNS(OPS[1].make(s.students));
            const post = await dump();
            check('新旧が混在した pf(数字のキーが残る): pf に触れず(全 pf キー不変)、名簿の変更は通常どおり行い、通知する', r.ok && r.pf.status === 'mismatch' && r.pf.reason === 'mixed-format' && diffKeys(pre, post).filter(isPf).length === 0 && await toastHas('新体力テストの名簿がSPAの名簿と一致しない', 1500), JSON.stringify(r.pf));
        }
        // 旧方式(v1)の端末では、従来どおり位置で追従する(移行前の端末・一致しない端末の動作は変えない)
        {
            const s = await seed(6);   // 再読み込みしない = 旧方式のまま
            const r = await applyNS(OPS[2].make(s.students));
            const post = await dump();
            check('旧方式(v1)の端末: 名簿変更で従来どおり位置(id)で付け替える(段階2cの動作を維持)', r.ok && r.pf.status === 'followed' && Object.keys(JSON.parse(post.pf_records_2026)).length === 5 && JSON.parse(post.pf_records_2026)['2']._owner === s.students[2].studentId, JSON.stringify(r.pf));
        }

        }
        // ================= 6. 取り込み(grdImportFitnessTest) =================
        if (on(6)) {
        console.log('--- 6. 取り込み: studentId で照合 ---');
        {
            const s = await v2seed(4, { dupNames: true, y2025: false });
            const full = { 握力: 30, 上体起こし: 25, 長座体前屈: 45, 反復横とび: 45, シャトルラン: 50, '50m走': 9.5, 立ち幅とび: 170, ソフトボール投: 25 };
            await page.evaluate((full) => { const r = JSON.parse(localStorage.getItem('pf_records_2026')); Object.keys(r).forEach(k => { r[k] = Object.assign({}, r[k], full); }); storageVerifiedWrite('pf_records_2026', JSON.stringify(r)); }, full);
            const before = await page.evaluate(() => JSON.parse(localStorage.getItem('spa_scores') || '[]').length);
            await page.evaluate(() => window.grdImportFitnessTest(true));
            const sc = await page.evaluate((K) => JSON.parse(localStorage.getItem(K.scores) || '[]').filter(x => x.testId === 'fitness_2026'), K);
            const idxs = sc.map(x => x.studentIndex).sort();
            check('同姓同名の児童が2人いても取り込める(新方式は氏名を使わない)。4人全員に点数が付く', sc.length === 4 && idxs.join() === '0,1,2,3', JSON.stringify(idxs) + ' before=' + before);
            check('取り込んだ点数の持ち主: 児童の位置(studentIndex)が studentId の位置と一致する', sc.every(x => x.studentIndex >= 0 && x.studentIndex < 4), '');
            // 旧方式では、従来どおり同姓同名は取り込み中止
            const t = await seed(4, { dupNames: true, y2025: false });
            await page.evaluate((full) => { const r = JSON.parse(localStorage.getItem('pf_records_2026')); Object.keys(r).forEach(k => { r[k] = Object.assign({}, r[k], full); }); storageVerifiedWrite('pf_records_2026', JSON.stringify(r)); }, full);
            await page.evaluate(() => window.grdImportFitnessTest(true));
            const sc2 = await page.evaluate((K) => JSON.parse(localStorage.getItem(K.scores) || '[]').filter(x => x.testId === 'fitness_2026'), K);
            check('旧方式(studentId なしの名簿)では従来どおり、同姓同名のときは取り込みを中止する', sc2.length === 0 && await toastHas('同姓同名', 1500), JSON.stringify(sc2).slice(0, 80));
            void t;
            // 新方式: 並べ替えのあとも、正しい児童に取り込まれる(氏名でなく studentId)
            const u = await v2seed(4, { y2025: false });
            await page.evaluate((full) => { const r = JSON.parse(localStorage.getItem('pf_records_2026')); Object.keys(r).forEach((k, i) => { r[k] = Object.assign({}, r[k], full, { 握力: 20 + i * 5 }); }); storageVerifiedWrite('pf_records_2026', JSON.stringify(r)); }, full);
            const rec = JSON.parse((await dump()).pf_records_2026);
            await applyNS(OPS[1].make(u.students)); // 先頭2名を入れ替え(名簿だけ。記録のキーは不変)
            await page.evaluate(() => { loadMaster(); window.grdImportFitnessTest(true); });
            const sc3 = await page.evaluate((K) => JSON.parse(localStorage.getItem(K.scores) || '[]').filter(x => x.testId === 'fitness_2026'), K);
            const m3 = JSON.parse((await dump())[K.master]).students;
            check('新方式: 並べ替えのあとに取り込んでも、点数が正しい児童に付く(studentIndex の児童の studentId の記録から計算されている)', sc3.length === 4 && sc3.every(x => !!m3[x.studentIndex]) && new Set(sc3.map(x => x.studentIndex)).size === 4, JSON.stringify(sc3.map(x => x.studentIndex)));
            void rec;
        }

        }
        // ================= 7. 内蔵版 pf 画面(実際の操作) =================
        if (on(7)) {
        console.log('--- 7. pf 画面: 入力・保存・並べ替え後の表示・名簿の読み込み ---');
        {
            const s = await v2seed(6, { y2025: false });
            await page.evaluate(() => { showView('pf'); });
            await page.waitForSelector('#pf-inputGridWrap input', { timeout: 5000 });
            await sleep(200);
            // 1人目の握力(左)へ実際に入力して保存
            const first = '#pf-inputGridWrap input[data-pf-idx="0"]';
            await page.click(first); await page.evaluate((sel) => document.querySelector(sel).select(), first); await page.keyboard.type('31');
            await page.click('button[onclick="pf_saveAll()"]'); await sleep(200);
            const st = JSON.parse((await dump()).pf_records_2026);
            check('画面で入力して保存: 記録は児童ID(studentId)のキーに入り、数字のキーは作られない', st[s.students[0].studentId] && st[s.students[0].studentId]['握力_左'] === 31 && Object.keys(st).every(k => /^stu_/.test(k)), JSON.stringify(st[s.students[0].studentId]));
            // 名簿(SPA)を並べ替え(UI経由)→ 再読み込み → pf 画面で、入力した記録が同じ児童の行に表示される
            await page.evaluate(() => { showView('settings'); }); await sleep(300);
            await ui.openSettings(page);
            await ui.act(page, 'down', 0); await ui.clickSave(page); await ui.waitReload(page);
            await page.evaluate(() => { showView('pf'); }); await page.waitForSelector('#pf-inputGridWrap input', { timeout: 5000 }); await sleep(300);
            const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#pf-inputGridWrap tbody tr')).map(tr => ({ name: tr.querySelector('td:nth-child(2)').textContent, v: tr.querySelector('input[data-pf-idx]').value })));
            const r0 = rows.filter(r => r.name.indexOf(s.students[0].name) === 0)[0];
            check('名簿を並べ替え(UI)たあと、pf 画面の入力値は同じ児童の行に表示される(先頭の児童を2番目へ移した)', r0 && r0.v === '31' && rows[0].name.indexOf(s.students[1].name) === 0, JSON.stringify(rows.slice(0, 2)));
            check('名簿を並べ替えても pf の記録キーは変わらない(studentId のまま)', JSON.stringify(Object.keys(JSON.parse((await dump()).pf_records_2026)).sort()) === JSON.stringify(Object.keys(st).sort()), '');
            // 個人分析: 選択肢の値は studentId・選ぶと氏名が出る
            await page.evaluate(() => { pf_switchView('analysis'); }); await sleep(300);
            const optv = await page.$eval('#pf-analysisStudent', el => Array.from(el.options).map(o => o.value).filter(Boolean));
            await page.select('#pf-analysisStudent', s.students[0].studentId); await sleep(300);
            const anaTxt = await page.$eval('#pf-analysisContent', el => el.textContent);
            check('個人分析: 選択肢の値が studentId・選ぶとその児童の分析が表示される', optv.every(v => /^stu_/.test(v)) && anaTxt.indexOf(s.students[0].name) !== -1, optv.slice(0, 2).join());
            // 名簿を読み込む(pf の設定): age の引き継ぎ・手入力の児童の保持・studentId 維持
            await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_roster')); r.push({ id: 1, studentId: 'pfm_zzzz9999', name: '手入力', gender: '女', age: 11 }); r[1].age = 12; storageVerifiedWrite('pf_roster', JSON.stringify(r)); pf_switchView('settings'); pf_loadAll(); });
            await page.click('button[onclick="pf_loadFromSpa()"]'); await sleep(300);
            const ro = JSON.parse((await dump()).pf_roster);
            check('「名簿を読み込む」: studentId が付く・pf 側で直した年齢を引き継ぐ・手入力の児童(pfm_)は残る', ro.filter(e => /^stu_/.test(e.studentId)).length === 6 && ro.some(e => e.age === 12) && ro[ro.length - 1].studentId === 'pfm_zzzz9999', JSON.stringify(ro.map(e => e.age)));
            check('「名簿を読み込む」のあとも記録のキーは不変(位置ではなく studentId なので別の児童に付かない)', JSON.stringify(Object.keys(JSON.parse((await dump()).pf_records_2026)).sort()) === JSON.stringify(Object.keys(st).sort()), '');
        }
        {
            // 旧方式の記録が残る端末(名簿が一致しない=移行しない)では、名簿を読み込んでも studentId を付けない(従来どおり)
            const stu = mkStudents(6);
            const r = JSON.parse(pfV1(stu).pf_roster); [r[0], r[1]] = [r[1], r[0]];
            await seed(6, { pfOverride: { pf_roster: JSON.stringify(r) } });
            await reload();
            const preRec = (await dump()).pf_records_2026;
            await page.evaluate(() => { showView('pf'); pf_switchView('settings'); }); await sleep(300);
            await page.click('button[onclick="pf_loadFromSpa()"]'); await sleep(300);
            const d = await dump();
            check('旧方式の記録が残る端末: 「名簿を読み込む」は従来どおり(studentId を付けない)・記録は不変', JSON.parse(d.pf_roster).every(e => e.studentId === undefined) && d.pf_records_2026 === preRec, '');
        }

        }
        // ================= 8. 旧方式のバックアップの復元 → 再移行 =================
        if (on(8)) {
        console.log('--- 8. 旧方式のバックアップを新方式の端末へ復元 ---');
        {
            const s = await seed(27);
            const bk = await page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
            await reload(); await sleep(800);
            const mid = await dump();
            check('前提: 端末は新方式へ移行済み', !!mid.migration_pfStudentId_v1 && JSON.parse(mid.pf_roster).every(e => !!e.studentId), '');
            const r = await page.evaluate((b) => window.brRestoreFromBackup(b), bk);
            const after = await dump();
            check('旧方式のバックアップを復元すると pf は旧方式に戻る(バックアップの値)', r.ok && after.pf_roster === bk.rawLocalStorage.pf_roster && after.pf_records_2026 === bk.rawLocalStorage.pf_records_2026, JSON.stringify(r).slice(0, 100));
            await reload(); await sleep(1500);
            const fin = await dump(); const exp = expectV2(s.pf, s.students);
            check('復元後の次の起動で自動的に新方式へ再移行され、期待値と一致する', PF_KEYS.every(k => JSON.stringify(JSON.parse(fin[k])) === JSON.stringify(exp[k])), '');
        }
        }
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし(注入した意図的なエラーを除く)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== pf-migration: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
