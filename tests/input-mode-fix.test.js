// 記録と入力形式が食い違っている課題を、記録に合う形式へ戻す(v1.54.4。課題の編集画面の「記録に合わせて、…入力に戻す」ボタン)。
//   先生の iPad の課題「作文_運動会なりきり」(旧作文・満点5・数値の記録・判定上は5段階)と同じ条件を再現して確認する。
//   方針: 記録は変換しない・成績の値を変えない・戻せる方向は「記録に合う形式」だけ・確認ダイアログなし(戻したあとのトーストで取り消し)。
//   書くのは課題(spa_tests)だけ。名簿変更と同じ仕組み(スナップショット・ジャーナル・検証付き書き込み・失敗時ロールバック・起動時の自動復旧・取り消し)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node input-mode-fix.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    let dialogs = 0;
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1 && !/crash|quota|verify failed/.test(t)) consoleErrors.push(t); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const INFRA = [K.roster_snapshot, K.roster_txn];

    const N = 27;
    const names = Array.from({ length: N }, (_, i) => '秘匿' + i + '氏');
    const T = (o) => Object.assign({ subject: '国語', testType: '小テスト', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-01' }, o);
    const S = (id, testId, idx, score, extra) => Object.assign({ id: id, studentIndex: idx, testId: testId, score: score }, extra || {});
    async function seed(tests, scores) {
        await page.evaluate((tests, scores, names) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear(); window.__pendingIdbDeletes = [];
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: names.map((n, i) => ({ name: n, studentId: 'stu_imf0000' + String(i).padStart(2, '0') })), classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
        }, tests, scores, names);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (a, b, infra) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(k => !NOISE.test(k) && (!infra || INFRA.indexOf(k) === -1) && a[k] !== b[k]);
    const grades = (subject) => page.evaluate((s) => JSON.stringify(grdCalculate(s, 'all')), subject);
    // 課題の1項目の換算(10点)を児童ごとに(成績計算の結果から)取り出す
    const itemScores = (subject, name) => page.evaluate((s, n) => { const walk = (o, acc) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) { o.forEach(x => walk(x, acc)); return; } if ('score10' in o && o.name === n) acc.push(o.score10); Object.keys(o).forEach(k => walk(o[k], acc)); }; return grdCalculate(s, 'all').map(r => { const a = []; walk(r, a); return a[0] === undefined ? '-' : a[0]; }); }, subject, name);
    const toastHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 2500, polling: 50 }, t).then(() => true).catch(() => false);
    const diagnose = async () => {
        await page.evaluate(() => { showView('export'); runAuditDiagnosis(); });
        await sleep(700);
        return page.evaluate(() => { const r = window._auditDiagnosisLastResult, si = r.structuralIntegrity; return { count: si.inputModeConflicts, detail: si.inputModeConflictDetail, affected: si.inputModeConflictAffectedStudents, lines: Array.from(document.querySelectorAll('#audit-result-container [data-imc-guide]')).map(e => ({ guide: e.getAttribute('data-imc-guide'), text: e.textContent })) }; });
    };
    // 入力画面で課題を選び、「この課題を編集」を実際にタップして編集画面を開く
    const openEdit = async (id) => {
        await page.evaluate((id) => { showView('records'); recShowSub('input'); recSelectTestGoto(id); }, id);
        await sleep(200);
        await page.click('#recEditThisTestBtn');
        await sleep(300);
    };
    const formState = () => page.evaluate(() => ({ fixVisible: getComputedStyle(document.getElementById('recInputModeFixWrap')).display !== 'none', fixText: document.getElementById('recInputModeFixText').textContent, fixBtn: document.getElementById('recInputModeFixBtn').textContent, fixBtnH: Math.round(document.getElementById('recInputModeFixBtn').getBoundingClientRect().height), scoreBtnDisabled: document.getElementById('recInputModeScoreBtn').disabled, abcBtnDisabled: document.getElementById('recInputModeAbc5Btn').disabled, maxDisabled: document.getElementById('recTestMaxScore').disabled, maxValue: document.getElementById('recTestMaxScore').value }));
    const testOf = (id) => page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(t => t.id === id), id);
    const fix = (id, mx) => page.evaluate((id, mx) => window.recFixInputMode(id, mx), id, mx);
    const fault = (mode, at, keys) => page.evaluate((mode, at, keys) => {
        const set = new Set(keys), state = { n: 0 };
        const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
        window.__fault = { state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
        Storage.prototype.setItem = function(k, v) {
            if (mode === 'probe' && k === 'spa_capacity_probe') throw new DOMException('quota', 'QuotaExceededError');
            if (mode === 'snapshot' && k === 'spa_roster_snapshot') throw new DOMException('quota', 'QuotaExceededError');
            if (set.has(k) && (mode === 'quota' || mode === 'corrupt' || mode === 'crash')) {
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

    // 先生の iPad の課題と同じ条件: 旧作文(印なし)・満点5・数値の記録27件(全員)・遅れて提出1件・思考・判断・表現
    const SAKUBUN = T({ id: 1779255384269, name: '作文_運動会なりきり', testType: '作文', category: '思考・判断・表現', maxScore: 5, date: '2026-05-20' });
    const sakubunScores = Array.from({ length: N }, (_, i) => S(100 + i, SAKUBUN.id, i, 1 + (i % 5), i === 7 ? { lateSubmit: true } : {}));
    const CONTROL = T({ id: 2, name: '対照-知識-満点10', maxScore: 10, inputMode: 'score' });
    const controlScores = [S(300, 2, 0, 8), S(301, 2, 1, 6)];

    try {
        // ================= 1. 作文(先生のiPadと同じ条件)を点数入力に戻す =================
        console.log('--- 1. 旧作文(満点5・数値27件・遅れて提出1件)を点数入力に戻す ---');
        await seed([SAKUBUN, CONTROL], sakubunScores.concat(controlScores));
        const d0 = await diagnose();
        const it0 = (d0.detail || []).find(x => x.testId === SAKUBUN.id) || {};
        check('前提: 診断に「5段階なのに満点あり」で出て、案内は「記録に合わせて、得点入力に戻す」・成績への影響は0人(遅れて提出を含め正しく計算されている)', it0.kind === 'abc5' && it0.guide === 'switch-score' && it0.gradeAffectedStudents === 0 && d0.lines.some(l => l.guide === 'switch-score' && /得点入力に戻す/.test(l.text) && /取り消せます/.test(l.text)), JSON.stringify(it0));
        const gradesBefore = await grades('国語');
        const itemBefore = await itemScores('国語', SAKUBUN.name);
        const pre = await dump();
        await openEdit(SAKUBUN.id);
        let fs = await formState();
        check('編集画面: 入力形式のタブは両方とも押せない(固定のまま)・固定の理由も表示される', fs.scoreBtnDisabled === true && fs.abcBtnDisabled === true && await page.evaluate(() => getComputedStyle(document.getElementById('recInputModeLockNote')).display !== 'none'), JSON.stringify(fs));
        check('編集画面: 「記録（数値の点数）に合わせて、得点入力に戻す」ボタンが出る(44px以上)・説明に「記録は変換せず…取り消せます」', fs.fixVisible && /得点入力に戻す/.test(fs.fixBtn) && fs.fixBtnH >= 44 && /記録は変換せず/.test(fs.fixText) && /取り消せます/.test(fs.fixText), JSON.stringify(fs));
        check('編集画面: 保存済みの満点(5)が満点欄に表示され、満点を入れ直さなくてよい', fs.maxDisabled === false && fs.maxValue === '5' && !/先に満点を入力/.test(fs.fixText), JSON.stringify(fs));
        await page.click('#recInputModeFixBtn');
        check('戻したあと: 「入力に戻しました（記録は変えていません）」のトーストに「元に戻す」が付く(確認ダイアログは使わない)', await toastHas('得点入力に戻しました') && await page.evaluate(() => document.getElementById('toastUndoBtn').style.display !== 'none'), '');
        const post = await dump();
        const t1 = await testOf(SAKUBUN.id);
        check('課題: 入力形式が得点(印 inputMode=score)になり、満点は5のまま', t1.inputMode === 'score' && t1.maxScore === 5 && t1.testType === '作文' && t1.category === '思考・判断・表現', JSON.stringify(t1));
        check('記録(spa_scores)は1バイトも変わらない(変換しない)', post[K.scores] === pre[K.scores], '');
        check('全キー比較: 変わったのは課題(spa_tests)と、取り消し用のスナップショット・ジャーナルだけ(名簿・記録・別アプリ等は不変)', JSON.stringify(diffKeys(pre, post).sort()) === JSON.stringify([K.tests, K.roster_snapshot, K.roster_txn].sort()), diffKeys(pre, post).join(','));
        check('課題のほかの項目・ほかの課題は変わらない(対照の課題が同一・作文は inputMode だけの差)', (() => { const a = JSON.parse(pre[K.tests]), b = JSON.parse(post[K.tests]); return JSON.stringify(a[1]) === JSON.stringify(b[1]) && JSON.stringify(Object.assign({}, a[0], { inputMode: 'score' })) === JSON.stringify(b[0]); })(), '');
        const gradesAfter = await grades('国語'), itemAfter = await itemScores('国語', SAKUBUN.name);
        check('成績処理統合の値が、戻す前後で完全に同じ(27名分・遅れて提出1件を含む。成績の全結果が一致)', gradesBefore === gradesAfter && JSON.stringify(itemBefore) === JSON.stringify(itemAfter) && itemBefore.filter(x => typeof x === 'number').length === N, JSON.stringify(itemBefore.slice(0, 8)) + ' / ' + JSON.stringify(itemAfter.slice(0, 8)));
        check('遅れの印つきの児童(8番目)は、戻す前後とも0.8倍されない(3点→6.0点。v1.56.0: 児童の記録の遅れは点数に使わない。印は残る)', itemAfter[7] === 6 && itemBefore[7] === 6, String(itemAfter[7]));
        await page.evaluate((id) => { showView('records'); recShowSub('input'); recSelectTestGoto(id); }, SAKUBUN.id); await sleep(300);
        const inp = await page.evaluate(() => ({ v0: document.getElementById('rec-sc-0') && document.getElementById('rec-sc-0').value, v1: document.getElementById('rec-sc-1') && document.getElementById('rec-sc-1').value, max: document.getElementById('rec-sc-0') && document.getElementById('rec-sc-0').getAttribute('max'), abc: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length }));
        check('入力画面: 点数入力に戻り(満点5)、入力済みの点数(1・2…)が見える', inp.v0 === '1' && inp.v1 === '2' && inp.max === '5' && inp.abc === 0, JSON.stringify(inp));
        const d1 = await diagnose();
        check('診断: この課題が矛盾一覧から消える', !(d1.detail || []).some(x => x.testId === SAKUBUN.id) && d1.count === 0, JSON.stringify(d1.detail && d1.detail.map(x => x.name)));
        await openEdit(SAKUBUN.id);
        check('編集画面を開き直すと、ボタンは出ない(食い違いがなくなったため)', (await formState()).fixVisible === false, '');
        await page.evaluate(() => { showView('settings'); }); await sleep(400);
        check('設定の名簿カードの取り消しボタンは「直前の入力形式の変更を取り消す」', await page.evaluate(() => { const b = document.getElementById('rosterUndoBtn'); return !!b && b.textContent.indexOf('入力形式の変更を取り消す') !== -1; }), '');
        // 取り消し(実際のタップ): 戻す前の状態に1バイトも変わらず戻る
        await openEdit(SAKUBUN.id);
        await page.evaluate(() => { showView('settings'); }); await sleep(300);
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#rosterUndoBtn')]);
        check('取り消し(実際のタップ): 再読み込み後に「入力形式の変更を取り消しました」と表示される', await toastHas('入力形式の変更を取り消しました', 4000), '');
        await sleep(1500);
        const undone = await dump();
        check('取り消し後: 課題・記録を含む全キーが、戻す前と1バイトも変わらない(スナップショット・ジャーナルも残らない)', diffKeys(pre, undone).length === 0 && undone[K.roster_snapshot] === undefined && undone[K.roster_txn] === undefined, diffKeys(pre, undone).join(','));
        check('取り消し後: 成績の値も戻す前と同じ', (await grades('国語')) === gradesBefore, '');

        // 「元に戻す」トーストの実際のタップ(戻した直後の8秒以内)
        await openEdit(SAKUBUN.id);
        await page.click('#recInputModeFixBtn');
        await toastHas('得点入力に戻しました');
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#toastUndoBtn')]);
        await sleep(1800);
        check('トーストの「元に戻す」(実際のタップ)でも、全キーが戻す前と同じになる', diffKeys(pre, await dump()).length === 0, diffKeys(pre, await dump()).join(','));

        // ================= 2. 成績の値の変化(主体性: 数値が5段階として読めず成績から外れていた課題) =================
        console.log('--- 2. 主体性(満点あり・数値の記録)は、戻すと成績に正しく入る ---');
        const ATT = T({ id: 5, name: '主体性-旧-満点20', category: '主体性', maxScore: 20 });
        const attScores = [S(1, 5, 0, 16), S(2, 5, 1, 10), S(3, 5, 2, 20)];
        await seed([ATT, CONTROL], attScores.concat(controlScores));
        const dA = await diagnose();
        const itA = (dA.detail || []).find(x => x.testId === 5) || {};
        const gA0 = await grades('国語'), iA0 = await itemScores('国語', ATT.name);
        await openEdit(5);
        await page.click('#recInputModeFixBtn'); await toastHas('得点入力に戻しました');
        const gA1 = await grades('国語'), iA1 = await itemScores('国語', ATT.name);
        const changed = iA0.map((v, i) => JSON.stringify(v) !== JSON.stringify(iA1[i]) ? i : -1).filter(i => i >= 0);
        check('主体性(旧・満点20・数値): 戻す前は5段階として読めず成績から外れていた(null)が、戻すと記録の数値のまま換算される(16/20→8・10/20→5・20/20→10)', iA0.slice(0, 3).every(v => v === null) && JSON.stringify(iA1.slice(0, 3)) === JSON.stringify([8, 5, 10]), JSON.stringify([iA0.slice(0, 3), iA1.slice(0, 3)]));
        check('診断が予告した「成績に正しく入っていない児童」の人数と、戻して成績が変わった児童の人数が一致する(記録のある3人)', itA.gradeAffectedStudents === 3 && changed.length === 3 && gA0 !== gA1, JSON.stringify({ affected: itA.gradeAffectedStudents, changed: changed }));
        check('記録のない児童・ほかの課題の換算は変わらない', iA0.slice(3).every((v, i) => JSON.stringify(v) === JSON.stringify(iA1[i + 3])), '');

        // ================= 3. 得点方式なのに文字の記録 → 5段階に戻す =================
        console.log('--- 3. 得点方式で文字の記録 → 5段階入力に戻す ---');
        const LET = T({ id: 6, name: '思考-印あり-満点20-文字', category: '思考・判断・表現', maxScore: 20, inputMode: 'score' });
        const letScores = [S(1, 6, 0, 'A'), S(2, 6, 1, 'B'), S(3, 6, 2, 'C', { lateSubmit: true })];
        await seed([LET, CONTROL], letScores.concat(controlScores));
        const dL = await diagnose();
        check('前提: 診断に scorestr(得点方式なのに文字の記録)で出て、案内は「5段階入力に戻す」', (dL.detail || []).some(x => x.testId === 6 && x.kind === 'scorestr' && x.guide === 'switch-abc5') && dL.lines.some(l => l.guide === 'switch-abc5' && /5段階入力に戻す/.test(l.text)), JSON.stringify(dL.detail));
        const preL = await dump(), gL0 = await grades('国語');
        await openEdit(6);
        fs = await formState();
        check('編集画面: 「記録（A・B・C…）に合わせて、5段階入力に戻す」ボタンが出る・タブは固定のまま', fs.fixVisible && /5段階入力に戻す/.test(fs.fixBtn) && fs.scoreBtnDisabled && fs.abcBtnDisabled, JSON.stringify(fs));
        await page.click('#recInputModeFixBtn'); await toastHas('5段階入力に戻しました');
        const tL = await testOf(6), postL = await dump();
        check('課題: 5段階(印 inputMode=abc5)・満点0になり、記録は1バイトも変わらない', tL.inputMode === 'abc5' && tL.maxScore === 0 && postL[K.scores] === preL[K.scores], JSON.stringify(tL));
        const noMax = (j) => JSON.stringify(JSON.parse(j), (k, v) => k === 'max' ? undefined : v);
        check('成績処理統合の値(換算・評定・合計)は、戻す前後で同じ(思考・判断・表現は文字を5段階として計算するため。遅れて提出の係数も同じ。表示用の「満点」の欄だけが20→0になる)', noMax(gL0) === noMax(await grades('国語')) && gL0 !== await grades('国語'), '');
        await page.evaluate((id) => { showView('records'); recShowSub('input'); recSelectTestGoto(id); }, 6); await sleep(300);
        check('入力画面: 5段階のボタンになり、入力済みの文字(A・B・C)が選択状態で見える', await page.evaluate(() => document.querySelectorAll('#rec-row-0 .rec-abc-btn').length === 5 && document.querySelector('#rec-row-0 .rec-abc-btn.sel-a') !== null), '');
        check('診断から消える', !((await diagnose()).detail || []).some(x => x.testId === 6), '');

        // ================= 4. 満点が無い場合(5段階・満点0・数値の記録): 満点を入れて戻す =================
        console.log('--- 4. 満点なし: 満点を入れてから戻す ---');
        const NOMAX = T({ id: 7, name: '主体性-旧-満点0', category: '主体性', maxScore: 0 });
        await seed([NOMAX, CONTROL], [S(1, 7, 0, 13), S(2, 7, 1, 9)].concat(controlScores));
        await openEdit(7);
        fs = await formState();
        check('満点が無い課題: 説明に「先に満点を入力してください」・満点欄が使える(空欄)', fs.fixVisible && /先に満点を入力/.test(fs.fixText) && fs.maxDisabled === false && fs.maxValue === '', JSON.stringify(fs));
        const preN = await dump();
        await page.click('#recInputModeFixBtn');
        check('満点を入れずに押すと「先に満点を入力してください」と出て、何も変わらない(全キー不変)', await toastHas('先に満点を入力') && diffKeys(preN, await dump()).length === 0, '');
        await page.click('#recTestMaxScore'); await page.keyboard.type('15');
        await page.click('#recInputModeFixBtn'); await toastHas('得点入力に戻しました');
        const tN = await testOf(7);
        check('満点15を入れて押すと、得点(inputMode=score)・満点15で保存され、割合が出る(13/15)', tN.inputMode === 'score' && tN.maxScore === 15, JSON.stringify(tN));
        check('診断から消える', !((await diagnose()).detail || []).some(x => x.testId === 7), '');

        // ================= 5. 戻せない状態・方向の制限 =================
        console.log('--- 5. 戻せない状態・方向の制限 ---');
        const MIX = T({ id: 8, name: '混在-数値と文字', category: '主体性', maxScore: 0 });
        const OKS = T({ id: 9, name: '正常-得点-数値', maxScore: 20, inputMode: 'score' });
        const OKA = T({ id: 10, name: '正常-5段階-文字', category: '主体性', maxScore: 0, inputMode: 'abc5' });
        const EMPTY = T({ id: 11, name: '記録なし', category: '主体性', maxScore: 0 });
        const BAD = T({ id: 12, name: '有効でない文字', category: '主体性', maxScore: 0 });
        await seed([MIX, OKS, OKA, EMPTY, BAD, CONTROL], [S(1, 8, 0, 13), S(2, 8, 1, 'A'), S(3, 9, 0, 15), S(4, 10, 0, 'B'), S(5, 12, 0, 'X'), S(6, 12, 1, 'A')].concat(controlScores));
        const pre5 = await dump();
        check('数値と文字が混在する課題: 戻せない(nothing-to-fix)・全キー不変', (await fix(8)).error === 'nothing-to-fix' && diffKeys(pre5, await dump()).length === 0, '');
        check('有効でない文字(X)が混じる課題: 戻せない(記録が5段階として読めないため)', (await fix(12)).error === 'nothing-to-fix', '');
        check('方向の制限: 記録が数値で得点方式の課題(食い違いなし)を5段階に変える操作は存在しない(nothing-to-fix・全キー不変)', (await fix(9)).error === 'nothing-to-fix' && diffKeys(pre5, await dump()).length === 0, '');
        check('方向の制限: 記録が文字で5段階の課題(食い違いなし)を得点に変える操作は存在しない(nothing-to-fix)', (await fix(10)).error === 'nothing-to-fix', '');
        check('記録のない課題・存在しない課題: nothing-to-fix / not-found', (await fix(11)).error === 'nothing-to-fix' && (await fix(999)).error === 'not-found', '');
        await openEdit(8); fs = await formState();
        check('混在する課題の編集画面: ボタンは出ず、タブも固定のまま(勝手に形式を変えられない)', fs.fixVisible === false && fs.scoreBtnDisabled && fs.abcBtnDisabled, JSON.stringify(fs));
        await openEdit(9); fs = await formState();
        check('食い違いのない課題(得点・数値)の編集画面: ボタンは出ない', fs.fixVisible === false, '');
        await openEdit(11); fs = await formState();
        check('記録のない課題の編集画面: ボタンは出ず、タブは固定されない(自由に切り替えられる)', fs.fixVisible === false && fs.scoreBtnDisabled === false && fs.abcBtnDisabled === false, JSON.stringify(fs));

        // ================= 6. 失敗注入・ロールバック・起動時の自動復旧 =================
        console.log('--- 6. 失敗注入 ---');
        for (const [mode, label] of [['quota', '容量超過'], ['corrupt', '内容の破損(読み戻しの不一致)'], ['crash', '強制終了(ロールバックも失敗→起動時の自動復旧)']]) {
            await seed([SAKUBUN, CONTROL], sakubunScores.concat(controlScores));
            const p0 = await dump();
            await fault(mode, 0, [K.tests]);
            const r = await fix(SAKUBUN.id);
            await unfault();
            if (mode === 'crash') await page.evaluate(() => window.recoverRosterTxnOnStartup());
            const p1 = await dump();
            const shape = mode === 'crash' ? (r.ok === false) : (r.ok === false && r.rolledBack === true);
            check(label + ' を課題の書き込みで注入: 元に戻り、全キーが変更前と1バイトも変わらない(スナップショット・ジャーナルも残らない)', shape && diffKeys(p0, p1).length === 0 && p1[K.roster_txn] === undefined && p1[K.roster_snapshot] === undefined, JSON.stringify(r).slice(0, 100) + ' ' + diffKeys(p0, p1).join(','));
        }
        for (const [mode, label, code] of [['probe', '容量確認が失敗', 'insufficient-storage'], ['snapshot', 'スナップショットが書けない', 'snapshot-failed']]) {
            await seed([SAKUBUN, CONTROL], sakubunScores.concat(controlScores));
            const p0 = await dump();
            await fault(mode, 0, []);
            const r = await fix(SAKUBUN.id);
            await unfault();
            check(label + ': 何も書かずに中止(' + code + ')・全キー不変・課題は元のまま', r.ok === false && r.error === code && diffKeys(p0, await dump()).length === 0, JSON.stringify(r));
        }
        // 実際の画面でも: 失敗したらトーストで知らせ、データは変わらない
        await seed([SAKUBUN, CONTROL], sakubunScores.concat(controlScores));
        const p2 = await dump();
        await openEdit(SAKUBUN.id);
        await fault('quota', 0, [K.tests]);
        await page.click('#recInputModeFixBtn');
        const failToast = await toastHas('変更を取り消して元に戻しました', 2500);
        await unfault();
        check('画面: 保存に失敗したら「変更を取り消して元に戻しました（データは変更されていません）」と表示され、全キーは変わらない', failToast && diffKeys(p2, await dump()).length === 0, '');
        // 取り消しの拒否: 戻したあとに課題を変更した
        await seed([SAKUBUN, CONTROL], sakubunScores.concat(controlScores));
        await fix(SAKUBUN.id);
        await page.evaluate(() => { const t = StorageManager.get(KEYS.tests, []); t.push({ id: 99, subject: '算数', testType: '小テスト', name: '後から追加', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-06-02' }); StorageManager.setImmediate(KEYS.tests, JSON.stringify(t)); });
        const ur = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('戻したあとに課題が変更されていたら取り消さない(専用の文言)・変更は残る', ur.ok === false && ur.error === 'changed-since' && await toastHas('入力形式を直したあとに課題の変更があった') && (await testOf(99)) !== undefined, JSON.stringify(ur).slice(0, 100));
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { if (window.__fault) { window.__fault.restore(); window.__fault = null; } StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし(注入した意図的なエラーを除く)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== input-mode-fix: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
