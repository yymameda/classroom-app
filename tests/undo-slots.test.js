// 取り消し点の枠を種類ごとに分ける(v1.57.0。DATA_FLOW_AUDIT.md 26章)。
//   これまで名簿変更・バックアップの復元・新体力テストの引き継ぎ/記録の復元・入力形式の変更は、取り消し点(スナップショット+ジャーナル)を
//   1つの枠で共有しており、あとの変更が前の取り消し点を上書きしていた。種類ごとの別のキーに分け、互いに上書きしない。
//   枠: roster(名簿変更・退避した児童を戻す)=spa_roster_* / backup-restore / pf-takeover / pf-restore / input-mode-fix=spa_undo_*
//       (pf-migration=起動時の自動移行は専用の一時枠。成功すると消え、取り消し点にはならない)
//   入力形式の変更の取り消しボタンは、課題の編集画面に置く(設定の名簿カードには出さない)。
//   既存の仕組み(スナップショット・ジャーナル・起動時の自動復旧・容量確認・検証付き書き込み・ロールバック)は保つ。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node undo-slots.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { window.__spaSkipPfMigration = true; }); // 対象は取り消しの枠。pf の自動移行は別のテストで検証する
    const consoleErrors = [];
    let dialogs = 0;
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1 && !/crash|quota|verify failed|rollback|snapshot/i.test(t)) consoleErrors.push(t); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const SLOT = {
        roster: [K.roster_snapshot, K.roster_txn], br: [K.undo_br_snapshot, K.undo_br_txn], pft: [K.undo_pft_snapshot, K.undo_pft_txn],
        pfr: [K.undo_pfr_snapshot, K.undo_pfr_txn], imf: [K.undo_imf_snapshot, K.undo_imf_txn], pfm: [K.undo_pfm_snapshot, K.undo_pfm_txn]
    };
    const ALL_UNDO = [].concat(...Object.values(SLOT));

    const N = 5;
    const stu = (i, nm) => ({ name: nm || ('秘匿' + i + '氏'), studentId: 'stu_slt0000' + String(i).padStart(2, '0') });
    const T = (o) => Object.assign({ subject: '国語', testType: '小テスト', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-01' }, o);
    const S = (id, testId, idx, score) => ({ id: id, studentIndex: idx, testId: testId, score: score });
    // 入力形式が食い違っている課題(先生の旧作文と同じ条件: 満点5・数値の記録・判定上は5段階)
    const SAKU = T({ id: 1001, name: '作文_運動会なりきり', testType: '作文', category: '思考・判断・表現', maxScore: 5, date: '2026-05-20' });
    const SAKU2 = T({ id: 1002, name: '作文_遠足なりきり', testType: '作文', category: '思考・判断・表現', maxScore: 5, date: '2026-05-25' });
    const saku1 = Array.from({ length: N }, (_, i) => S(100 + i, 1001, i, 1 + (i % 5)));
    const saku2 = Array.from({ length: N }, (_, i) => S(200 + i, 1002, i, 1 + (i % 5)));
    async function seed(tests, scores, extra) {
        await page.evaluate((tests, scores, N, extra) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear(); window.__pendingIdbDeletes = [];
            const students = Array.from({ length: N }, (_, i) => ({ name: '秘匿' + i + '氏', studentId: 'stu_slt0000' + String(i).padStart(2, '0') }));
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3, teacher: 'T' } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            Object.keys(extra || {}).forEach(k => localStorage.setItem(k, extra[k]));
        }, tests, scores, N, extra || {});
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(500);
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (a, b, skipUndo) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(k => !NOISE.test(k) && !(skipUndo && ALL_UNDO.indexOf(k) !== -1) && a[k] !== b[k]);
    const st = (id) => page.evaluate((id) => { const u = srUndoStatus(id); return { available: u.available, reason: u.reason, kind: u.kind }; }, id);
    // 名簿変更: i番目とその次の児童を入れ替える(並べ替え=記録の付け替えが起きるので、取り消し点(トランザクション)ができる。改名だけの変更は記録に触れないので対象外)
    const rename = (i, _label) => page.evaluate((i) => {
        const m = JSON.parse(StorageManager.getRaw(KEYS.master)); const ns = m.students.map(s => Object.assign({}, s));
        const t = ns[i]; ns[i] = ns[i + 1]; ns[i + 1] = t;
        return window.applyRosterChange(ns, { reload: false });
    }, i);
    const fixIt = (id, mx) => page.evaluate((id, mx) => window.recFixInputMode(id, mx), id, mx);
    const undo = (slot) => page.evaluate((slot) => window.undoRosterChange({ reload: false, slot: slot }), slot);
    const masterName = (i) => page.evaluate((i) => JSON.parse(StorageManager.getRaw(KEYS.master)).students[i].name, i);
    const testInputMode = (id) => page.evaluate((id) => (JSON.parse(StorageManager.getRaw(KEYS.tests)).find(t => t.id === id) || {}).inputMode, id);
    const toastHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 3000 }, t).then(() => true).catch(() => false);
    const openEdit = async (id) => {
        await page.evaluate((id) => { showView('records'); recShowSub('input'); recSelectTestGoto(id); }, id);
        await sleep(200);
        await page.click('#recEditThisTestBtn');
        await sleep(300);
    };

    try {
        // ============ 1. 名簿変更 → 入力形式の変更: 互いに上書きしない ============
        console.log('--- 1. 名簿変更のあとに入力形式を直す ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        const r1 = await rename(1, '並べ替え一');
        check('前提: 名簿変更(並べ替え)が成功し、名簿の枠(spa_roster_*)に取り消し点ができる', r1.ok && (await st('roster')).available && (await st('input-mode-fix')).reason === 'nothing', JSON.stringify(r1).slice(0, 100));
        const rosterTxn0 = (await dump())[K.roster_txn], rosterSnap0 = (await dump())[K.roster_snapshot];
        const preFix = await dump();
        const f1 = await fixIt(1001);
        check('入力形式の変更が成功する', f1.ok && (await testInputMode(1001)) === 'score', JSON.stringify(f1).slice(0, 100));
        const d1 = await dump();
        check('名簿変更の取り消し点(スナップショット・ジャーナル)は、1文字も変わらず残っている(上書きされない)', d1[K.roster_txn] === rosterTxn0 && d1[K.roster_snapshot] === rosterSnap0, '');
        check('入力形式の変更は専用の枠(spa_undo_input_mode_fix_*)に保存される(種別=input-mode-fix・課題名つき)', !!d1[K.undo_imf_txn] && JSON.parse(d1[K.undo_imf_txn]).kind === 'input-mode-fix' && JSON.parse(d1[K.undo_imf_txn]).name === '作文_運動会なりきり', '');
        check('両方の取り消しが同時に有効', (await st('roster')).available && (await st('input-mode-fix')).available, JSON.stringify([await st('roster'), await st('input-mode-fix')]));
        // 画面: 設定の名簿カードは名簿変更のボタンだけ / 編集画面には入力形式のボタン
        await page.evaluate(() => { showView('settings'); }); await sleep(400);
        const bar = await page.evaluate(() => Array.from(document.querySelectorAll('#rosterUndoBar button')).map(b => ({ id: b.id, slot: b.getAttribute('data-slot'), text: b.textContent, h: b.getBoundingClientRect().height })));
        check('設定の名簿カード: 取り消しボタンは名簿変更の1つだけ(入力形式のボタンは出ない)', bar.length === 1 && bar[0].id === 'rosterUndoBtn' && bar[0].slot === 'roster' && /名簿変更を取り消す/.test(bar[0].text) && bar[0].h >= 44, JSON.stringify(bar));
        await openEdit(1001);
        const ub = await page.evaluate(() => { const w = document.getElementById('recInputModeUndoWrap'), b = document.getElementById('recInputModeUndoBtn'); return { shown: !!w && getComputedStyle(w).display !== 'none', text: b ? b.textContent : '', h: b ? b.getBoundingClientRect().height : 0 }; });
        check('課題の編集画面に「直前の入力形式の変更を取り消す」ボタン(課題名つき・44px以上)が出る', ub.shown && /直前の入力形式の変更を取り消す/.test(ub.text) && /作文_運動会なりきり/.test(ub.text) && ub.h >= 44, JSON.stringify(ub));
        // 実際のタップで入力形式だけを取り消す → 名簿変更の取り消し点は残る
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#recInputModeUndoBtn')]);
        await sleep(1500);
        const d2 = await dump();
        check('入力形式の取り消し(実際のタップ): 課題は戻す前のまま・名簿の並べ替えは残る・名簿変更の取り消し点は不変', (await testInputMode(1001)) === undefined && (await masterName(1)) === '秘匿2氏' && d2[K.roster_txn] === rosterTxn0 && d2[K.roster_snapshot] === rosterSnap0 && d2[K.undo_imf_txn] === undefined && d2[K.undo_imf_snapshot] === undefined, '');
        check('入力形式の取り消しのあと、名簿変更の取り消しはまだできる', (await st('roster')).available, '');
        // 実際のタップで名簿変更を取り消す
        await page.evaluate(() => { showView('settings'); }); await sleep(400);
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#rosterUndoBtn')]);
        await sleep(1500);
        check('名簿変更の取り消し(実際のタップ): 名簿が変更前(秘匿1氏)に戻る', (await masterName(1)) === '秘匿1氏', String(await masterName(1)));

        // ============ 2. 入力形式の変更 → 名簿変更(逆の順) ============
        console.log('--- 2. 入力形式を直したあとに名簿変更 ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await fixIt(1001);
        const imfTxn0 = (await dump())[K.undo_imf_txn], imfSnap0 = (await dump())[K.undo_imf_snapshot];
        const r2 = await rename(2, '並べ替え二');
        const d3 = await dump();
        check('入力形式の取り消し点は、あとの名簿変更で上書きされず残る(1文字も変わらない)', r2.ok && d3[K.undo_imf_txn] === imfTxn0 && d3[K.undo_imf_snapshot] === imfSnap0, JSON.stringify(r2).slice(0, 80));
        check('両方の取り消しが有効(名簿変更は名簿の枠・入力形式は専用の枠)', (await st('roster')).available && (await st('input-mode-fix')).available && (await st('roster')).kind === 'apply', '');
        const u2 = await undo('roster');
        check('名簿変更だけを取り消せる(課題の入力形式の変更は残る)', u2.ok && (await masterName(2)) === '秘匿2氏' && (await masterName(3)) === '秘匿3氏' && (await testInputMode(1001)) === 'score', JSON.stringify(u2).slice(0, 80));
        check('名簿変更を取り消したあとも、入力形式の取り消しは有効', (await st('input-mode-fix')).available, '');
        const u3 = await undo('input-mode-fix');
        check('入力形式の変更を取り消せる(課題が戻す前に戻る)', u3.ok && (await testInputMode(1001)) === undefined, JSON.stringify(u3).slice(0, 80));
        // 古いほう(入力形式)を先に指定して取り消せる(「最後の変更」を勝手に取り消さない)
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await fixIt(1001); await rename(1, '並べ替え(あとから)');
        const older = await undo('input-mode-fix');
        check('あとから名簿変更をしていても、指定した枠(入力形式)だけを取り消す。名簿変更は取り消されない', older.ok && older.kind === 'input-mode-fix' && (await testInputMode(1001)) === undefined && (await masterName(1)) === '秘匿2氏' && (await st('roster')).available, JSON.stringify(older).slice(0, 80));
        // 入力形式を2回続けて直す: 同じ枠なので、1回目の取り消し点は2回目で置き換わる(同じ種類は1世代)
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await fixIt(1001); await fixIt(1002);
        const j2 = JSON.parse((await dump())[K.undo_imf_txn]);
        check('同じ種類(入力形式)の変更を続けると、取り消し点は最後の1つだけ(この枠の中では従来どおり1世代)', j2.name === '作文_遠足なりきり', j2.name);

        // ============ 3. バックアップの復元・入れ子の取り消し ============
        console.log('--- 3. バックアップの復元と名簿変更 ---');
        await seed([SAKU], saku1);
        const S0 = await dump();
        const backup = await page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
        const rr = await rename(3, '改名三');
        const rosterTxn3 = (await dump())[K.roster_txn], rosterSnap3 = (await dump())[K.roster_snapshot];
        const afterRename = await dump();
        const br = await page.evaluate((b) => window.brRestoreFromBackup(b), backup);
        const d4 = await dump();
        check('前提: バックアップの復元が成功し、復元の枠(spa_undo_backup_restore_*)に取り消し点ができる', rr.ok && br.ok && br.mode === 'snapshot' && !!d4[K.undo_br_txn] && JSON.parse(d4[K.undo_br_txn]).kind === 'backup-restore', JSON.stringify(br).slice(0, 120));
        check('バックアップの復元は、名簿変更の取り消し点(スナップショット・ジャーナル)を上書きしない(1文字も変わらない)', d4[K.roster_txn] === rosterTxn3 && d4[K.roster_snapshot] === rosterSnap3, '');
        check('復元でデータが変わったので、名簿変更の取り消しはいまは有効でない(変更後の入力があったのと同じ扱い)・復元の取り消しは有効', !(await st('roster')).available && (await st('backup-restore')).available, JSON.stringify([await st('roster'), await st('backup-restore')]));
        const ub2 = await undo('backup-restore');
        check('復元を取り消せる: 全キーが復元前(改名後)と1バイトも変わらない', ub2.ok && diffKeys(afterRename, await dump(), true).length === 0, diffKeys(afterRename, await dump(), true).join(','));
        check('復元を取り消すと、名簿変更の取り消しがまた有効になる(順番に取り消せる)', (await st('roster')).available, '');
        const ur2 = await undo('roster');
        check('続けて名簿変更も取り消せる: 全キーが最初の状態と1バイトも変わらない', ur2.ok && diffKeys(S0, await dump(), true).length === 0, diffKeys(S0, await dump(), true).join(','));

        // ============ 4. 新体力テストの引き継ぎ・記録の復元の枠(合成した取り消し点で、枠の独立を確認) ============
        console.log('--- 4. 種類ごとの枠の独立・表示 ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        const synth = await page.evaluate((SL) => {
            // 空のスナップショット(対象キーなし)の確定済みの取り消し点を、種類ごとに作る(実際の引き継ぎ・復元の実行は pf-takeover.test.js で検証している)
            const mk = (slot, kind, at) => { StorageManager.setImmediate(slot[0], JSON.stringify({ v: 1, txnId: kind, at: at, kind: kind, keys: {} })); StorageManager.setImmediate(slot[1], JSON.stringify({ id: kind, state: 'committed', at: at, kind: kind, hashes: {} })); };
            mk(SL.pft, 'pf-takeover', '2026-09-20T01:00:00.000Z');
            mk(SL.pfr, 'pf-restore', '2026-09-20T02:00:00.000Z');
            return true;
        }, SLOT);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);
        await page.evaluate(() => { showView('settings'); }); await sleep(400);
        const bar2 = await page.evaluate(() => Array.from(document.querySelectorAll('#rosterUndoBar button')).map(b => ({ id: b.id, slot: b.getAttribute('data-slot'), text: b.textContent })));
        check('設定の名簿カード: 取り消せる種類ごとに1つずつボタンが出る(引き継ぎ・記録の復元)。ボタンの id は重複しない', bar2.length === 2 && bar2.some(b => b.slot === 'pf-takeover' && /新体力テストの引き継ぎを取り消す/.test(b.text)) && bar2.some(b => b.slot === 'pf-restore' && /新体力テストの記録の復元を取り消す/.test(b.text)) && new Set(bar2.map(b => b.id)).size === 2, JSON.stringify(bar2));
        const pre4 = await dump();
        await rename(0, '改名零');
        const d5 = await dump();
        check('名簿変更(roster の枠の書き込み)は、引き継ぎ・記録の復元の取り消し点を上書きしない', d5[K.undo_pft_txn] === pre4[K.undo_pft_txn] && d5[K.undo_pfr_txn] === pre4[K.undo_pfr_txn] && d5[K.undo_pft_snapshot] === pre4[K.undo_pft_snapshot] && d5[K.undo_pfr_snapshot] === pre4[K.undo_pfr_snapshot], '');
        const f4 = await fixIt(1001);
        const d6 = await dump();
        check('入力形式の変更(専用の枠)も、引き継ぎ・記録の復元・名簿変更の取り消し点を上書きしない', f4.ok && d6[K.undo_pft_txn] === pre4[K.undo_pft_txn] && d6[K.undo_pfr_txn] === pre4[K.undo_pfr_txn] && d6[K.roster_txn] === d5[K.roster_txn] && d6[K.roster_snapshot] === d5[K.roster_snapshot], '');
        check('4つの枠が同時に有効(名簿変更・引き継ぎ・記録の復元・入力形式)', (await st('roster')).available && (await st('pf-takeover')).available && (await st('pf-restore')).available && (await st('input-mode-fix')).available, '');

        // ============ 5. 不要になった(もう取り消せない)枠は、次の変更の前に消えて容量を空ける ============
        console.log('--- 5. もう取り消せない枠の整理 ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await rename(1, '整理用');                 // 名簿の枠に全データの写しができる
        const withRosterSnap = (await dump())[K.roster_snapshot];
        await page.evaluate(() => { const t = JSON.parse(StorageManager.getRaw(KEYS.master)); t.students[4].name = '入力扱い'; StorageManager.setImmediate(KEYS.master, JSON.stringify(t)); }); // 名簿変更のあとにデータが変わった(もう取り消せない)
        check('前提: 名簿変更のあとにデータが変わったので、名簿変更はもう取り消せない(写しは残っている)', !(await st('roster')).available && !!withRosterSnap && !!(await dump())[K.roster_snapshot], '');
        const f5 = await fixIt(1001);
        const d7 = await dump();
        check('入力形式の変更の前に、もう取り消せない名簿の枠の写しが消される(容量を空ける)。入力形式の取り消しは有効', f5.ok && d7[K.roster_snapshot] === undefined && d7[K.roster_txn] === undefined && (await st('input-mode-fix')).available, '');
        // 有効な枠は消さない
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await rename(1, '有効な枠');
        await fixIt(1001);
        check('まだ取り消せる名簿の枠は、入力形式の変更でも消えない', (await st('roster')).available && !!(await dump())[K.roster_snapshot], '');

        // ============ 6. 旧版(共用の枠)からの引き継ぎ ============
        console.log('--- 6. 旧版の共用の枠に残っていた取り消し点 ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        // 旧版で入力形式を直した直後の状態を再現: 共用の枠(spa_roster_*)に kind=input-mode-fix の確定済みの取り消し点
        await page.evaluate(() => {
            const before = StorageManager.getRaw(KEYS.tests);
            const tests = JSON.parse(before); tests[0].inputMode = 'score';
            const after = JSON.stringify(tests);
            const snap = { v: 1, txnId: 'old1', at: '2026-09-19T00:00:00.000Z', kind: 'input-mode-fix', keys: {} }; snap.keys[KEYS.tests] = before;
            StorageManager.setImmediate(KEYS.tests, after);
            const h = {}; h[KEYS.tests] = srHash(after);
            StorageManager.setImmediate(KEYS.roster_snapshot, JSON.stringify(snap));
            StorageManager.setImmediate(KEYS.roster_txn, JSON.stringify({ id: 'old1', state: 'committed', at: '2026-09-19T00:00:00.000Z', kind: 'input-mode-fix', hashes: h }));
        });
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
        const d8 = await dump();
        check('起動時: 旧版の共用の枠にあった入力形式の取り消し点が、専用の枠へ移る(共用の枠は空になる)', !!d8[K.undo_imf_txn] && !!d8[K.undo_imf_snapshot] && d8[K.roster_txn] === undefined && d8[K.roster_snapshot] === undefined && JSON.parse(d8[K.undo_imf_txn]).kind === 'input-mode-fix', '');
        check('移した取り消し点で、入力形式の変更を取り消せる', (await st('input-mode-fix')).available && (await undo('input-mode-fix')).ok && (await testInputMode(1001)) === undefined, '');
        // 旧版の共用の枠の名簿変更(kind=apply)は、名簿の枠のまま
        await seed([SAKU], saku1);
        await rename(1, '旧版名簿');
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
        check('起動時: 名簿変更(kind=apply)の取り消し点は名簿の枠に残り、取り消せる', (await st('roster')).available && (await st('roster')).kind === 'apply', '');
        // 旧版で途中(applying)のまま終わった入力形式の変更: 起動時に元へ戻る(共用の枠のキーで復旧)
        await seed([SAKU], saku1);
        const midOld = await page.evaluate(() => {
            const before = StorageManager.getRaw(KEYS.tests);
            const snap = { v: 1, txnId: 'old2', at: '2026-09-19T00:00:00.000Z', kind: 'input-mode-fix', keys: {} }; snap.keys[KEYS.tests] = before;
            const tests = JSON.parse(before); tests[0].inputMode = 'score';
            StorageManager.setImmediate(KEYS.roster_snapshot, JSON.stringify(snap));
            StorageManager.setImmediate(KEYS.roster_txn, JSON.stringify({ id: 'old2', state: 'applying', at: '2026-09-19T00:00:00.000Z', kind: 'input-mode-fix', order: [KEYS.tests] }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            return before;
        });
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
        const d9 = await dump();
        check('起動時: 旧版で途中のまま終わった入力形式の変更は、変更前に戻り、枠が空になる', d9[K.tests] === midOld && d9[K.roster_txn] === undefined && d9[K.roster_snapshot] === undefined, '');

        // ============ 7. 起動時の自動復旧は枠ごと: 途中の枠だけ戻し、ほかの枠の取り消し点は残す ============
        console.log('--- 7. 起動時の復旧(枠ごと) ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await rename(1, '復旧前の名簿変更');
        const rosterTxn7 = (await dump())[K.roster_txn], rosterSnap7 = (await dump())[K.roster_snapshot];
        // 入力形式の変更が途中(applying)で強制終了した状態を作る(スナップショット・ジャーナルを書き、課題を書き換えたところで止まった)
        const before7 = await page.evaluate(() => {
            const before = StorageManager.getRaw(KEYS.tests);
            const snap = { v: 1, txnId: 'imf_x', at: '2026-09-20T03:00:00.000Z', kind: 'input-mode-fix', keys: {} }; snap.keys[KEYS.tests] = before;
            StorageManager.setImmediate(KEYS.undo_imf_snapshot, JSON.stringify(snap));
            StorageManager.setImmediate(KEYS.undo_imf_txn, JSON.stringify({ id: 'imf_x', state: 'applying', at: '2026-09-20T03:00:00.000Z', kind: 'input-mode-fix', order: [KEYS.tests] }));
            const tests = JSON.parse(before); tests[0].inputMode = 'score';
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            return before;
        });
        // 途中の状態では、ほかの変更は始められない(どの枠でも)
        const blocked = await page.evaluate(() => { const m = JSON.parse(StorageManager.getRaw(KEYS.master)); const ns = m.students.map(s => Object.assign({}, s)); ns[0].name = 'x'; return window.applyRosterChange(ns, { reload: false }); });
        check('どれかの枠が途中(applying)のあいだは、名簿変更を始められない(txn-pending)', blocked.ok === false && blocked.error === 'txn-pending', JSON.stringify(blocked).slice(0, 80));
        const blocked2 = await fixIt(1002);
        check('どれかの枠が途中のあいだは、入力形式の変更も始められない(txn-pending)', blocked2.ok === false && blocked2.error === 'txn-pending', JSON.stringify(blocked2).slice(0, 80));
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
        const d10 = await dump();
        check('起動時の復旧: 途中だった入力形式の変更だけが変更前に戻り、その枠は空になる', d10[K.tests] === before7 && d10[K.undo_imf_txn] === undefined && d10[K.undo_imf_snapshot] === undefined, '');
        check('起動時の復旧は、別の枠(名簿変更)の取り消し点に触れない(1文字も変わらず、まだ取り消せる)', d10[K.roster_txn] === rosterTxn7 && d10[K.roster_snapshot] === rosterSnap7 && (await st('roster')).available, '');

        // ============ 8. 失敗の注入: 入力形式の変更の途中で失敗しても、ほかの枠は無傷 ============
        console.log('--- 8. 失敗の注入 ---');
        const inject = (mode, at, keys) => page.evaluate((mode, at, keys) => {
            const set = new Set(keys), state = { n: 0 };
            const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
            window.__fault = { state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
            Storage.prototype.setItem = function(k, v) {
                if (mode === 'probe' && k === 'spa_capacity_probe') throw new DOMException('quota', 'QuotaExceededError');
                if (mode === 'snapshot' && k === 'spa_undo_input_mode_fix_snapshot') throw new DOMException('quota', 'QuotaExceededError');
                if (set.has(k) && (mode === 'quota' || mode === 'corrupt')) {
                    const i = state.n++;
                    if (mode === 'quota' && i === at) throw new DOMException('quota', 'QuotaExceededError');
                    if (mode === 'corrupt' && i === at) return oSet.call(this, k, String(v).slice(0, Math.max(0, String(v).length - 3)));
                }
                return oSet.apply(this, arguments);
            };
        }, mode, at, keys);
        const uninject = () => page.evaluate(() => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } });
        for (const [mode, label, keys] of [['probe', '容量確認の失敗', []], ['snapshot', 'スナップショットの書き込みの失敗', []], ['quota', '課題の書き込みの失敗', [K.tests]], ['corrupt', '課題の書き込みの内容破損', [K.tests]]]) {
            await seed([SAKU, SAKU2], saku1.concat(saku2));
            await rename(1, '注入前の名簿変更');
            await fixIt(1002);   // 入力形式の取り消し点(前の1つ)を作っておく
            const p0 = await dump();
            await inject(mode, 0, keys);
            const r = await fixIt(1001);
            await uninject();
            const p1 = await dump();
            const noTouch = diffKeys(p0, p1).length === 0;
            check(label + ': 変更は失敗し(ok:false)、全キーが1バイトも変わらない', r.ok === false && noTouch, JSON.stringify(r).slice(0, 90) + ' diff=' + diffKeys(p0, p1).join(','));
            check(label + ': 名簿変更の取り消し点と、直前の入力形式の取り消し点は壊れず、どちらもまだ取り消せる', (await st('roster')).available && (await st('input-mode-fix')).available && JSON.parse(p1[K.undo_imf_txn]).name === '作文_遠足なりきり', '');
        }
        // 名簿変更の途中の失敗でも、入力形式の取り消し点は無傷
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await fixIt(1001);
        const q0 = await dump();
        await inject('corrupt', 0, [K.master]);
        const rq = await rename(2, '失敗する名簿変更');
        await uninject();
        const q1 = await dump();
        check('名簿変更の途中で失敗しても: 全キーが変更前と1バイトも変わらず、入力形式の取り消し点(別の枠)は無傷でまだ取り消せる', rq.ok === false && diffKeys(q0, q1).length === 0 && (await st('input-mode-fix')).available, JSON.stringify(rq).slice(0, 90) + ' diff=' + diffKeys(q0, q1).join(','));

        // ============ 9. バックアップ・端末データ消去 ============
        console.log('--- 9. バックアップ・退勤モード ---');
        await seed([SAKU, SAKU2], saku1.concat(saku2));
        await rename(1, '書き出し確認'); await fixIt(1001);
        await page.evaluate((SL) => { const mk = (slot, kind) => { StorageManager.setImmediate(slot[0], JSON.stringify({ v: 1, keys: {} })); StorageManager.setImmediate(slot[1], JSON.stringify({ id: kind, state: 'committed', kind: kind, hashes: {} })); }; mk(SL.br, 'backup-restore'); mk(SL.pft, 'pf-takeover'); mk(SL.pfr, 'pf-restore'); }, SLOT);
        const ex = await page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
        check('バックアップの書き出し: すべての取り消しの枠(6種類のスナップショット・ジャーナル)を含めない', ALL_UNDO.every(k => ex.data[k] === undefined && ex.rawLocalStorage[k] === undefined), '');
        check('取り消しの枠のキーは、このアプリのキーとして扱われる(退勤モードの消去の対象)', await page.evaluate((keys) => keys.every(k => isClassroomOwnedKey(k)), ALL_UNDO), '');
        await page.evaluate(() => { window.wipeLocalData(); });
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        await sleep(800);
        const wiped = await dump();
        check('退勤モードの消去: すべての取り消しの枠が消える(氏名・記録の写しが端末に残らない)', ALL_UNDO.every(k => wiped[k] === undefined), ALL_UNDO.filter(k => wiped[k] !== undefined).join(','));
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== undo-slots: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
