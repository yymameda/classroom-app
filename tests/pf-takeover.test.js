// H4 案B 段階4c: (1) 旧方式の記録の「氏名で引き継ぐ」(名簿が一致せず自動では新方式にならない端末) (2) 退避した pf-residual の単体復元。
//   引き継ぎ: pf 名簿の各児童を、SPA名簿の氏名が両方で一意に一致する児童へ紐付け、その児童の studentId のキーへ記録・集計を移す。
//             紐付けられなかった分は消さず、退避(reason:'pf-unlinked'。完全削除のみ)に残す。確認(プレビュー)→ボタンで確定。取り消せる。
//   復元:     名簿に同じ studentId の児童がいて pf が新方式のときだけ、その児童の記録として戻す。入力済みの項目は上書きしない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pf-takeover.test.js

const puppeteer = require('puppeteer-core');
const { buildRaws, mkStudents } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;
const isPf = (k) => /^pf_(roster|records_|fitness_)/.test(k);

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    // 起動時の自動移行は使わない(旧方式のまま検証する)。新方式の端末は、移行と同じ形のデータを直接作る
    await page.evaluateOnNewDocument(() => { window.__spaSkipPfMigration = true; });
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1 && !/crash|quota|verify failed/.test(t)) consoleErrors.push(t); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const INFRA = [K.roster_snapshot, K.roster_txn];

    // ---------- 端末の状態を作る ----------
    // pfList: pf 名簿 [{id, name, age, note}](順序どおり)。記録は pf の id をキーにし、値に持ち主の目印 _owner(氏名で決まる児童の studentId、いなければ 'X:氏名')
    const ownerOf = (students, name) => { const c = students.filter(s => s.name === name); return c.length === 1 ? c[0].studentId : 'X:' + name; };
    const pfFrom = (students, pfList, extra) => {
        const roster = pfList.map(e => ({ id: e.id, name: e.name, gender: e.gender || '男', age: e.age || 10, note: e.note }));
        const rec26 = {}, rec25 = {}, fit26 = {};
        pfList.forEach(e => { rec26[String(e.id)] = { 握力: 20 + e.id, 上体起こし: 10 + e.id, _owner: ownerOf(students, e.name) }; rec25[String(e.id)] = { 握力: 10 + e.id, _owner: ownerOf(students, e.name) }; fit26[String(e.id)] = { total: 30 + e.id, eval: 'B', _owner: ownerOf(students, e.name) }; });
        const o = { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec26), pf_records_2025: JSON.stringify(rec25), pf_fitness_2026: JSON.stringify(fit26), pf_setting: JSON.stringify({ year: 2026, grade: 5 }) };
        return Object.assign(o, extra || {});
    };
    async function seed(students, pf, archiveEntries) {
        const raws = buildRaws(K, students);
        const extras = { [K.tests]: '[]', 'doc-index-v1': 'other-app' };
        if (archiveEntries) extras[K.student_archive] = JSON.stringify({ version: 1, entries: archiveEntries });
        await page.evaluate((K, raws, extras, pf, students) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear(); window.__pendingIdbDeletes = [];
            Object.keys(raws).concat(Object.keys(extras)).forEach(k => storageVerifiedWrite(k, raws[k] !== undefined ? raws[k] : extras[k]));
            Object.keys(pf).forEach(k => storageVerifiedWrite(k, pf[k]));
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, extras, pf, students);
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (a, b, infra) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(k => !NOISE.test(k) && (!infra || INFRA.indexOf(k) === -1) && a[k] !== b[k]);
    const plan = (pf, students, hasRoster) => page.evaluate((pf, students) => { const keyed = {}; Object.keys(pf).forEach(k => { if (/^pf_(records|fitness)_\d+$/.test(k)) keyed[k] = pf[k]; }); return window.planPfTakeover({ roster: pf.pf_roster === undefined ? null : pf.pf_roster, keyed }, students); }, pf, students);
    const apply = () => page.evaluate(() => window.applyPfTakeover({ reload: false }));
    const toastHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 1500, polling: 50 }, t).then(() => true).catch(() => false);
    const reload = async (w) => { await page.reload({ waitUntil: w || 'networkidle0' }); await sleep(900); };
    const fault = (mode, at, keys) => page.evaluate((mode, at, keys) => {
        const set = new Set(keys), state = { n: 0 };
        const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
        window.__fault = { state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
        Storage.prototype.setItem = function(k, v) {
            if (set.has(k)) {
                if (mode === 'crash' && state.n >= at) throw new Error('crash');
                const i = state.n++;
                if (mode === 'quota' && i === at) throw new DOMException('quota', 'QuotaExceededError');
                if (mode === 'corrupt' && i === at) return oSet.call(this, k, String(v).slice(0, Math.max(0, String(v).length - 3)));
            }
            return oSet.apply(this, arguments);
        };
        Storage.prototype.removeItem = function(k) { if (set.has(k) && mode === 'crash' && state.n >= at) throw new Error('crash'); return oRem.apply(this, arguments); };
    }, mode, at, keys);
    const unfault = () => page.evaluate(() => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } });

    const S = mkStudents(6);   // 児童0〜児童5(氏名は一意)
    const names = S.map(s => s.name);
    // pf の名簿: 順序が違う(=SPA名簿と一致せず、自動では移行されない)。全員の氏名が一意に一致する
    const shuffled = [5, 3, 0, 1, 4, 2].map((si, i) => ({ id: i + 1, name: names[si], age: 10 + (i % 2), note: 'n' + names[si] }));
    const expectTake = (pf, students, pfList) => {
        // アプリのコードを使わず、テスト側で独立に期待値を計算する(氏名が両方で一意に一致 → その児童の studentId)
        const cnt = (arr, n) => arr.filter(x => x === n).length;
        const link = {}; pfList.forEach(e => { if (cnt(students.map(s => s.name), e.name) === 1 && cnt(pfList.map(x => x.name), e.name) === 1) link[e.id] = students.find(s => s.name === e.name).studentId; });
        const out = {};
        ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].forEach(k => { const d = JSON.parse(pf[k]); const o = {}; Object.keys(d).forEach(id => { if (link[id]) o[link[id]] = d[id]; }); out[k] = o; });
        return { link, out };
    };

    try {
        // ================= 1. 引き継ぎの計画(純関数) =================
        console.log('--- 1. 計画(書き込みなし) ---');
        {
            const pf = pfFrom(S, shuffled);
            const p = await plan(pf, S);
            const ex = expectTake(pf, S, shuffled);
            check('全員が氏名で一意に一致: status=takeover・6名を引き継ぐ・引き継げない0', p.status === 'takeover' && p.linked.length === 6 && p.unlinked.length === 0 && p.violations.length === 0, JSON.stringify({ st: p.status, l: p.linked.length, u: p.unlinked.length, v: p.violations }));
            check('引き継ぎ後の記録・集計が、テスト側の期待値と完全に一致(キーは studentId・値は不変)', Object.keys(ex.out).every(k => JSON.stringify(JSON.parse(p.newRaw[k])) === JSON.stringify(ex.out[k])), '');
            const ro = JSON.parse(p.newRaw.pf_roster);
            check('pf_roster はSPA名簿の順序・氏名・id=位置+1・studentId に作り直され、age・note は氏名で引き継がれる', ro.length === 6 && ro.every((e, i) => e.studentId === S[i].studentId && e.name === S[i].name && e.id === i + 1 && e.note === 'n' + S[i].name && e.age === shuffled.find(x => x.name === S[i].name).age), JSON.stringify(ro.slice(0, 2)));
            await seed(S, pf);
            const preP = await dump();
            const spyW = await page.evaluate((pf, S) => { let n = 0; const o = Storage.prototype.setItem, r = Storage.prototype.removeItem; Storage.prototype.setItem = function() { n++; return o.apply(this, arguments); }; Storage.prototype.removeItem = function() { n++; return r.apply(this, arguments); }; try { const keyed = {}; Object.keys(pf).forEach(k => { if (/^pf_(records|fitness)_\d+$/.test(k)) keyed[k] = pf[k]; }); window.planPfTakeover({ roster: pf.pf_roster, keyed }, S); window.pfTakeoverState(); } finally { Storage.prototype.setItem = o; Storage.prototype.removeItem = r; } return n; }, pf, S);
            check('書き込みなし: 計画・状態の取得の間、localStorage への書き込み・削除が0回で、全キー不変', spyW === 0 && diffKeys(preP, await dump()).length === 0, String(spyW));

            // 引き継げない(SPAにいない氏名・SPA名簿に載っていない新しい児童・記録だけが残った番号)
            const pfList = shuffled.slice(0, 5).concat([{ id: 6, name: '転出した子', age: 10 }]);   // 児童2 が pf に居ない・SPAに居ない氏名が1名
            const pf2 = pfFrom(S, pfList); const r2 = JSON.parse(pf2.pf_records_2026); r2['99'] = { 握力: 1, _owner: 'X:orphan' }; pf2.pf_records_2026 = JSON.stringify(r2);
            const p2 = await plan(pf2, S);
            check('SPAに居ない氏名は引き継げない(退避へ)・記録だけの番号(名簿に無い)も退避へ', p2.status === 'takeover' && p2.linked.length === 5 && p2.unlinked.some(u => u.name === '転出した子') && p2.unlinked.some(u => u.name === null && String(u.pfId) === '99') && p2.violations.length === 0, JSON.stringify(p2.unlinked));
            const arch = p2.archiveEntries.filter(e => e.name === '転出した子')[0];
            check('引き継げない児童の退避: pf_roster の項目と記録・集計が、値の目印つきでそのまま入る', arch && arch.data.pf_roster.id === 6 && arch.data.pf_records_2026._owner === 'X:転出した子' && arch.data.pf_records_2025._owner === 'X:転出した子' && arch.data.pf_fitness_2026._owner === 'X:転出した子', JSON.stringify(arch && Object.keys(arch.data)));
            check('SPAにいて pf 名簿に居ない児童(児童2)は、pf_roster に age=10 で加わる(記録なし)', (() => { const r = JSON.parse(p2.newRaw.pf_roster); const e = r.filter(x => x.studentId === S[2].studentId)[0]; return e && e.age === 10 && e.note === undefined && !JSON.parse(p2.newRaw.pf_records_2026)[S[2].studentId]; })(), '');
            check('件数の保存則(T1): 引き継ぎ後+退避=引き継ぎ前(3種類のキーすべて)', ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].every(k => Object.keys(JSON.parse(p2.newRaw[k])).length + p2.archiveEntries.filter(e => e.data[k] !== undefined).length === Object.keys(JSON.parse(pf2[k])).length), '');

            // 同姓同名: SPA側に2人・pf側に2人のとき、紐付けない
            const T = mkStudents(4); T[1] = Object.assign({}, T[1], { name: T[0].name });                // SPAに同名2人
            const pfDupSpa = pfFrom(T, [{ id: 1, name: T[0].name }, { id: 2, name: T[2].name }, { id: 3, name: T[3].name }]);
            const pd1 = await plan(pfDupSpa, T);
            check('SPA名簿に同姓同名が2人いる氏名は紐付けない(退避へ)。ほかの児童は引き継ぐ', pd1.status === 'takeover' && pd1.linked.length === 2 && pd1.unlinked.length === 1 && pd1.unlinked[0].name === T[0].name, JSON.stringify(pd1.unlinked));
            const U = mkStudents(3);
            const pfDupPf = pfFrom(U, [{ id: 1, name: U[0].name }, { id: 2, name: U[0].name }, { id: 3, name: U[1].name }]);
            const pd2 = await plan(pfDupPf, U);
            check('pf 名簿に同じ氏名が2つある場合も紐付けない(どちらの記録か分からないため)', pd2.status === 'takeover' && pd2.linked.length === 1 && pd2.unlinked.length === 2, JSON.stringify(pd2.unlinked));
            // 氏名の前後の空白は無視する
            const pfSp = pfFrom(S, shuffled.map(e => Object.assign({}, e, { name: ' ' + e.name + '　'.trim() + ' ' })));
            const ps = await plan(pfSp, S);
            check('氏名の前後の空白は無視して照合する', ps.status === 'takeover' && ps.linked.length === 6, JSON.stringify({ l: ps.linked.length }));

            const skipCase = async (label, build, reason, students) => { const pfx = build(); const r = await plan(pfx, students || S); check('引き継げない(' + label + '): status=skip・reason=' + reason + '・何も書く計画がない', r.status === 'skip' && r.reason === reason && Object.keys(r.newRaw).length === 0 && r.archiveEntries.length === 0, JSON.stringify(r).slice(0, 140)); };
            await skipCase('SPAの氏名が1人も一致しない', () => pfFrom(S, [{ id: 1, name: '他人A' }, { id: 2, name: '他人B' }]), 'nothing-linked');
            await skipCase('pf 名簿が壊れている', () => Object.assign(pfFrom(S, shuffled), { pf_roster: '{broken' }), 'roster-invalid');
            await skipCase('pf 名簿の番号が重なっている', () => { const l = shuffled.map(e => Object.assign({}, e)); l[1].id = l[0].id; return pfFrom(S, l); }, 'roster-ids-duplicate');
            await skipCase('記録が壊れている', () => Object.assign(pfFrom(S, shuffled), { pf_records_2026: '[1]' }), 'records-invalid');
            await skipCase('SPAの児童に studentId が無い', () => pfFrom(S, shuffled), 'no-student-id', S.map((x, i) => i === 0 ? Object.assign({}, x, { studentId: undefined }) : x));
            await skipCase('すでに新方式', () => { const o = pfFrom(S, shuffled); const r = JSON.parse(o.pf_roster).map(e => Object.assign(e, { studentId: S[0].studentId })); return Object.assign(o, { pf_roster: JSON.stringify(r), pf_records_2026: JSON.stringify({ [S[0].studentId]: {} }), pf_records_2025: '{}', pf_fitness_2026: '{}' }); }, 'already-v2');
            await skipCase('新体力テストのデータなし', () => ({}), 'no-pf-data');
            await skipCase('氏名で紐付けた児童の記録がすでに児童IDのキーでも入っている(衝突)', () => { const o = pfFrom(S, shuffled); const r = JSON.parse(o.pf_records_2026); r[S[5].studentId] = { x: 1 }; o.pf_records_2026 = JSON.stringify(r); return o; }, 'collision');
            // 新旧混在(名簿の一部が studentId を持つ): studentId で紐付く
            const pfMix = pfFrom(S, shuffled); const rm = JSON.parse(pfMix.pf_roster); rm[0].studentId = S[5].studentId; pfMix.pf_roster = JSON.stringify(rm);
            const pm = await plan(pfMix, S);
            check('新旧混在(名簿の一部に studentId がある): その studentId で紐付き、残りは氏名で紐付く', pm.status === 'takeover' && pm.linked.filter(l => l.how === 'id').length === 1 && pm.linked.length === 6, JSON.stringify(pm.linked.map(l => l.how)));
            // 手入力の児童(pfm_)は残す
            const pfM = pfFrom(S, shuffled); const rM = JSON.parse(pfM.pf_roster); rM.push({ id: 7, name: '手入力の子', gender: '女', age: 10, studentId: 'pfm_aaaa1111' }); pfM.pf_roster = JSON.stringify(rM);
            const pfMr = JSON.parse(pfM.pf_records_2026); pfMr['7'] = { 握力: 5, _owner: 'pfm_aaaa1111' }; pfM.pf_records_2026 = JSON.stringify(pfMr);
            const pmm = await plan(pfM, S);
            check('手入力の児童(pfm_)は、引き継ぎ後も pf_roster の末尾に残り、記録は pfm_ のキーになる(退避しない)', pmm.status === 'takeover' && JSON.parse(pmm.newRaw.pf_roster).slice(-1)[0].studentId === 'pfm_aaaa1111' && JSON.parse(pmm.newRaw.pf_records_2026).pfm_aaaa1111._owner === 'pfm_aaaa1111' && pmm.unlinked.length === 0, JSON.stringify(pmm.unlinked));
        }

        // ================= 2. 実行(トランザクション・全キー比較・取り消し) =================
        console.log('--- 2. 引き継ぎの実行 ---');
        const pfList2 = shuffled.slice(0, 5).concat([{ id: 6, name: '転出した子', age: 10 }]);
        const pf2 = pfFrom(S, pfList2); { const r = JSON.parse(pf2.pf_records_2026); r['99'] = { 握力: 1, _owner: 'X:orphan' }; pf2.pf_records_2026 = JSON.stringify(r); }
        await seed(S, pf2);
        const pre = await dump();
        const res = await apply();
        const post = await dump();
        const ex2 = expectTake(pf2, S, pfList2);
        check('実行: ok・引き継いだ5名・引き継げなかった2件(転出した子・番号99)', res.ok && res.linked === 5 && res.unlinked === 2, JSON.stringify(res));
        const changed = diffKeys(pre, post, true);
        check('全キー比較: 変わったのは pf の4キーと退避(spa_student_archive)だけ。名簿(spa_master)・18ストア・別アプリのキーは1バイトも変わらない', JSON.stringify(changed.sort()) === JSON.stringify(['pf_fitness_2026', 'pf_records_2025', 'pf_records_2026', 'pf_roster', K.student_archive].sort()) && post[K.master] === pre[K.master], changed.join(','));
        check('引き継ぎ後: 記録・集計はテスト側の期待値のとおり(持ち主のキーに、値のまま)', ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].every(k => { const o = JSON.parse(post[k]); return Object.keys(o).length === 5 && Object.keys(o).every(id => o[id]._owner === id) && JSON.stringify(o) === JSON.stringify(ex2.out[k]); }), '');
        const ar = JSON.parse(post[K.student_archive]).entries;
        check('退避: pf-unlinked が2件(氏名つき1・氏名なし1)。studentId を持たず、記録の値も目印つきでそのまま', ar.length === 2 && ar.every(e => e.reason === 'pf-unlinked' && !e.studentId) && ar.some(e => e.name === '転出した子' && e.data.pf_fitness_2026._owner === 'X:転出した子') && ar.some(e => e.name === null && e.data.pf_records_2026._owner === 'X:orphan'), JSON.stringify(ar.map(e => [e.name, Object.keys(e.data)])));
        check('退避中の児童の数には数えない(studentArchiveSummary は 0 名)', (await page.evaluate(() => studentArchiveSummary().length)) === 0, '');
        check('診断: 引き継ぎ後の pf は新方式(児童ごと)で、名簿は一致している', await page.evaluate(() => { const d = pfDiagnose(); return d.mode === 'v2' && d.state === 'match'; }), '');
        const jr = JSON.parse(post[K.roster_txn]);
        check('確定済みのジャーナルは kind=pf-takeover', jr.state === 'committed' && jr.kind === 'pf-takeover', JSON.stringify(jr).slice(0, 100));
        // 取り消し
        const un = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        const back = await dump();
        check('取り消し: ok・pf を含む全キーが引き継ぎ前と1バイトも変わらない・退避も元に戻る', un.ok && diffKeys(pre, back, true).length === 0, diffKeys(pre, back, true).join(','));
        // 取り消しの拒否
        await apply();
        await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_records_2026')); const k = Object.keys(r)[0]; r[k].握力 = 77; storageVerifiedWrite('pf_records_2026', JSON.stringify(r)); });
        const un2 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('引き継ぎのあとに入力があると取り消さない(専用の文言)', un2.ok === false && un2.error === 'changed-since' && await toastHas('新体力テストの記録を引き継いだあとに入力があった'), JSON.stringify(un2).slice(0, 100));
        // 引き継げない状態の実行: 何も書かない
        await seed(S, Object.assign(pfFrom(S, shuffled), { pf_roster: '{broken' }));
        const preB = await dump(); const rb = await apply();
        check('引き継げない状態(名簿が壊れている)で実行しても、何も書かず理由を返す(全キー不変)', rb.ok === false && rb.error === 'takeover-unavailable' && rb.reason === 'roster-invalid' && diffKeys(preB, await dump()).length === 0, JSON.stringify(rb));

        // ================= 3. 失敗注入 =================
        console.log('--- 3. 失敗注入(引き継ぎの各書き込み位置) ---');
        {
            const KEYS_T = [K.student_archive, 'pf_fitness_2026', 'pf_records_2025', 'pf_records_2026', 'pf_roster', K.master];
            const N = KEYS_T.length;
            for (const [mode, label] of [['quota', '容量超過'], ['corrupt', '内容の破損(読み戻しの不一致)'], ['crash', '強制終了(ロールバックも失敗→起動時の自動復旧)']]) {
                const bad = [];
                for (let i = 0; i < N; i++) {
                    await seed(S, pf2);
                    const p0 = await dump();
                    await fault(mode, i, KEYS_T);
                    const r = await apply();
                    await unfault();
                    if (mode === 'crash') await page.evaluate(() => window.recoverRosterTxnOnStartup());
                    const p1 = await dump();
                    const okShape = mode === 'crash' ? r.ok === false : (r.ok === false && r.rolledBack === true);
                    if (!(okShape && diffKeys(p0, p1).length === 0 && p1[K.roster_txn] === undefined && p1[K.roster_snapshot] === undefined)) bad.push(i + ':' + JSON.stringify(r).slice(0, 70) + ':' + diffKeys(p0, p1).join(','));
                }
                check(label + ' を各書き込み位置(' + N + '通り)で注入: 元に戻り、全キー(pf・退避・名簿)が引き継ぎ前と1バイトも変わらない(ジャーナル・スナップショットも残らない)', bad.length === 0, bad.slice(0, 3).join(' | '));
            }
        }

        // ================= 4. 画面(pf の設定タブ)での操作 =================
        console.log('--- 4. 画面の操作(確認 → 確定) ---');
        {
            await seed(S, pf2);
            await reload();
            await page.evaluate(() => { showView('pf'); pf_switchView('settings'); });
            await sleep(300);
            const vis = await page.evaluate(() => { const c = document.getElementById('pf-takeoverCard'); return c && c.style.display !== 'none' && c.getBoundingClientRect().height > 0; });
            check('旧方式で自動移行されない端末: pf の設定タブに「旧方式の記録の引き継ぎ」が表示される', vis, '');
            check('最初は「引き継ぎの内容を確認する」だけ(まだ何も書かない・確定ボタンは無い)', await page.evaluate(() => !!document.querySelector('#pf-takeoverCard button[data-pf-tk="preview"]') && !document.querySelector('#pf-takeoverCard button[data-pf-tk="apply"]')), '');
            const pre = await dump();
            await page.click('#pf-takeoverCard button[data-pf-tk="preview"]'); await sleep(200);
            const pv = await page.evaluate(() => document.getElementById('pf-takeoverBody').textContent);
            check('確認: 引き継ぐ5名の氏名と、引き継げない2件(氏名つき・番号のみ)が表示される', pv.indexOf('引き継ぐ：5名') !== -1 && S.filter(s => s.name !== '児童2').every(s => pv.indexOf(s.name) !== -1) && pv.indexOf('引き継げない：2件') !== -1 && pv.indexOf('転出した子') !== -1 && pv.indexOf('番号99の記録') !== -1, pv.slice(0, 200));
            check('確認だけでは何も書かない(全キー不変)', diffKeys(pre, await dump()).length === 0, '');
            const tb = await page.evaluate(() => Array.from(document.querySelectorAll('#pf-takeoverCard button[data-pf-tk]')).map(b => [b.getAttribute('data-pf-tk'), Math.round(b.getBoundingClientRect().height)]));
            check('確定・やめるボタンのタップ領域は44px以上', tb.length === 2 && tb.every(x => x[1] >= 44), JSON.stringify(tb));
            await page.click('#pf-takeoverCard button[data-pf-tk="cancel"]'); await sleep(150);
            check('「やめる」: 確認前の表示へ戻り、何も書かない', await page.evaluate(() => !!document.querySelector('#pf-takeoverCard button[data-pf-tk="preview"]')) && diffKeys(pre, await dump()).length === 0, '');
            await page.click('#pf-takeoverCard button[data-pf-tk="preview"]'); await sleep(150);
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#pf-takeoverCard button[data-pf-tk="apply"]')]);
            check('確定: 再読み込み後に「新体力テストの記録を引き継ぎました」のトースト(元に戻す つき)', await toastHas('新体力テストの記録を引き継ぎました', 4000) && await page.evaluate(() => document.getElementById('toastUndoBtn').style.display !== 'none'), '');
            await sleep(1500);
            const after = await dump();
            check('確定後: pf は新方式(キーが児童ID)になり、退避に pf-unlinked が2件入る', Object.keys(JSON.parse(after.pf_records_2026)).every(k => /^stu_/.test(k)) && JSON.parse(after[K.student_archive]).entries.length === 2, '');
            await page.evaluate(() => { showView('pf'); pf_switchView('settings'); }); await sleep(300);
            check('引き継ぎ後は、引き継ぎのカードが表示されない', await page.evaluate(() => document.getElementById('pf-takeoverCard').style.display === 'none'), '');
            // 設定の退避カード
            await page.evaluate(() => { showView('settings'); }); await sleep(400);
            const rows = await page.evaluate(() => ({ head: document.getElementById('archiveHeading').textContent, rows: Array.from(document.querySelectorAll('#archiveList .ar-row')).map(r => ({ text: r.textContent, restore: !!r.querySelector('button[data-act^="restore"]'), purge: !!r.querySelector('button[data-act="purge"]') })), undo: document.getElementById('rosterUndoBtn') && document.getElementById('rosterUndoBtn').textContent }));
            check('退避カード: 「退避中の児童 0名（その他の退避データ 2件）」・pf-unlinked の2行は「戻す」が無く完全削除のみ', rows.head.indexOf('退避中の児童 0名（その他の退避データ 2件）') !== -1 && rows.rows.length === 2 && rows.rows.every(r => !r.restore && r.purge && /引き継げなかった分/.test(r.text)), JSON.stringify(rows).slice(0, 200));
            check('名簿カードの取り消しボタンは「新体力テストの引き継ぎを取り消す」', !!rows.undo && rows.undo.indexOf('新体力テストの引き継ぎを取り消す') !== -1, String(rows.undo));
            // 2回タップの完全削除
            await page.click('#archiveList button[data-act="purge"]'); await page.click('#archiveList button[data-act="purge"]'); await sleep(250);
            check('pf-unlinked も、2回タップで完全に削除できる(1件になる)', JSON.parse((await dump())[K.student_archive]).entries.length === 1, '');
        }
        {
            // 引き継ぎ→取り消し(実際のタップ)
            await seed(S, pf2); await reload();
            await page.evaluate(() => { showView('pf'); pf_switchView('settings'); }); await sleep(300);
            const preU = await dump();
            await page.click('#pf-takeoverCard button[data-pf-tk="preview"]'); await sleep(150);
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#pf-takeoverCard button[data-pf-tk="apply"]')]);
            await sleep(1500); await page.evaluate(() => { showView('settings'); }); await sleep(400);
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#rosterUndoBtn')]);
            check('取り消し(実際のタップ): 再読み込み後に「新体力テストの引き継ぎを取り消しました」と表示される', await toastHas('新体力テストの引き継ぎを取り消しました', 4000), '');
            await sleep(1500);
            check('取り消し後: pf を含む全キーが引き継ぎ前と1バイトも変わらない', diffKeys(preU, await dump(), true).length === 0, diffKeys(preU, await dump(), true).join(','));
            // 表示しない条件: 自動で移行できる端末(名簿が一致)・新方式・データなし
            const cards = [];
            for (const [label, pfx] of [['名簿が一致する旧方式(自動で移行される)', pfFrom(S, S.map((s, i) => ({ id: i + 1, name: s.name })))], ['新体力テストのデータなし', {}], ['新方式', (() => { const o = pfFrom(S, S.map((s, i) => ({ id: i + 1, name: s.name }))); const r = JSON.parse(o.pf_roster).map(e => Object.assign(e, { studentId: S[e.id - 1].studentId })); const conv = (k) => { const d = JSON.parse(o[k]); const n = {}; Object.keys(d).forEach(i => { n[S[i - 1].studentId] = d[i]; }); return JSON.stringify(n); }; return Object.assign(o, { pf_roster: JSON.stringify(r), pf_records_2026: conv('pf_records_2026'), pf_records_2025: conv('pf_records_2025'), pf_fitness_2026: conv('pf_fitness_2026') }); })()]]) {
                await seed(S, pfx); await reload();
                await page.evaluate(() => { showView('pf'); pf_switchView('settings'); }); await sleep(300);
                cards.push([label, await page.evaluate(() => document.getElementById('pf-takeoverCard').style.display)]);
            }
            check('引き継ぎのカードは、自動で移行できる端末・新方式・データなしの端末には表示されない', cards.every(c => c[1] === 'none'), JSON.stringify(cards));
        }

        // ================= 5. pf-residual の単体復元 =================
        console.log('--- 5. pf-residual の単体復元 ---');
        {
            // 新方式の端末(移行と同じ形): 児童2(S[2])の pf の記録・名簿の項目が無く、退避に pf-residual がある
            const mkV2 = (skipSid) => {
                const roster = [], r26 = {}, r25 = {}, f26 = {};
                S.forEach((s, i) => { if (s.studentId === skipSid) return; roster.push({ id: i + 1, studentId: s.studentId, name: s.name, gender: s.gender, age: 10, note: 'n' + i }); r26[s.studentId] = { 握力: 20 + i, _owner: s.studentId }; r25[s.studentId] = { 握力: 10 + i, _owner: s.studentId }; f26[s.studentId] = { total: 30 + i, _owner: s.studentId }; });
                return { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(r26), pf_records_2025: JSON.stringify(r25), pf_fitness_2026: JSON.stringify(f26), pf_setting: JSON.stringify({ year: 2026 }) };
            };
            const resEntry = (sid, over) => Object.assign({ archiveId: 'arc_res1', archivedAt: '2026-08-01T00:00:00.000Z', studentId: sid, student: { studentId: sid, name: S[2].name }, sourceIndex: 2, reason: 'pf-residual', residual: true,
                data: { pf_records_2026: { 握力: 30, 上体起こし: 12, _owner: sid }, pf_records_2025: { 握力: 11, _owner: sid }, pf_fitness_2026: { total: 41, _owner: sid }, pf_roster: { id: 3, name: S[2].name, gender: '男', age: 11, note: 'nres' } } }, over || {});
            const restore = (id) => page.evaluate((id) => window.restoreArchivedResidual(id, { reload: false }), id);
            const sid = S[2].studentId;

            await seed(S, mkV2(sid), [resEntry(sid)]);
            const pre = await dump();
            const r = await restore('arc_res1');
            const post = await dump();
            const rec = JSON.parse(post.pf_records_2026), ro = JSON.parse(post.pf_roster);
            check('復元: ok・記録(3種類)がその児童の studentId のキーに戻る(持ち主の目印つき)', r.ok && rec[sid]._owner === sid && rec[sid].握力 === 30 && JSON.parse(post.pf_records_2025)[sid].握力 === 11 && JSON.parse(post.pf_fitness_2026)[sid].total === 41, JSON.stringify(r));
            check('復元: pf_roster に項目が名簿の順序の位置(児童1と児童3の間)に入り、age・note も戻る', ro.length === 6 && ro[2].studentId === sid && ro[2].age === 11 && ro[2].note === 'nres' && ro[2].id === 3, JSON.stringify(ro.map(e => e.studentId).map(x => x.slice(-2))));
            check('復元: 他の児童の記録・名簿の項目は1バイトも変わらない', S.filter(s => s.studentId !== sid).every(s => JSON.stringify(rec[s.studentId]) === JSON.stringify(JSON.parse(pre.pf_records_2026)[s.studentId])), '');
            check('復元: 退避のエントリは(残りが無いので)消える', JSON.parse(post[K.student_archive]).entries.length === 0, '');
            check('全キー比較: 変わったのは pf の4キーと退避だけ(名簿・18ストアは不変)', JSON.stringify(diffKeys(pre, post, true).sort()) === JSON.stringify(['pf_fitness_2026', 'pf_records_2025', 'pf_records_2026', 'pf_roster', K.student_archive].sort()) && post[K.master] === pre[K.master], diffKeys(pre, post, true).join(','));
            const un = await page.evaluate(() => window.undoRosterChange({ reload: false }));
            check('取り消し: 復元前と1バイトも変わらない(退避も戻る)', un.ok && diffKeys(pre, await dump(), true).length === 0, diffKeys(pre, await dump(), true).join(','));

            // 入力済みの項目は上書きしない
            const v2b = mkV2(null); const rb = JSON.parse(v2b.pf_records_2026); rb[sid].握力 = 99; v2b.pf_records_2026 = JSON.stringify(rb);
            await seed(S, v2b, [resEntry(sid)]);
            const rr = await restore('arc_res1'); const pb = await dump();
            const recB = JSON.parse(pb.pf_records_2026)[sid];
            const left = JSON.parse(pb[K.student_archive]).entries;
            check('入力済みの項目は上書きしない: 握力=99 はそのまま、まだ無い「上体起こし」だけ戻る', rr.ok && recB.握力 === 99 && recB.上体起こし === 12 && rr.restored >= 1 && rr.skipped >= 1, JSON.stringify({ rr, recB }));
            check('戻せなかった分(握力30・2025年度の握力11・集計41のうち入力済みと違うもの)は、退避に残る(residual のまま)', left.length === 1 && left[0].residual === true && left[0].data.pf_records_2026 && left[0].data.pf_records_2026.握力 === 30 && !left[0].data.pf_roster, JSON.stringify(left[0] && left[0].data).slice(0, 160));
            // 同じ値なら残さない
            const v2c = mkV2(null); const rcc = JSON.parse(v2c.pf_records_2026); rcc[sid] = { 握力: 30, 上体起こし: 12, _owner: sid }; v2c.pf_records_2026 = JSON.stringify(rcc);
            const rc25 = JSON.parse(v2c.pf_records_2025); rc25[sid] = { 握力: 11, _owner: sid }; v2c.pf_records_2025 = JSON.stringify(rc25);
            const fc = JSON.parse(v2c.pf_fitness_2026); fc[sid] = { total: 41, _owner: sid }; v2c.pf_fitness_2026 = JSON.stringify(fc);
            await seed(S, v2c, [resEntry(sid)]);
            const preC = await dump(); const rcRes = await restore('arc_res1');
            check('すでに同じ値が入っていて、名簿にも項目がある: 戻せるものが無い(nothing-to-restore)・全キー不変・退避も残る', rcRes.ok === false && rcRes.error === 'nothing-to-restore' && diffKeys(preC, await dump()).length === 0, JSON.stringify(rcRes));

            // 戻せない状態
            await seed(S, mkV2(sid), [resEntry(sid)]);
            const M = JSON.parse((await dump())[K.master]); M.students = M.students.filter(s => s.studentId !== sid); await page.evaluate((m) => storageVerifiedWrite(KEYS.master, JSON.stringify(m)), M);
            const preD = await dump(); const rd = await restore('arc_res1');
            check('名簿にその児童がいない: 「先に児童を名簿に戻してください」・全キー不変', rd.ok === false && rd.error === 'student-not-in-roster' && diffKeys(preD, await dump()).length === 0 && (await page.evaluate((r) => window.rosterErrorMessage(r), rd)).indexOf('先に、その児童を名簿に戻してください') !== -1, JSON.stringify(rd));
            await seed(S, pfFrom(S, shuffled), [resEntry(sid)]);
            const preE = await dump(); const re = await restore('arc_res1');
            check('新体力テストが旧方式: 戻さず(pf-not-v2)・全キー不変', re.ok === false && re.error === 'pf-not-v2' && diffKeys(preE, await dump()).length === 0, JSON.stringify(re));
            await seed(S, mkV2(sid), [resEntry(sid, { residual: false, reason: 'roster-delete' })]);
            const rf = await restore('arc_res1');
            check('pf-residual ではない退避には使えない(not-residual)', rf.ok === false && rf.error === 'not-residual', JSON.stringify(rf));
            check('存在しない退避ID(not-found)', (await restore('nope')).error === 'not-found', '');

            // 失敗注入
            {
                const KEYS_R = [K.student_archive, 'pf_fitness_2026', 'pf_records_2025', 'pf_records_2026', 'pf_roster', K.master];
                for (const [mode, label] of [['quota', '容量超過'], ['corrupt', '内容の破損'], ['crash', '強制終了(起動時の自動復旧)']]) {
                    const bad = [];
                    for (let i = 0; i < KEYS_R.length; i++) {
                        await seed(S, mkV2(sid), [resEntry(sid)]);
                        const p0 = await dump();
                        await fault(mode, i, KEYS_R);
                        const rx = await restore('arc_res1');
                        await unfault();
                        if (mode === 'crash') await page.evaluate(() => window.recoverRosterTxnOnStartup());
                        const p1 = await dump();
                        if (!(rx.ok === false && diffKeys(p0, p1).length === 0 && p1[K.roster_txn] === undefined)) bad.push(i + ':' + JSON.stringify(rx).slice(0, 60) + ':' + diffKeys(p0, p1).join(','));
                    }
                    check('復元の失敗注入(' + label + '・各書き込み位置' + KEYS_R.length + '通り): 元に戻り、全キーが復元前と同一', bad.length === 0, bad.slice(0, 3).join(' | '));
                }
            }

            // 画面(退避カード)
            await seed(S, mkV2(sid), [resEntry(sid), resEntry(S[4].studentId, { archiveId: 'arc_res2', student: { studentId: S[4].studentId, name: S[4].name } })]);
            await reload();
            await page.evaluate(() => { showView('settings'); }); await sleep(500);
            const uiRows = await page.evaluate(() => Array.from(document.querySelectorAll('#archiveList .ar-row')).map(r => ({ id: r.getAttribute('data-id'), text: r.textContent, restore: !!r.querySelector('button[data-act="restore-residual"]'), purge: !!r.querySelector('button[data-act="purge"]') })));
            check('退避カード: 名簿にも pf にも条件が揃う児童の pf-residual に「戻す」ボタンがある(2行とも、名簿に児童がいるため)', uiRows.length === 2 && uiRows.every(x => x.restore && x.purge && /新体力テストの記録のみ/.test(x.text)), JSON.stringify(uiRows).slice(0, 160));
            const bh = await page.$eval('#archiveList button[data-act="restore-residual"]', b => Math.round(b.getBoundingClientRect().height));
            check('「戻す」ボタンのタップ領域は44px以上', bh >= 44, String(bh));
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#archiveList .ar-row[data-id="arc_res1"] button[data-act="restore-residual"]')]);
            check('画面から戻す: 再読み込み後に「新体力テストの記録を戻しました」(元に戻す つき)', await toastHas('新体力テストの記録を戻しました', 4000), '');
            await sleep(1200);
            const fin = await dump();
            check('画面から戻す: 記録がその児童に戻り、退避は残り1件(もう1件はそのまま)', JSON.parse(fin.pf_records_2026)[sid]._owner === sid && JSON.parse(fin[K.student_archive]).entries.length === 1, '');
            // 名簿にいない児童の行: ボタンなし・案内
            await seed(S, mkV2(sid), [resEntry(sid)]);
            const M3 = JSON.parse((await dump())[K.master]); M3.students = M3.students.filter(s => s.studentId !== sid); await page.evaluate((m) => storageVerifiedWrite(KEYS.master, JSON.stringify(m)), M3);
            await reload(); await page.evaluate(() => { showView('settings'); }); await sleep(500);
            const nr = await page.evaluate(() => Array.from(document.querySelectorAll('#archiveList .ar-row')).map(r => ({ text: r.textContent, restore: !!r.querySelector('button[data-act^="restore"]'), purge: !!r.querySelector('button[data-act="purge"]') })));
            check('名簿にその児童がいないとき: 「戻す」は出さず、「先にその児童を名簿に戻すと、記録を戻せます」と案内(完全削除のみ)', nr.length === 1 && !nr[0].restore && nr[0].purge && nr[0].text.indexOf('先にその児童を名簿に戻す') !== -1, JSON.stringify(nr).slice(0, 140));
        }
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし(注入した意図的なエラーを除く)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== pf-takeover: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
