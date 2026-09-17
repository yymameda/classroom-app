// v1.49.0 機械検証: 評価項目ごとに入力形式(得点/5段階)を明示フラグ(test.inputMode)で
// 選べるようにしたことの検証。
//
// 変更内容(index.html):
//   - test.inputMode: 'score'(得点=score+maxScore) | 'abc5'(5段階=A/B+/B/B-/C、abcTo10換算)
//   - getItemInputMode(test): フラグがあれば最優先、無ければ従来の
//     isABCTest(category, testType, maxScore)にフォールバック(既存データは書き換えない)
//   - isABCTest/recTestKindを直接呼んでいた項目データ扱い箇所(recTestKind/recRenderList/
//     recDeviationStats/recRenderStats/recSaveAllScores/課題カードラベル/grdCalculateの
//     主体性ブロック/監査ツールのmaxScore欠損チェック)をgetItemInputModeへ置き換え
//   - 追加・編集フォームに「得点/5段階」の物理タブ(#recInputModeWrap)を追加
//     (まとめ/単元テスト・実技記録・授業態度は対象外で表示しない)
//   - 得点が1件でも入力済みの項目はタブをdisabledにしてロックする(確認ダイアログなし)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node item-input-mode.test.js

const puppeteer = require('puppeteer-core');
const { termSafeDate } = require('./helpers/term-date');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

const TEST_DATE = termSafeDate(10);

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

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    const REAL_KEYS = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, seating: KEYS.seating }));
    async function getKey(k) { return page.evaluate((kk) => StorageManager.getRaw(kk), k); }
    async function setKey(k, v) { await page.evaluate((kk, vv) => { StorageManager.setImmediate(kk, vv); }, k, v); }
    async function restoreKey(k, raw) {
        if (raw === null || raw === undefined) await page.evaluate((kk) => { StorageManager.remove(kk); }, k);
        else await setKey(k, raw);
    }
    const backup = {};
    for (const k of Object.values(REAL_KEYS)) backup[k] = await getKey(k);

    try {
        await page.evaluate(() => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: [{ name: '検証用A' }, { name: '検証用B' }],
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([]));
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));

        async function fillTestForm(fields) {
            await page.evaluate((f) => {
                if ('subject' in f) document.getElementById('recTestSubject').value = f.subject;
                if ('testType' in f) { document.getElementById('recTestType').value = f.testType; window.recOnTestTypeChange(); }
                if ('name' in f) document.getElementById('recTestName').value = f.name;
                if ('category' in f) { document.getElementById('recTestCategory').value = f.category; window.recOnCategoryChange(); }
                if ('date' in f) document.getElementById('recTestDate').value = f.date;
                if ('inputMode' in f) window.recSetInputMode(f.inputMode);
                if ('maxScore' in f) document.getElementById('recTestMaxScore').value = f.maxScore;
            }, fields);
        }
        async function findTestByName(name) {
            return page.evaluate((n) => {
                var tests = StorageManager.get(KEYS.tests, []);
                return tests.find(function(t) { return t.name === n; }) || null;
            }, name);
        }
        async function inputModeFormState() {
            return page.evaluate(() => {
                var ms = document.getElementById('recTestMaxScore');
                var scoreBtn = document.getElementById('recInputModeScoreBtn');
                var abc5Btn = document.getElementById('recInputModeAbc5Btn');
                var wrap = document.getElementById('recInputModeWrap');
                var note = document.getElementById('recInputModeLockNote');
                return {
                    wrapVisible: wrap && wrap.style.display !== 'none',
                    scoreActive: scoreBtn && scoreBtn.classList.contains('active'),
                    abc5Active: abc5Btn && abc5Btn.classList.contains('active'),
                    scoreDisabled: scoreBtn && scoreBtn.disabled,
                    abc5Disabled: abc5Btn && abc5Btn.disabled,
                    noteVisible: note && note.style.display !== 'none',
                    maxScoreDisabled: ms.disabled, maxScoreValue: ms.value, maxScorePlaceholder: ms.placeholder
                };
            });
        }
        async function scoringUiState() {
            return page.evaluate(() => ({
                hasScInput: !!document.getElementById('rec-sc-0'),
                scInputValue: (document.getElementById('rec-sc-0') || {}).value,
                abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
            }));
        }

        // ================================================================
        // 1. 思考・判断・表現×小テストで「得点」「5段階」の両方を新規作成し、
        //    それぞれ入力→保存→再読込→集計が正しいこと
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'IIM_得点', category: '思考・判断・表現', date: TEST_DATE });
        const formAfterType = await inputModeFormState();
        check('小テスト選択直後: タブが表示され、既定は得点(従来isABCTestがfalseのため)',
            formAfterType.wrapVisible === true && formAfterType.scoreActive === true && formAfterType.maxScoreDisabled === false,
            JSON.stringify(formAfterType));
        await fillTestForm({ maxScore: '10' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const scoreTest = await findTestByName('小テ_IIM_得点');
        check('得点タブで保存: inputMode="score"・maxScore=10で保存される',
            scoreTest && scoreTest.inputMode === 'score' && scoreTest.maxScore === 10, JSON.stringify(scoreTest));

        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'IIM_5段階', category: '思考・判断・表現', date: TEST_DATE, inputMode: 'abc5' });
        const formAfterAbc5 = await inputModeFormState();
        check('5段階タブをクリック: 満点欄がdisabled・プレースホルダー「ABC評価」になる',
            formAfterAbc5.abc5Active === true && formAfterAbc5.maxScoreDisabled === true && formAfterAbc5.maxScorePlaceholder === 'ABC評価',
            JSON.stringify(formAfterAbc5));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const abc5Test = await findTestByName('小テ_IIM_5段階');
        check('5段階タブで保存: inputMode="abc5"・maxScore=0で保存される',
            abc5Test && abc5Test.inputMode === 'abc5' && abc5Test.maxScore === 0, JSON.stringify(abc5Test));

        // 得点項目に入力→保存→再読込→集計
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, scoreTest.id);
        await new Promise(r => setTimeout(r, 150));
        const scoreUi = await scoringUiState();
        check('得点項目: 採点画面は数値入力欄・ABCボタンなし', scoreUi.hasScInput === true && scoreUi.abcBtnCount === 0, JSON.stringify(scoreUi));
        await page.evaluate(() => {
            var el = document.getElementById('rec-sc-0');
            el.value = '8'; el.dispatchEvent(new Event('blur'));
        });
        await new Promise(r => setTimeout(r, 150));
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('input'); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, scoreTest.id);
        await new Promise(r => setTimeout(r, 150));
        const scoreUiAfterReload = await scoringUiState();
        check('得点項目: リロード後も入力値(8)が保持される', scoreUiAfterReload.scInputValue === '8', JSON.stringify(scoreUiAfterReload));

        // 5段階項目に入力
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, abc5Test.id);
        await new Promise(r => setTimeout(r, 150));
        const abc5Ui = await scoringUiState();
        check('5段階項目: 採点画面はABCボタン(5個)・数値入力欄なし', abc5Ui.hasScInput === false && abc5Ui.abcBtnCount === 5, JSON.stringify(abc5Ui));
        await page.evaluate((id) => { window.recSelectABC(0, 'B+'); }, abc5Test.id);
        await new Promise(r => setTimeout(r, 150));

        // 集計確認
        await page.evaluate(() => { window.showView('grades'); window.showView('records'); });
        await new Promise(r => setTimeout(r, 100));
        const calc1 = await page.evaluate((subj) => window.grdCalculate(subj), '国語');
        const c1r0 = calc1.find(x => x.index === 0);
        const scoreItem = c1r0.thinking.items.find(it => it.name === '小テ_IIM_得点');
        const abc5Item = c1r0.thinking.items.find(it => it.name === '小テ_IIM_5段階');
        check('集計: 得点項目(8/10)はscore10=8で反映される', scoreItem && Math.abs(scoreItem.score10 - 8) < 0.01, JSON.stringify(scoreItem));
        check('集計: 5段階項目(B+)はabcTo10=8.5で反映される', abc5Item && Math.abs(abc5Item.score10 - 8.5) < 0.01, JSON.stringify(abc5Item));

        // ================================================================
        // 5. 入力済み項目の入力形式が変更できない
        // ================================================================
        await page.evaluate((id) => { window.recEditTest(id); }, scoreTest.id);
        await new Promise(r => setTimeout(r, 100));
        const lockedState = await inputModeFormState();
        check('入力済み項目を編集: タブがdisabledでロックされ、理由が1行表示される',
            lockedState.scoreDisabled === true && lockedState.abc5Disabled === true && lockedState.noteVisible === true,
            JSON.stringify(lockedState));
        // ロック中にrecSetInputMode('abc5')を呼んでも変わらないこと(確認ダイアログなし)
        await page.evaluate(() => { window.recSetInputMode('abc5'); });
        const lockedStateAfterAttempt = await inputModeFormState();
        check('ロック中: recSetInputMode()を呼んでもタブは切り替わらない',
            lockedStateAfterAttempt.scoreActive === true && lockedStateAfterAttempt.abc5Active === false, JSON.stringify(lockedStateAfterAttempt));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const scoreTestAfterLockedSave = await findTestByName('小テ_IIM_得点');
        check('入力済み項目: ロック状態で保存してもinputMode/maxScoreは変わらない',
            scoreTestAfterLockedSave && scoreTestAfterLockedSave.inputMode === 'score' && scoreTestAfterLockedSave.maxScore === 10,
            JSON.stringify(scoreTestAfterLockedSave));

        await page.evaluate((id) => { window.recDeleteTest(id); }, scoreTest.id);
        await page.evaluate((id) => { window.recDeleteTest(id); }, abc5Test.id);
        await new Promise(r => setTimeout(r, 150));

        // ================================================================
        // 2〜3. 既存形式(フラグなし)の振り返り: maxScore=5・得点1〜5をseed。
        //    リスト/連続入力/座席で数値のまま、個人カルテ・成績処理統合・データ出力の
        //    換算値が得点/5×10。編集画面を開いて保存してもmaxScore=5・数値形式のまま。
        // ================================================================
        const legacyTestId = Date.now() + 555;
        await page.evaluate(({ id, date }) => {
            var tests = StorageManager.get(KEYS.tests, []);
            tests.push({
                id: id, subject: '体育', testType: '振り返り', name: '振返_旧形式',
                category: '思考・判断・表現', type: 'standard', maxScore: 5,
                date: date, createdAt: new Date().toISOString()
            });
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            var scores = StorageManager.get(KEYS.scores, []);
            scores.push({ id: 900101, studentIndex: 0, testId: id, score: 4, createdAt: new Date().toISOString() });
            scores.push({ id: 900102, studentIndex: 1, testId: id, score: 1, createdAt: new Date().toISOString() });
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            recInvalidateCache();
        }, { id: legacyTestId, date: TEST_DATE });

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 150));
        // リストモード
        const legacyListUi = await scoringUiState();
        check('既存(フラグなし)振り返り: リストモードは数値入力欄のまま(ABCボタンにならない)',
            legacyListUi.hasScInput === true && legacyListUi.abcBtnCount === 0 && legacyListUi.scInputValue === '4', JSON.stringify(legacyListUi));
        // 連続入力モード
        await page.evaluate(() => { window.recSetViewMode('continuous'); });
        await new Promise(r => setTimeout(r, 150));
        const contText = await page.evaluate(() => {
            var cell = document.querySelector('#recContGrid .rec-cont-cell[data-cidx="0"]');
            return cell ? cell.querySelector('.sub-cont-mark').textContent : null;
        });
        check('既存(フラグなし)振り返り: 連続入力モードは数値(4)のまま表示される', contText === '4', String(contText));
        // 座席モード(座席配置を明示的に用意しないと全セルが空になるため、seedしてから見る)
        await page.evaluate(() => {
            StorageManager.setImmediate(KEYS.seating, JSON.stringify({ '0-0': 0, '0-1': 1 }));
        });
        await page.evaluate(() => { window.recSetViewMode('seat'); });
        await new Promise(r => setTimeout(r, 150));
        const seatText = await page.evaluate(() => {
            var cells = Array.from(document.querySelectorAll('#recSeatGrid .rec-seat-cell'));
            var cell = cells.find(function(c) {
                var nameEl = c.querySelector('.sub-seat-name');
                return nameEl && nameEl.textContent === '検証用A';
            });
            var statusEl = cell ? cell.querySelector('.sub-seat-status') : null;
            return statusEl ? statusEl.textContent : null;
        });
        check('既存(フラグなし)振り返り: 座席モードは数値(4)を含む表示になる(ABC表記ではない)',
            seatText !== null && seatText.indexOf('4') >= 0, String(seatText));
        await page.evaluate(() => { window.recSetViewMode('list'); });
        await new Promise(r => setTimeout(r, 150));

        // 個人カルテ・成績処理統合・データ出力(いずれもgrdCalculate経由)
        await page.evaluate(() => { window.showView('grades'); window.showView('records'); });
        await new Promise(r => setTimeout(r, 100));
        const calc2 = await page.evaluate((subj) => window.grdCalculate(subj), '体育');
        const legacyR0 = calc2.find(x => x.index === 0);
        const legacyR1 = calc2.find(x => x.index === 1);
        const legacyItem0 = legacyR0.thinking.items.find(it => it.name === '振返_旧形式');
        const legacyItem1 = legacyR1.thinking.items.find(it => it.name === '振返_旧形式');
        check('個人カルテ・成績処理統合(共通のgrdCalculate): 得点4/5×10=8点で反映される(児童0)',
            legacyItem0 && Math.abs(legacyItem0.score10 - 8) < 0.01, JSON.stringify(legacyItem0));
        check('個人カルテ・成績処理統合(共通のgrdCalculate): 得点1/5×10=2点で反映される(児童1)',
            legacyItem1 && Math.abs(legacyItem1.score10 - 2) < 0.01, JSON.stringify(legacyItem1));

        // 編集画面を開いて保存してもmaxScore=5・数値形式のまま(フラグは付かない)
        await page.evaluate(() => { window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recEditTest(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 100));
        const legacyEditState = await inputModeFormState();
        check('既存(フラグなし)振り返り編集画面: 得点タブがactive・ロック中(得点入力済みのため)・maxScore=5が見える',
            legacyEditState.scoreActive === true && legacyEditState.scoreDisabled === true &&
            legacyEditState.abc5Disabled === true && legacyEditState.maxScoreValue === '5', JSON.stringify(legacyEditState));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const legacyAfterSave = await page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(function(t) { return t.id === id; }), legacyTestId);
        check('既存(フラグなし)振り返り: 編集画面を開いて保存してもinputModeフラグが勝手に付かない',
            legacyAfterSave && legacyAfterSave.inputMode === undefined, JSON.stringify(legacyAfterSave));
        check('既存(フラグなし)振り返り: 編集画面を開いて保存してもmaxScore=5のまま',
            legacyAfterSave && legacyAfterSave.maxScore === 5, JSON.stringify(legacyAfterSave));
        const legacyScoresAfterSave = await page.evaluate((id) => StorageManager.get(KEYS.scores, []).filter(function(s) { return s.testId === id; }), legacyTestId);
        const legacyScore0 = legacyScoresAfterSave.find(function(s) { return s.studentIndex === 0; });
        const legacyScore1 = legacyScoresAfterSave.find(function(s) { return s.studentIndex === 1; });
        check('既存(フラグなし)振り返り: 編集画面を開いて保存しても得点データ(児童0=4)は変わらない',
            legacyScore0 && legacyScore0.score === 4, JSON.stringify(legacyScore0));
        check('既存(フラグなし)振り返り: 編集画面を開いて保存しても得点データ(児童1=1)は変わらない',
            legacyScore1 && legacyScore1.score === 1, JSON.stringify(legacyScore1));

        await page.evaluate((id) => { window.recDeleteTest(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 150));

        // ================================================================
        // 4. フラグなしの既存の記述問題・作文・主体性が従来どおり5段階
        // ================================================================
        const legacyAbcCases = [
            { id: Date.now() + 601, testType: '記述問題', category: '思考・判断・表現', name: 'IIM_旧記述問題' },
            { id: Date.now() + 602, testType: '作文', category: '思考・判断・表現', name: 'IIM_旧作文' },
            { id: Date.now() + 603, testType: '小テスト', category: '主体性', name: 'IIM_旧主体性' }
        ];
        await page.evaluate((cases, date) => {
            var tests = StorageManager.get(KEYS.tests, []);
            cases.forEach(function(c) {
                tests.push({ id: c.id, subject: '国語', testType: c.testType, name: c.name, category: c.category,
                    type: 'standard', maxScore: 0, date: date, createdAt: new Date().toISOString() });
            });
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            recInvalidateCache();
        }, legacyAbcCases, TEST_DATE);
        for (const c of legacyAbcCases) {
            await page.evaluate((id) => { window.recSelectTestGoto(id); }, c.id);
            await new Promise(r => setTimeout(r, 150));
            const ui = await scoringUiState();
            check('フラグなし既存(' + c.testType + '×' + c.category + '): 従来どおりABCボタン(5個)のまま',
                ui.hasScInput === false && ui.abcBtnCount === 5, JSON.stringify(ui));
        }
        await page.evaluate(() => { window.showView('records'); window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));
        for (const c of legacyAbcCases) {
            await page.evaluate((id) => { window.recDeleteTest(id); }, c.id);
        }
        await new Promise(r => setTimeout(r, 150));

        // ================================================================
        // コンソールエラーの回帰確認
        // ================================================================
        const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
        check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
        const restored = {};
        for (const k of Object.values(REAL_KEYS)) restored[k] = await getKey(k);
        const allRestored = Object.values(REAL_KEYS).every(k => restored[k] === backup[k]);
        check('触れた実データキーがすべて元の値に復元されている', allRestored, JSON.stringify({ restored: Object.keys(REAL_KEYS) }));
        await browser.close();
    }

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
