// H4 案B 段階2c: 新体力テスト(pf)連携。名簿変更(applyRosterChange)・復元・取り消しで、
//   - pf_roster が付け替え前のSPA名簿と「氏名・順序・id(位置+1)とも一致」する場合だけ、pf_records_年度・pf_fitness_年度・pf_roster を追従させる
//   - 一致しなければ pf には一切触れず、トーストで通知だけする(核となるデータの付け替えは通常どおり行う)
//   - pf の書き込みも、スナップショット・ジャーナル・ロールバック・起動時の自動復旧・取り消しの対象(同じトランザクション)
//
// pf の id は「SPA名簿の位置+1」。SPAの名簿を並べ替え・削除・転入しても pf 側には伝わらず、pf の「読み込み」で id が振り直されて
// 記録が別の児童に付く(既存の問題)。それを名簿変更の時点で防ぐ。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 注: v1.53.0(H4 段階4b)から起動時に旧方式→新方式へ移行するため、このテストは移行を無効化(テスト専用フック)して旧方式の動作を検証する。
// 実行: cd tests && node roster-pf.test.js

const puppeteer = require('puppeteer-core');
const { buildRaws, ownersOf, misplaced, STORE_NAMES, mkStudents, OPS } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;
const PF_KEYS = ['pf_roster', 'pf_records_2025', 'pf_records_2026', 'pf_fitness_2026'];
const NOTICE = '新体力テストの名簿がSPAの名簿と一致しないため、新体力テストのデータは更新していません';

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { window.__spaSkipPfMigration = true; }); // 旧方式(v1)の名簿変更の追従を、再読み込みをまたいで検証する(起動時の新方式への移行は pf-migration.test.js で検証)
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const INFRA = [K.roster_snapshot, K.roster_txn];
    const TXN_KEYS = (await page.evaluate(() => StudentRemap.STORES.map(s => s.key).concat([KEYS.master, KEYS.student_archive, KEYS.roster_snapshot, KEYS.roster_txn]))).concat(PF_KEYS);

    // ---------- ヘルパー ----------
    // pf のデータ: pf_roster(id=位置+1・age・note)・記録(2年度)・集計。値に持ち主(studentId)の目印を埋め込む
    const pfData = (students) => {
        const roster = [], rec26 = {}, rec25 = {}, fit26 = {};
        students.forEach((s, i) => {
            if (!s.name) return;
            roster.push({ id: i + 1, name: s.name, gender: s.gender || '', age: 10 + (i % 2), note: 'n' + i });
            rec26[String(i + 1)] = { 握力: 20 + i, _owner: s.studentId };
            rec25[String(i + 1)] = { 握力: 10 + i, _owner: s.studentId };
            fit26[String(i + 1)] = { total: 30 + i, eval: 'B', year: 2026, detail: {}, _owner: s.studentId };
        });
        return { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec26), pf_records_2025: JSON.stringify(rec25), pf_fitness_2026: JSON.stringify(fit26), pf_setting: JSON.stringify({ year: 2026, grade: 5, className: '5年1組' }) };
    };
    async function seed(n, pfOverride) {
        const students = mkStudents(n || 6);
        const raws = buildRaws(K, students);
        const pf = pfOverride === null ? {} : Object.assign(pfData(students), pfOverride || {});
        const extras = { [K.tests]: '[{"id":1,"subject":"算数","name":"t","category":"知識・技能","maxScore":100,"date":"2026-05-10","term":"1"}]', 'doc-index-v1': 'other-app' };
        await page.evaluate((K, raws, extras, pf, students) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).concat(Object.keys(extras)).forEach(k => storageVerifiedWrite(k, raws[k] !== undefined ? raws[k] : extras[k]));
            Object.keys(pf).forEach(k => { if (pf[k] === null) return; storageVerifiedWrite(k, pf[k]); });
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, extras, pf, students);
        return { students, raws };
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (pre, post) => Array.from(new Set(Object.keys(pre).concat(Object.keys(post)))).filter(k => INFRA.indexOf(k) === -1 && !NOISE.test(k) && pre[k] !== post[k]);
    const pfDiff = (pre, post) => diffKeys(pre, post).filter(k => /^pf_/.test(k));
    const applyNS = (ns, opts) => page.evaluate((ns, opts) => window.applyRosterChange(ns, opts), ns, opts || { reload: false });
    const fault = (mode, at) => page.evaluate((mode, at, keys) => {
        const set = new Set(keys), state = { n: 0, log: [] };
        const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
        window.__fault = { state: state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
        Storage.prototype.setItem = function(k, v) {
            if (set.has(k)) {
                if (mode === 'crash' && state.n >= at) throw new Error('crash');
                const i = state.n++; state.log.push(k);
                if (mode === 'quota' && i === at) throw new DOMException('quota', 'QuotaExceededError');
                if (mode === 'corrupt' && i === at) return oSet.call(this, k, String(v).slice(0, Math.max(0, String(v).length - 3)));
            }
            return oSet.apply(this, arguments);
        };
        Storage.prototype.removeItem = function(k) { if (set.has(k) && mode === 'crash' && state.n >= at) throw new Error('crash'); return oRem.apply(this, arguments); };
    }, mode, at === undefined ? 1e9 : at, TXN_KEYS);
    const unfault = () => page.evaluate(() => { const s = window.__fault ? window.__fault.state : null; if (window.__fault) { window.__fault.restore(); window.__fault = null; } return s; });
    const reloadWait = async () => { await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000); };
    // トーストの表示を確認する(#toast が表示中で、#toastMsg に文言がある)。document.body.textContent は使わない:
    // インライン <script> のソース文字列も含み、文言が常に見つかってしまうため。表示中(2.5秒)を待って確認する。
    const bodyHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 1500, polling: 50 }, t).then(() => true).catch(() => false);
    const delNS = (base) => OPS[2].make(base);
    // pf の持ち主の照合: 記録・集計のキー id の持ち主 = 新名簿[id-1] の studentId か
    const pfOwners = (d, newStudents) => {
        const bad = [];
        ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].forEach((key) => {
            const o = JSON.parse(d[key] || '{}');
            Object.keys(o).forEach((id) => { const s = newStudents[Number(id) - 1]; if (!s || !s.studentId || o[id]._owner !== s.studentId) bad.push(key + '#' + id); });
        });
        return bad;
    };
    const coreMis = (post, ids, newStudents) => { const m = misplaced(ownersOf(K, post, ids), newStudents); return STORE_NAMES.filter(n => m[n].shifted !== 0); };

    try {
        // ================= A. 名簿が一致する場合: pf が追従する =================
        console.log('--- A. pf_roster が一致 → pf の記録・集計・名簿が追従 ---');
        for (const op of OPS) {
            const s = await seed(); const ids = s.students.map(x => x.studentId);
            const pre = await dump();
            const ns = op.make(s.students);
            const r = await applyNS(ns);
            const post = await dump();
            const mNew = JSON.parse(post[K.master]).students;
            const rosterNew = JSON.parse(post.pf_roster);
            const nonEmpty = mNew.filter(x => x.name);
            const isNoop = op.name.indexOf('R0') === 0;
            check(op.name + ': ' + (isNoop ? '同一名簿は noop で pf にも触れない' : 'pf が追従(status=followed)'), r.ok && (isNoop ? (r.noop && r.wrote === false && pfDiff(pre, post).length === 0) : r.pf.status === 'followed'), JSON.stringify(r.pf));
            if (isNoop) continue;
            check(op.name + ': pf の記録・集計(2年度分・体力集計)の持ち主が、新しい名簿の同じ児童に付いている(ずれ0)', pfOwners(post, mNew).length === 0, JSON.stringify(pfOwners(post, mNew)));
            check(op.name + ': pf_roster が新しいSPA名簿から作り直される(氏名・順序・id=位置+1)', rosterNew.length === nonEmpty.length && rosterNew.every((e, i) => e.name === mNew.filter(x => x.name)[i].name && e.id === mNew.findIndex(x => x === mNew.filter(y => y.name)[i]) + 1), JSON.stringify(rosterNew.map(e => [e.id, e.name])));
            const carried = rosterNew.filter(e => e.note !== undefined).every(e => { const j = e.id - 1; const oi = ids.indexOf(mNew[j].studentId); return oi === -1 ? false : e.note === 'n' + oi && e.age === 10 + (oi % 2); });
            check(op.name + ': 生き残る児童の pf の項目(age・note)は引き継がれ、転入生は age=10', carried && rosterNew.filter(e => e.note === undefined).every(e => e.age === 10), JSON.stringify(rosterNew.slice(0, 3)));
            check(op.name + ': pf_setting・課題・別アプリのキーは1バイトも変わらない', pre.pf_setting === post.pf_setting && pre[K.tests] === post[K.tests] && pre['doc-index-v1'] === post['doc-index-v1'], '');
            check(op.name + ': 核となる18ストアも同時にずれ0', coreMis(post, ids, mNew).length === 0, JSON.stringify(coreMis(post, ids, mNew)));
            if (op.name.indexOf('R2') === 0) {
                const arch = JSON.parse(post[K.student_archive]);
                const e = arch.entries[0];
                check('R2: 削除した児童の pf の記録・集計・pf_roster の項目が退避に入る(2年度分の記録・集計・名簿の項目)', e.studentId === ids[1] && e.data.pf_records_2026 && e.data.pf_records_2025 && e.data.pf_fitness_2026 && e.data.pf_roster.note === 'n1' && e.data.pf_records_2026._owner === ids[1], JSON.stringify(Object.keys(e.data).filter(k => /^pf_/.test(k))));
                check('R2: どの pf キーにも削除した児童の記録が残らない', PF_KEYS.every(k => k === 'pf_roster' || Object.keys(JSON.parse(post[k])).every(id => JSON.parse(post[k])[id]._owner !== ids[1])), '');
                const snap = JSON.parse(post[K.roster_snapshot]);
                check('R2: スナップショットに書き換えた pf のキーも入っている(ロールバック・取り消しの対象)', PF_KEYS.every(k => k in snap.keys && snap.keys[k] === pre[k]), JSON.stringify(Object.keys(snap.keys).filter(k => /^pf_/.test(k))));
            }
        }
        // 改名のみ(同一名簿・氏名だけ変更): pf_roster の氏名だけ追従(記録は動かない)。トランザクション(名簿+pf_roster)
        let s = await seed(); let pre = await dump();
        const rr = await applyNS(s.students.map((x, i) => i === 1 ? Object.assign({}, x, { name: '改名後' }) : Object.assign({}, x)));
        let post = await dump();
        check('改名のみ: 名簿と pf_roster の氏名が追従し、pf の記録・集計は不変(同じトランザクションで更新)', rr.ok && rr.noop && rr.pf.status === 'followed' && JSON.parse(post.pf_roster)[1].name === '改名後' && JSON.parse(post.pf_roster)[1].note === 'n1' && ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].every(k => pre[k] === post[k]) && JSON.parse(post[K.roster_txn]).state === 'committed', JSON.stringify(rr));

        // ================= B. 名簿が一致しない場合: pf には触れず通知のみ =================
        console.log('--- B. pf_roster が不一致 → pf には触れず、トーストで通知のみ ---');
        const variants = [
            ['氏名の順序が違う', (st) => { const d = pfData(st); const r = JSON.parse(d.pf_roster); [r[0], r[1]] = [r[1], r[0]]; return { pf_roster: JSON.stringify(r) }; }],
            ['pf にだけ余分な児童がいる', (st) => { const d = pfData(st); const r = JSON.parse(d.pf_roster); r.push({ id: 7, name: '余分', gender: '男', age: 10 }); return { pf_roster: JSON.stringify(r) }; }],
            ['id が位置+1 ではない(手入力の名簿など)', (st) => { const d = pfData(st); const r = JSON.parse(d.pf_roster).map((e, i) => Object.assign(e, { id: 101 + i })); return { pf_roster: JSON.stringify(r) }; }],
            ['氏名が違う(pf側で改名した)', (st) => { const d = pfData(st); const r = JSON.parse(d.pf_roster); r[2].name = '別の氏名'; return { pf_roster: JSON.stringify(r) }; }],
            ['pf_roster が無く、記録だけがある', () => ({ pf_roster: null })],
            ['pf_roster が壊れている(JSONではない)', () => ({ pf_roster: '{壊れた' })]
        ];
        for (const [label, mk] of variants) {
            const st0 = mkStudents(6);
            s = await seed(6, mk(st0)); const ids = s.students.map(x => x.studentId);
            pre = await dump();
            const r = await applyNS(delNS(s.students));
            post = await dump();
            const mNew = JSON.parse(post[K.master]).students;
            check('不一致(' + label + '): pf のキー(名簿・記録・集計)は1バイトも変わらない・status=mismatch', r.ok && r.pf.status === 'mismatch' && pfDiff(pre, post).length === 0, JSON.stringify(r.pf) + ' ' + JSON.stringify(pfDiff(pre, post)));
            check('不一致(' + label + '): トーストで通知される(新体力テストのデータは更新していません)', await bodyHas(NOTICE), '');
            check('不一致(' + label + '): 核となる18ストアの付け替えは通常どおり行われる(ずれ0)・退避にpfは含まれない', coreMis(post, ids, mNew).length === 0 && !Object.keys(JSON.parse(post[K.student_archive]).entries[0].data).some(k => /^pf_/.test(k)), '');
        }
        // pf のデータが何も無い: status none・通知なし・pf のキーを作らない
        s = await seed(6, null); pre = await dump();
        const rnone = await applyNS(delNS(s.students)); post = await dump();
        check('pf のデータが無い: status=none・pf のキーを作らない・通知しない', rnone.ok && rnone.pf.status === 'none' && !Object.keys(post).some(k => /^pf_/.test(k)), JSON.stringify(rnone.pf));
        // 改名のみ + 不一致: 名簿だけ更新、pf は不変、通知
        s = await seed(6, { pf_roster: JSON.stringify(JSON.parse(pfData(mkStudents(6)).pf_roster).reverse()) }); pre = await dump();
        const rr2 = await applyNS(s.students.map((x, i) => i === 1 ? Object.assign({}, x, { name: '改名後' }) : Object.assign({}, x)));
        post = await dump();
        check('改名のみ+不一致: 名簿だけ更新し、pf は不変・通知あり', rr2.ok && rr2.wrote && rr2.pf.status === 'mismatch' && pfDiff(pre, post).length === 0 && JSON.parse(post[K.master]).students[1].name === '改名後', JSON.stringify(rr2));
        // 再読み込みを伴う場合: 通知が再読み込みで消えず、再読み込み後にも表示される
        s = await seed(6, { pf_roster: JSON.stringify(JSON.parse(pfData(mkStudents(6)).pf_roster).reverse()) });
        await applyNS(delNS(s.students), { reload: true });
        await sleep(1500); await page.waitForFunction(() => typeof StorageManager !== 'undefined');
        check('再読み込み後にも、新体力テストが更新されなかった通知が表示される(名簿設定の画面も開く)', await bodyHas(NOTICE, 8000) && (await page.evaluate(() => (document.querySelector('.view.active') || {}).id)) === 'view-settings', '');

        // ================= C. pf もトランザクション(スナップショット・ジャーナル・ロールバック・起動時復旧) =================
        console.log('--- C. pf の書き込みも同じトランザクションに含まれる ---');
        s = await seed(); await fault('count'); await applyNS(delNS(s.students));
        const W = (await unfault()).log;
        check('前提: 途中削除の書き込みは 27回(スナップショット・ジャーナル・退避・18ストア・pf4キー・名簿・確定)。pf は名簿の直前', W.length === 27 && W.slice(-6, -2).every(k => /^pf_/.test(k)) && W[W.length - 2] === K.master, W.map(k => k.replace('spa_', '')).join(','));
        let crashBad = [], qBad = [], cBad = [];
        for (let k = 0; k < W.length; k++) {
            s = await seed(); pre = await dump();
            await fault('crash', k);
            const r = await applyNS(delNS(s.students));
            await unfault();
            await reloadWait();
            post = await dump();
            const clean = !(K.roster_txn in post) && !(K.roster_snapshot in post) && !(K.student_archive in post);
            if (!(r.ok === false && diffKeys(pre, post).length === 0 && clean)) crashBad.push({ k: k, write: W[k], diff: diffKeys(pre, post).slice(0, 3), clean: clean });
        }
        check('pf を含む中断(全27通り): 再起動で自動復旧し、全キー(pf 4キーを含む)が名簿変更前と1バイトも変わらない', crashBad.length === 0, JSON.stringify(crashBad.slice(0, 2)));
        for (let j = 0; j < W.length; j++) {
            for (const mode of ['quota', 'corrupt']) {
                s = await seed(); pre = await dump();
                await fault(mode, j);
                const r = await applyNS(delNS(s.students));
                await unfault();
                post = await dump();
                const clean = !(K.roster_txn in post) && !(K.roster_snapshot in post) && !(K.student_archive in post);
                if (!(r.ok === false && diffKeys(pre, post).length === 0 && clean)) (mode === 'quota' ? qBad : cBad).push({ j: j, write: W[j], r: r.error, diff: diffKeys(pre, post).slice(0, 3) });
            }
        }
        check('pf を含む容量超過の注入(全27通り): ロールバックされ、全キー(pf を含む)が変更前と同一', qBad.length === 0, JSON.stringify(qBad.slice(0, 2)));
        check('pf を含む内容破損の注入(全27通り): 検出してロールバックされ、全キー(pf を含む)が変更前と同一', cBad.length === 0, JSON.stringify(cBad.slice(0, 2)));

        // ================= D. 取り消し =================
        console.log('--- D. 取り消し ---');
        s = await seed(); pre = await dump();
        await applyNS(delNS(s.students));
        const u1 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('取り消し: 名簿・核データとともに pf(記録・集計・名簿)も変更前に戻る(全キー不変)', u1.ok && diffKeys(pre, await dump()).length === 0, JSON.stringify(u1));
        s = await seed();
        await applyNS(delNS(s.students));
        await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_records_2026')); r['1'].握力 = 99; localStorage.setItem('pf_records_2026', JSON.stringify(r)); }); // pf で記録を入力
        const afterPf = await dump();
        const u2 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('取り消し: 名簿変更のあとに pf へ入力があれば取り消さず(changed-since・対象に pf のキー)、トーストで理由を表示し、データは不変', u2.ok === false && u2.error === 'changed-since' && u2.keys.indexOf('pf_records_2026') !== -1 && await bodyHas('取り消せません') && JSON.stringify(afterPf) === JSON.stringify(await dump()), JSON.stringify(u2));

        // ================= E. 退避からの復元 =================
        console.log('--- E. 退避からの復元と pf ---');
        s = await seed(); pre = await dump();
        const ids2 = s.students.map(x => x.studentId);
        await applyNS(delNS(s.students));
        const sum = await page.evaluate(() => studentArchiveSummary());
        const rs = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), sum[0].archiveId);
        post = await dump();
        const mR = JSON.parse(post[K.master]).students;
        check('復元(pf名簿が一致): pf の記録・集計・名簿が末尾(id=6)に同じ児童として戻る', rs.ok && rs.pf.status === 'followed' && pfOwners(post, mR).length === 0 && JSON.parse(post.pf_records_2026)['6']._owner === ids2[1] && JSON.parse(post.pf_records_2025)['6']._owner === ids2[1] && JSON.parse(post.pf_fitness_2026)['6']._owner === ids2[1], JSON.stringify(rs));
        const rosterR = JSON.parse(post.pf_roster);
        check('復元: pf_roster にも末尾のエントリ(id=6・氏名・元の age/note)が戻り、他の児童のエントリは変わらない', rosterR.length === 6 && rosterR[5].id === 6 && rosterR[5].name === '児童1' && rosterR[5].note === 'n1' && rosterR.slice(0, 5).every((e, i) => e.id === i + 1), JSON.stringify(rosterR[5]));
        const countIds = (raw) => Object.keys(JSON.parse(raw)).length;
        check('復元: 削除→復元で pf の各キーの項目数が元と同じ(保存則。記録を失わない)', ['pf_records_2026', 'pf_records_2025', 'pf_fitness_2026'].every(k => countIds(post[k]) === countIds(pre[k])), '');
        // pf の名簿が一致しない状態で復元: pf には触れず、pf の分は退避に残す(pf-residual)
        s = await seed(); await applyNS(delNS(s.students));
        await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_roster')); r.reverse(); localStorage.setItem('pf_roster', JSON.stringify(r)); }); // pf 側で名簿が食い違った
        const preR = await dump();
        const sum2 = await page.evaluate(() => studentArchiveSummary());
        const rs2 = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), sum2[0].archiveId);
        const postR = await dump();
        check('復元(pf名簿が不一致): 核データ・名簿は戻り、pf のキーには触れず、通知される', rs2.ok && rs2.pf.status === 'mismatch' && pfDiff(preR, postR).length === 0 && await bodyHas('新体力テストの記録は戻せませんでした'), JSON.stringify(rs2));
        const archR = JSON.parse(postR[K.student_archive]);
        const resid = archR.entries.find(e => e.residual);
        check('復元(pf名簿が不一致): pf の分だけが退避に「pf-residual」として残る(消えない)。退避中の児童の数には数えない', !!resid && resid.reason === 'pf-residual' && Object.keys(resid.data).every(k => /^pf_/.test(k)) && !!resid.data.pf_records_2026 && (await page.evaluate(() => studentArchiveSummary())).length === 0, JSON.stringify(archR.entries.map(e => [e.reason, !!e.residual])));
        const rres = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), resid.archiveId);
        check('pf-residual は復元できない(residual-not-restorable)・完全削除はできる', rres.ok === false && rres.error === 'residual-not-restorable' && (await page.evaluate((id) => window.purgeArchivedStudent(id), resid.archiveId)).ok === true, JSON.stringify(rres));
        // 復元の途中失敗(pf の書き込みで破損) → ロールバック(pf を含め全キー不変)
        s = await seed(); await applyNS(delNS(s.students)); pre = await dump();
        const sum3 = await page.evaluate(() => studentArchiveSummary());
        await fault('count');
        await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), sum3[0].archiveId);
        const RW = (await unfault()).log;
        s = await seed(); await applyNS(delNS(s.students)); pre = await dump();
        const sum4 = await page.evaluate(() => studentArchiveSummary());
        const pfIdx = RW.findIndex(k => /^pf_/.test(k));
        await fault('corrupt', pfIdx);
        const rfail = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), sum4[0].archiveId);
        await unfault();
        check('復元の途中で pf の書き込みが破損 → 検出してロールバックし、pf を含め全キーが復元前のまま', rfail.ok === false && rfail.rolledBack === true && diffKeys(pre, await dump()).length === 0, JSON.stringify(rfail) + ' idx=' + pfIdx);

        // ================= F. 鏡(IndexedDB)との整合 =================
        s = await seed();
        await applyNS(delNS(s.students), { reload: true });
        await sleep(1800); await page.waitForFunction(() => typeof StorageManager !== 'undefined'); await sleep(900);
        const ls = await dump();
        const idb = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('spa_classroom_db'); q.onsuccess = (e) => { const db = e.target.result; const g = db.transaction('kv', 'readonly').objectStore('kv').getAll(); g.onsuccess = () => { db.close(); res(g.result); }; }; }));
        const mm = Object.keys(ls).filter(k => (idb.find(x => x.key === k) || {}).value !== ls[k]);
        check('名簿変更→再読み込み後: pf のキーを含め、IndexedDB(鏡)と localStorage の全キーの値が一致する', mm.length === 0 && PF_KEYS.every(k => k in ls), JSON.stringify(mm));
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        try {
            await page.evaluate((bk) => {
                if (window.__fault) { window.__fault.restore(); }
                StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear();
                Object.keys(bk).forEach(k => { if (bk[k] !== null) localStorage.setItem(k, bk[k]); });
            }, realBackup);
        } catch (e) {}
        check('コンソールエラーなし(意図した障害注入のログを除く)', consoleErrors.filter(e => !/crash|rolling back|rollback|recoverRosterTxn|quota|Quota|容量超過|master load error|verify|Failed to load resource|localStorage/.test(e)).length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== roster-pf: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
