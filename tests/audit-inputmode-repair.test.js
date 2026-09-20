// H7 の診断(設定 > 診断を実行「入力形式と満点が矛盾する課題」)の拡張(v1.54.2)。読み取り専用のまま・自動修正はしない。
//   1. 検出: 既存の2種類(得点方式で満点なし／5段階で満点あり)が、入力形式の印のない旧課題でも、判定上の入力形式で検出される。
//            新しい種類: 印のない旧課題で、判定上は5段階なのに、5段階として有効な値以外(数値の点数など)が入っているもの。
//   2. 成績への影響: 上の状態の記録が成績処理統合(grdItemScore10。カルテ・出力の成績も同じ計算)で正しく入っているかを、影響を受ける児童数(氏名なし)で表示する。
//   3. 直し方: 検出された各状態について、先生が画面操作(この課題を編集→満点を入れる/そのまま保存)だけで直せるかを、実際のクリック・入力で確認し、
//      直せる状態には一行の案内を出す。直せない状態(記録の型と入力形式が食い違い、入力形式が固定されている)は、その旨を出す。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-inputmode-repair.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NAMES = ['秘匿甲氏', '秘匿乙氏', '秘匿丙氏', '秘匿丁氏'];

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const backup = await page.evaluate(() => [StorageManager.getRaw(KEYS.master), StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores), StorageManager.getRaw(KEYS.grade_weights)]);

    const T = (o) => Object.assign({ subject: '国語', testType: '小テスト', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-01' }, o);
    const S = (id, testId, idx, score, extra) => Object.assign({ id: id, studentIndex: idx, testId: testId, score: score }, extra || {});
    async function seed(tests, scores, weights) {
        await page.evaluate((tests, scores, weights, names) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: names.map((n, i) => ({ name: n, studentId: 'stu_imc0000' + i })), classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            if (weights) StorageManager.setImmediate(KEYS.grade_weights, JSON.stringify(weights)); else StorageManager.remove(KEYS.grade_weights);
        }, tests, scores, weights || null, NAMES);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
    }
    const diagnose = async () => {
        await page.evaluate(() => { window.__clip = null; try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {} showView('settings'); runAuditDiagnosis(); });
        await sleep(600);
        return page.evaluate(() => { const r = window._auditDiagnosisLastResult, si = r && r.structuralIntegrity; return { count: si.inputModeConflicts, affected: si.inputModeConflictAffectedStudents, detail: si.inputModeConflictDetail, warn: r.anomalies.warn, html: (document.getElementById('audit-result-container') || {}).innerText || '', lines: Array.from(document.querySelectorAll('#audit-result-container [data-imc-guide]')).map(e => ({ guide: e.getAttribute('data-imc-guide'), text: e.textContent })) }; });
    };
    const byName = (o, name) => (o.detail || []).find(d => d.name === name) || null;

    try {
        // ================= 1・2. 検出と成績への影響 =================
        console.log('--- 1・2. 検出と成績への影響 ---');
        const tests = [
            T({ id: 1, name: 'L1旧-知識-満点0-数値', maxScore: 0 }),
            T({ id: 2, name: 'L2旧-主体性-満点20-数値13', category: '主体性', maxScore: 20 }),
            T({ id: 3, name: 'L3旧-主体性-満点20-A', category: '主体性', maxScore: 20 }),
            T({ id: 4, name: 'L4旧-主体性-満点0-数値13', category: '主体性', maxScore: 0 }),
            T({ id: 5, name: 'L5旧-主体性-満点0-数値2', category: '主体性', maxScore: 0 }),
            T({ id: 6, name: 'L6旧-知識-記述-満点0-数値13', testType: '記述問題', maxScore: 0 }),
            T({ id: 7, name: 'L7旧-思考-作文-満点0-数値13', category: '思考・判断・表現', testType: '作文', maxScore: 0 }),
            T({ id: 8, name: 'L8旧-知識-記述-満点20-数値13', testType: '記述問題', maxScore: 20 }),
            T({ id: 9, name: 'L9旧-主体性-満点0-数値13-重み0', category: '主体性', maxScore: 0 }),
            T({ id: 10, name: 'L10旧-主体性-満点0-X', category: '主体性', maxScore: 0 }),
            T({ id: 11, name: '正常-旧5段階-A', category: '主体性', maxScore: 0 }),
            T({ id: 12, name: '正常-旧振り返り-満点5-数値', testType: '振り返り', category: '思考・判断・表現', maxScore: 5 }),
            T({ id: 13, name: 'F1印あり-score-満点0-A', category: '主体性', maxScore: 0, inputMode: 'score' }),
            T({ id: 14, name: 'F2印あり-abc5-満点30-数値', maxScore: 30, inputMode: 'abc5' }),
            T({ id: 15, name: 'F5印あり-abc5-満点0-数値', category: '主体性', maxScore: 0, inputMode: 'abc5' }),
            T({ id: 16, name: 'L11旧-主体性-満点0-欠席のみ', category: '主体性', maxScore: 0 })
        ];
        const scores = [
            S(1, 1, 0, 13), S(2, 1, 1, 8),
            S(3, 2, 0, 13), S(4, 2, 1, 9),
            S(5, 3, 0, 'A'), S(6, 3, 1, 'B'),
            S(7, 4, 0, 13), S(8, 4, 1, 12), S(9, 4, 2, 11),
            S(10, 5, 2, 2),
            S(11, 6, 0, 13), S(12, 6, 3, 9),
            S(13, 7, 3, 13),
            S(14, 8, 0, 13),
            S(15, 9, 0, 13),
            S(16, 10, 1, 'X'),
            S(17, 11, 0, 'A'), S(18, 11, 1, 'B-'),
            S(19, 12, 0, 4),
            S(20, 13, 0, 'A'),
            S(21, 14, 0, 25),
            S(22, 15, 0, 13),
            S(23, 16, 0, 13, { absent: true }), S(24, 16, 1, '')
        ];
        await seed(tests, scores, { '国語': { attitude: { 'a_9': 0 } } });
        const before = await page.evaluate(() => [StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores), StorageManager.getRaw(KEYS.master)]);
        const d = await diagnose();
        const names = (d.detail || []).map(x => x.name).sort();
        const expectListed = ['L1旧-知識-満点0-数値', 'L2旧-主体性-満点20-数値13', 'L3旧-主体性-満点20-A', 'L4旧-主体性-満点0-数値13', 'L5旧-主体性-満点0-数値2', 'L6旧-知識-記述-満点0-数値13', 'L7旧-思考-作文-満点0-数値13', 'L8旧-知識-記述-満点20-数値13', 'L9旧-主体性-満点0-数値13-重み0', 'L10旧-主体性-満点0-X', 'F1印あり-score-満点0-A', 'F2印あり-abc5-満点30-数値', 'F5印あり-abc5-満点0-数値'].sort();
        check('検出: 矛盾する13件だけが一覧に出る(正常な旧5段階・旧振り返り・欠席のみ・空欄のみは出ない)', JSON.stringify(names) === JSON.stringify(expectListed) && d.count === 13, 'count=' + d.count + ' ' + JSON.stringify(names));
        const L = (n) => byName(d, n) || {};
        check('既存の種類(印のない旧課題): 知識・技能で満点0 → 「得点方式なのに満点なし」(判定上の入力形式で検出)', L('L1旧-知識-満点0-数値').kind === 'score' && L('L1旧-知識-満点0-数値').inputMode === '(未設定・観点から推定)', JSON.stringify(L('L1旧-知識-満点0-数値')));
        check('既存の種類(印のない旧課題): 主体性で満点20 → 「5段階なのに満点あり」', L('L3旧-主体性-満点20-A').kind === 'abc5' && L('L2旧-主体性-満点20-数値13').kind === 'abc5', '');
        check('新しい種類(印のない旧課題・満点0・数値の点数): kind=abc5num で検出される(主体性・記述問題・作文・有効でない文字)', ['L4旧-主体性-満点0-数値13', 'L5旧-主体性-満点0-数値2', 'L6旧-知識-記述-満点0-数値13', 'L7旧-思考-作文-満点0-数値13', 'L10旧-主体性-満点0-X', 'L9旧-主体性-満点0-数値13-重み0'].every(n => L(n).kind === 'abc5num'), '');
        check('5段階として有効な値(A/B-など)だけの旧5段階は出ない・数値でも満点あり(振り返り)で得点方式なら出ない', names.indexOf('正常-旧5段階-A') === -1 && names.indexOf('正常-旧振り返り-満点5-数値') === -1, '');
        check('入力形式の印がある課題も、同じ矛盾(5段階・満点なしで数値の記録)なら新しい種類(abc5num)で検出される(画面操作で固定された状態を見逃さない)', L('F5印あり-abc5-満点0-数値').kind === 'abc5num' && L('F5印あり-abc5-満点0-数値').gradeAffectedStudents === 1, JSON.stringify(L('F5印あり-abc5-満点0-数値')));
        check('無効な値の件数: 数値と、有効でない文字(X)を数える', L('L4旧-主体性-満点0-数値13').invalid5Scores === 3 && L('L10旧-主体性-満点0-X').invalid5Scores === 1 && L('L3旧-主体性-満点20-A').invalid5Scores === 0, JSON.stringify([L('L4旧-主体性-満点0-数値13').invalid5Scores, L('L10旧-主体性-満点0-X').invalid5Scores]));
        // 成績への影響(grdItemScore10 と同じ計算で確認。氏名なし・児童の数だけ)
        check('成績への影響: 主体性(満点20)の数値13・9 → 5段階として読めず成績に入らない → 影響2人', L('L2旧-主体性-満点20-数値13').gradeAffectedStudents === 2, JSON.stringify(L('L2旧-主体性-満点20-数値13')));
        check('成績への影響: 主体性(満点0)の数値13・12・11 → 3人 / 数値2 → 誤って「7点」に換算されるため1人', L('L4旧-主体性-満点0-数値13').gradeAffectedStudents === 3 && L('L5旧-主体性-満点0-数値2').gradeAffectedStudents === 1, '');
        check('成績への影響: 知識・技能の記述問題(満点0)は満点100点として換算され低く出る → 2人 / 思考・判断・表現(満点0)は成績に入らない → 1人', L('L6旧-知識-記述-満点0-数値13').gradeAffectedStudents === 2 && L('L7旧-思考-作文-満点0-数値13').gradeAffectedStudents === 1, '');
        check('成績への影響: 知識・技能の記述問題(満点20)は数値の点数のまま正しく計算される → 影響0人(「成績の値は変わりません」と表示)', L('L8旧-知識-記述-満点20-数値13').gradeAffectedStudents === 0 && d.lines.some(l => /成績の値は変わりません/.test(l.text)), '');
        check('成績への影響: 成績の重みが0の課題は影響0人(「重みが0のため、いまは成績に入っていません」)', L('L9旧-主体性-満点0-数値13-重み0').gradeAffectedStudents === 0 && L('L9旧-主体性-満点0-数値13-重み0').gradeWeight === 0 && /重みが0/.test(d.html), '');
        check('無効な値(X)は成績に入らない → 影響1人', L('L10旧-主体性-満点0-X').gradeAffectedStudents === 1, '');
        check('影響を受ける児童の合計は、重複を除いた人数(児童の番号で数える)', d.affected === 4, 'affected=' + d.affected);
        check('画面: 「成績に正しく入っていない児童: 計4人」と、氏名は表示しない旨が出る', /成績に正しく入っていない児童: 計4人/.test(d.html) && /氏名は表示しません/.test(d.html), d.html.slice(0, 60));
        check('氏名は画面・診断結果のどこにも出ない(児童の氏名は含まれない)', NAMES.every(n => d.html.indexOf(n) === -1 && JSON.stringify(d.detail).indexOf(n) === -1), '');
        await page.evaluate(() => { copyAuditResultAsText(); }); await sleep(200);
        const clip = await page.evaluate(() => window.__clip || '');
        check('コピー用テキストにも、種類・直し方・成績への影響・児童数が含まれ、氏名は含まれない', /5段階\(印のない旧課題\)なのに数値の点数/.test(clip) && /直し方:/.test(clip) && /成績への影響:/.test(clip) && /成績に正しく入っていない児童: 計4人/.test(clip) && NAMES.every(n => clip.indexOf(n) === -1), clip.slice(0, 40));
        check('注意欄(anomalies.warn)にも、種類と「成績に正しく入っていない児童 4人」が出る', (d.warn || []).some(w => /入力形式と満点が矛盾/.test(w) && /13件/.test(w) && /成績に正しく入っていない児童 4人/.test(w)), JSON.stringify(d.warn));
        const after = await page.evaluate(() => [StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores), StorageManager.getRaw(KEYS.master)]);
        check('読み取り専用: 診断の前後で課題・記録・名簿が1バイトも変わらない', JSON.stringify(before) === JSON.stringify(after), '');
        const w = await page.evaluate(async () => { let n = 0; const o = Storage.prototype.setItem, r = Storage.prototype.removeItem; Storage.prototype.setItem = function() { n++; return o.apply(this, arguments); }; Storage.prototype.removeItem = function() { n++; return r.apply(this, arguments); }; try { runAuditDiagnosis(); await new Promise(res => setTimeout(res, 900)); copyAuditResultAsText(); await new Promise(res => setTimeout(res, 200)); } finally { Storage.prototype.setItem = o; Storage.prototype.removeItem = r; } return n; }); // 診断は少し遅れて計算されるため、終わるまで監視する
        check('読み取り専用: 診断の実行・コピーの間、localStorage への書き込み・削除が0回', w === 0, String(w));

        // ================= 3. 直し方(実際のクリック・入力で確認) =================
        console.log('--- 3. 直し方の確認(画面操作) ---');
        check('案内: 満点なしの状態(記録が数値)は「満点を入れて保存」の一行が出る', d.lines.some(l => l.guide === 'fix-max' && /満点を入れて保存/.test(l.text)), '');
        check('案内: 満点ありの5段階(記録が文字)は「そのまま保存(満点欄が消えます)」の一行が出る', d.lines.some(l => l.guide === 'fix-save' && /そのまま保存/.test(l.text)), '');
        check('案内: 記録の型と入力形式が食い違う状態は「画面の操作では直せない状態です」と出る', d.lines.some(l => l.guide === 'none' && /画面の操作では直せない/.test(l.text)), '');
        check('案内の対応: 直せる状態のガイドは fix-max(L1)・fix-save(L3)、直せない状態(L2・L4・F1・F2)は none', L('L1旧-知識-満点0-数値').guide === 'fix-max' && L('L3旧-主体性-満点20-A').guide === 'fix-save' && ['L2旧-主体性-満点20-数値13', 'L4旧-主体性-満点0-数値13', 'F1印あり-score-満点0-A', 'F2印あり-abc5-満点30-数値'].every(n => L(n).guide === 'none'), '');

        // 画面操作で編集を開く(入力画面で課題を選ぶ → 「この課題を編集」を実際にタップ)
        const openEdit = async (id) => {
            await page.evaluate((id) => { showView('records'); recShowSub('input'); recSelectTestGoto(id); }, id);
            await sleep(200);
            await page.click('#recEditThisTestBtn');
            await sleep(250);
        };
        const typeMax = async (v) => { await page.click('#recTestMaxScore', { clickCount: 3 }); await page.keyboard.press('Backspace'); if (v) await page.keyboard.type(String(v)); };
        const save = async () => { await page.click('#recAddTestBtn'); await sleep(300); };
        const testOf = (id) => page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(t => t.id === id), id);
        const formState = () => page.evaluate(() => ({ scoreBtnDisabled: document.getElementById('recInputModeScoreBtn').disabled, abcBtnDisabled: document.getElementById('recInputModeAbc5Btn').disabled, lockNote: getComputedStyle(document.getElementById('recInputModeLockNote')).display !== 'none', maxDisabled: document.getElementById('recTestMaxScore').disabled }));

        // (a) 満点なし・記録が数値(旧課題): 満点を入れて保存 → 直る
        await openEdit(1);
        let fs = await formState();
        check('直し方(a) 満点なし・数値の記録: 編集画面で満点欄に入力でき(入力形式は固定でも満点欄は使える)', fs.maxDisabled === false, JSON.stringify(fs));
        await typeMax(15); await save();
        let t1 = await testOf(1);
        check('直し方(a): 満点15で保存され、入力形式(判定)は得点のまま', t1.maxScore === 15 && getModeOf(t1) === 'score', JSON.stringify(t1));
        function getModeOf(t) { return t.inputMode || (t.category === '主体性' ? 'abc5' : 'score'); }
        let d2 = await diagnose();
        check('直し方(a): 診断から消える', !byName(d2, 'L1旧-知識-満点0-数値'), '');
        await page.evaluate(() => { showView('records'); recShowSub('input'); recSelectTestGoto(1); }); await sleep(250);
        const ui1 = await page.evaluate(() => ({ max: document.getElementById('rec-sc-0') && document.getElementById('rec-sc-0').getAttribute('max'), pct: document.getElementById('rec-pct-0') && document.getElementById('rec-pct-0').textContent }));
        check('直し方(a): 入力画面が満点15の得点欄になり、13点の割合(87%)が出る', ui1.max === '15' && ui1.pct === '／15(87%)', JSON.stringify(ui1));

        // (b) 満点あり・記録が文字(5段階): そのまま保存 → 満点0になる
        await openEdit(3);
        fs = await formState();
        check('直し方(b) 5段階で満点あり・文字の記録: 編集画面は5段階のまま(満点欄は入力不可)', fs.maxDisabled === true, JSON.stringify(fs));
        await save();
        let t3 = await testOf(3);
        check('直し方(b): そのまま保存すると満点0になり、5段階のまま(記録の文字と矛盾しない)', t3.maxScore === 0 && getModeOf(t3) === 'abc5', JSON.stringify(t3));
        d2 = await diagnose();
        check('直し方(b): 診断から消える', !byName(d2, 'L3旧-主体性-満点20-A'), '');
        // (b2) 印ありの5段階+満点あり+文字の記録
        await seed([T({ id: 21, name: 'F3印あり-abc5-満点30-文字', maxScore: 30, inputMode: 'abc5' })], [S(1, 21, 0, 'B')]);
        await openEdit(21); await save();
        const t21 = await testOf(21);
        d2 = await diagnose();
        check('直し方(b2) 印ありの5段階・満点あり・文字の記録: そのまま保存で満点0になり、診断から消える', t21.maxScore === 0 && t21.inputMode === 'abc5' && !byName(d2, 'F3印あり-abc5-満点30-文字'), JSON.stringify(t21));
        // (a2) 印ありの得点・満点0・数値の記録
        await seed([T({ id: 22, name: 'F4印あり-score-満点0-数値', category: '主体性', maxScore: 0, inputMode: 'score' })], [S(1, 22, 0, 12)]);
        await openEdit(22); await typeMax(20); await save();
        const t22 = await testOf(22);
        d2 = await diagnose();
        check('直し方(a2) 印ありの得点・満点0・数値の記録: 満点を入れて保存で直り、診断から消える(入力形式は得点のまま)', t22.maxScore === 20 && t22.inputMode === 'score' && !byName(d2, 'F4印あり-score-満点0-数値'), JSON.stringify(t22));

        // (c) 直せない状態: 5段階(判定)で数値の記録(旧課題・満点あり)。入力形式が固定されていて、画面では得点に戻せない
        await seed([T({ id: 2, name: 'L2旧-主体性-満点20-数値13', category: '主体性', maxScore: 20 })], [S(1, 2, 0, 13), S(2, 2, 1, 9)]);
        await openEdit(2);
        fs = await formState();
        check('直せない(c) 5段階(判定)で数値の記録: 編集画面で入力形式のタブが両方とも押せない(固定)・固定の理由が表示される', fs.scoreBtnDisabled === true && fs.abcBtnDisabled === true && fs.lockNote === true, JSON.stringify(fs));
        await page.click('#recInputModeScoreBtn').catch(() => {}); await sleep(100);
        await page.evaluate(() => { const el = document.getElementById('recTestCategory'); el.value = '知識・技能'; el.dispatchEvent(new Event('change', { bubbles: true })); });
        await save();
        const tc = await testOf(2);
        const dc = await diagnose();
        check('直せない(c): タブを押す・観点を変える・保存しても、入力形式は5段階のまま(数値の記録と食い違ったまま)で、診断にも残る(印が付き満点0になっても、abc5num として検出される)', getModeOf(tc) === 'abc5' && tc.inputMode === 'abc5' && !!(dc.detail || []).find(x => x.testId === 2 && x.kind === 'abc5num'), JSON.stringify(tc));
        // (d) 直せない状態: 得点(判定)で文字の記録・満点なし
        await seed([T({ id: 13, name: 'F1印あり-score-満点0-A', category: '主体性', maxScore: 0, inputMode: 'score' })], [S(1, 13, 0, 'A')]);
        await openEdit(13);
        fs = await formState();
        check('直せない(d) 得点(判定)で文字の記録・満点なし: 入力形式のタブが押せない(固定)', fs.scoreBtnDisabled === true && fs.abcBtnDisabled === true && fs.lockNote === true, JSON.stringify(fs));
        await typeMax(20); await save();
        const td = await testOf(13);
        check('直せない(d): 満点を入れて保存しても、入力形式は得点のまま・文字の記録と食い違ったまま(5段階に戻せない)', td.inputMode === 'score' && td.maxScore === 20, JSON.stringify(td));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { ['master', 'tests', 'scores', 'grade_weights'].forEach((k, i) => { if (b[i] === null) StorageManager.remove(KEYS[k]); else StorageManager.setImmediate(KEYS[k], b[i]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== audit-inputmode-repair: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
