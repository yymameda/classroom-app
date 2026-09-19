// 名簿操作で児童データがずれないこと(H4 案B)。期待値は「6操作 × 18ストアで ずれ0」。
//
// A. 付け替え計画レベル(段階2a・有効): 純関数 StudentRemap.planRosterChange が返す新しい生JSONについて、
//    6操作 × 18ストアの全セルで「添字iのデータの持ち主 = 新名簿[i]の studentId」になること、
//    削除された児童のデータが全ストアから消えて退避分に入ること、転入生の添字にデータが付かないこと、
//    件数の保存則が成り立つことを、目印(helpers/roster-data.js)だけで検証する。
// B. 実適用レベル(段階2b/3で有効化): 実際の名簿変更(applyRosterChange / 名簿UI)を通した保存後のデータで、
//    同じ 6操作 × 18ストア のずれ0を検証する。applyRosterChange が未実装の間は SKIP(FAIL 0 を維持)。
//    未実装のまま失敗する状態を確認したいときは ROSTER_SHIFT_FORCE=1 で実行する。
//
// 現状の(付け替えなしの)保存で並べ替え・削除・挿入がずれることは、DATA_FLOW_AUDIT.md 7.2 に再現結果を記録済み。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node roster-shift.test.js

const puppeteer = require('puppeteer-core');
const { buildRaws, ownersOf, misplaced, OPS, LABELS, STORE_NAMES, mkStudents } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const FORCE = process.env.ROSTER_SHIFT_FORCE === '1';
const results = [];
function check(name, cond, detail, quiet) {
    results.push({ name, pass: !!cond, detail });
    if (!cond || !quiet) console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept());

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });

    const N = 6;
    const base = mkStudents(N);
    const originalIds = base.map(s => s.studentId);

    try {
        // ================= A. 付け替え計画レベル =================
        console.log('--- A. 付け替え計画(純関数)レベル: 6操作 × 18ストア ---');
        const raws = buildRaws(K, base);
        const before = ownersOf(K, raws, originalIds);
        check('前提: 18ストアすべてに目印付きデータがある', STORE_NAMES.length === 18 && STORE_NAMES.every(n => before[n].length >= N), STORE_NAMES.filter(n => before[n].length < N).join(','));
        let cells = 0;
        for (const op of OPS) {
            const newStudents = op.make(base);
            const plan = await page.evaluate((raws, base, ns) => StudentRemap.planRosterChange(raws, base, ns), raws, base, newStudents);
            check(op.name + ': 計画が成立(ok・不変条件の違反0)', plan.ok === true && plan.violations.length === 0, JSON.stringify(plan.violations || plan.error));
            const after = Object.assign({}, raws, plan.newRaw);
            const owners = ownersOf(K, after, originalIds);
            const mis = misplaced(owners, newStudents);
            const deletedIds = originalIds.filter(id => !newStudents.some(s => s.studentId === id));
            STORE_NAMES.forEach((name) => {
                cells++;
                const expectedTotal = before[name].length - before[name].filter(e => deletedIds.indexOf(e.owner) !== -1).length;
                const ok = mis[name].shifted === 0 && mis[name].total === expectedTotal;
                check(op.name + ' × ' + LABELS[name] + ': ずれ0(' + mis[name].shifted + '/' + mis[name].total + '、期待件数' + expectedTotal + ')', ok, '', true);
            });
            // 削除された児童: どのストアにも残らず、退避分に全ストア分入る
            deletedIds.forEach((id) => {
                const leftovers = STORE_NAMES.filter(n => owners[n].some(e => e.owner === id));
                check(op.name + ': 削除した児童のデータがどのストアにも残らない', leftovers.length === 0, leftovers.join(','));
                const archivedStores = Object.keys(plan.archive[id] || {}).length;
                check(op.name + ': 削除した児童のデータが退避分に全ストア分入る(18ストア)', archivedStores === 18, String(archivedStores));
                const entry = (plan.archiveEntries || []).find(e => e.studentId === id);
                check(op.name + ': 退避に児童オブジェクト(氏名・視力・身長)と元の添字が残る', !!entry && entry.student.name === '児童1' && entry.student.height === 131 && entry.sourceIndex === 1, JSON.stringify(entry && { n: entry.student.name, h: entry.student.height, i: entry.sourceIndex }));
            });
            // 転入生: 添字にデータが付かない
            plan.remap.added.forEach((idx) => {
                const attached = STORE_NAMES.filter(n => owners[n].some(e => e.idx === idx));
                check(op.name + ': 転入生(添字' + idx + ')に他の児童のデータが付かない', attached.length === 0, attached.join(','));
            });
            if (op.name.indexOf('R0') === 0) check('R0: 同一名簿は noop(書き込みなし・新しい生JSONなし)', plan.noop === true && Object.keys(plan.newRaw).length === 0, JSON.stringify(Object.keys(plan.newRaw)));
        }
        check('A: 6操作 × 18ストア = 108セルを検証した', cells === 108, String(cells));

        // 検算: 付け替えをしない(現状の保存と同じ)場合は、並べ替え・途中削除・途中挿入で全18ストアがずれる。
        // = このテストの照合は、ずれを実際に検出できる(付け替えが壊れればここで挙げた操作は必ずFAILになる)。
        for (const op of OPS.filter(o => /^R[123]/.test(o.name))) {
            const mis = misplaced(ownersOf(K, raws, originalIds), op.make(base));
            const notDetected = STORE_NAMES.filter(n => mis[n].shifted === 0);
            check('検算: 付け替えなしの ' + op.name + ' は全18ストアでずれが検出される', notDetected.length === 0, notDetected.join(','));
        }

        // ================= B. 実適用レベル(段階2b/3で有効化) =================
        console.log('--- B. 実適用レベル(applyRosterChange 経由) ---');
        const hasApply = await page.evaluate(() => typeof window.applyRosterChange === 'function');
        if (!hasApply && !FORCE) {
            console.log('SKIP - 実適用(applyRosterChange・名簿UI経由)の 6操作 × 18ストア は段階2b/3の実装後に有効化(現状は未接続。ROSTER_SHIFT_FORCE=1 で失敗を確認できる)');
        } else {
            for (const op of OPS) {
                const newStudents = op.make(base);
                await page.evaluate((K, raws, base) => {
                    StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
                    Object.keys(raws).forEach(k => StorageManager.setImmediate(k, raws[k]));
                    StorageManager.setImmediate(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1 }, students: base }));
                }, K, raws, base);
                await page.reload({ waitUntil: 'networkidle0' });
                await sleep(400);
                const applied = await page.evaluate(async (ns) => {
                    if (typeof window.applyRosterChange !== 'function') return { ok: false, error: 'applyRosterChange is not a function' };
                    try { const r = await window.applyRosterChange(ns); return r || { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
                }, newStudents);
                await sleep(1500); // 適用後の自動再読み込みを待つ
                const stored = await page.evaluate((K) => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return { raws: o, master: JSON.parse(StorageManager.getRaw(K.master) || '{"students":[]}').students }; }, K);
                const owners = ownersOf(K, stored.raws, originalIds);
                const mis = misplaced(owners, stored.master);
                check(op.name + '(実適用): 適用が成功する', applied.ok !== false, JSON.stringify(applied));
                STORE_NAMES.forEach((name) => check(op.name + '(実適用) × ' + LABELS[name] + ': ずれ0', applied.ok !== false && mis[name].shifted === 0, mis[name].shifted + '/' + mis[name].total, true));
            }
        }
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        await page.evaluate((bk) => {
            StorageManager.getAllKeys().slice().forEach(k => { if (!(k in bk)) StorageManager.remove(k); });
            Object.keys(bk).forEach(k => { if (bk[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, bk[k]); });
        }, realBackup);
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== roster-shift: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
