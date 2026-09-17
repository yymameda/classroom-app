// v1.48.0 機械検証: 体育の「振り返り」を5段階評価(A/B+/B/B-/C)対応にしたことの検証。
//
// 変更内容(index.html):
//   - isABCTest(category, testType) に || testType === '振り返り' を追加
//     (category === '主体性' / testType === 'ルーブリック'/'記述問題'/'作文' はいずれも変更していない)
//   - <option>・REC_TYPE_ORDER・REC_PREFIX_MAP_TYPE・REC_ALL_PREFIXESは既に登録済みで変更なし
//     (isABCTestの追加だけで、記述問題・作文と同型に5段階化される設計のため)
//   - recAddTest / recOnTestTypeChange / recEditTest / recUpdateTestSelect(optgroup整列)は
//     コード変更なし
//
// 確認すること:
//   ① 教科=体育で評価項目を追加できる(既存教科と同じ構造)
//   ② testType=振り返り・category=思考・判断・表現で5段階(ABC5個)入力になる
//   ③ 保存→リロードで値が保持される
//   ④ abcTo10換算で観点別集計(grdCalculate)の思考・判断・表現に反映される
//   ⑤ 未入力の児童はscore10=nullとして集計(平均)から除外される
//   ⑥ 課題選択(#recInputTestSelect)のoptgroup見出しに「思考・判断・表現｜振り返り」が並ぶ
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pe-reflection-5rank.test.js

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

    const REAL_KEYS = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores }));
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
            }, fields);
        }
        async function findTestByName(name) {
            return page.evaluate((n) => {
                var tests = StorageManager.get(KEYS.tests, []);
                return tests.find(function(t) { return t.name === n; }) || null;
            }, name);
        }
        async function maxScoreFieldState() {
            return page.evaluate(() => {
                var el = document.getElementById('recTestMaxScore');
                return { disabled: el.disabled, value: el.value, placeholder: el.placeholder };
            });
        }

        // ================================================================
        // ① 教科=体育で評価項目を追加できる／② testType=振り返り・category=思考・判断・表現で
        //    5段階(ABC5個)入力になる
        // ================================================================
        await fillTestForm({ subject: '体育', testType: '振り返り', name: 'ISABCPE_振り返り', category: '思考・判断・表現', date: TEST_DATE });
        const formState = await maxScoreFieldState();
        check('作成フォーム: 体育×振り返り選択直後、満点欄がdisabled・プレースホルダー「ABC評価」になる', formState.disabled === true && formState.placeholder === 'ABC評価', JSON.stringify(formState));

        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const created = await findTestByName('振返_ISABCPE_振り返り'); // 自動プレフィックスが付く想定
        check('新規作成: maxScoreが0で保存される(体育×振り返り)', created && created.maxScore === 0, JSON.stringify(created));
        check('新規作成: 自動プレフィックス「振返_」が付く', created && created.name === '振返_ISABCPE_振り返り', JSON.stringify(created));

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        const scoringUiState = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('採点画面: 数値入力欄が出ない', scoringUiState.hasScInput === false, JSON.stringify(scoringUiState));
        check('採点画面: ABCボタン(5個)が出る', scoringUiState.abcBtnCount === 5, JSON.stringify(scoringUiState));

        // ================================================================
        // ③ 保存→リロードで値が保持される(児童0=A、児童1は未入力のまま)
        // ================================================================
        await page.evaluate((id) => { window.recSelectABC(0, 'A'); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('input'); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        const afterReload = await page.evaluate(() => ({
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length,
            student0Selected: !!document.querySelector('#rec-row-0 .rec-abc-btn.sel-a'),
            student1Selected: !!document.querySelector('#rec-row-1 .rec-abc-btn[class*="sel-"]')
        }));
        check('リロード後: ABCボタン(5個)のまま', afterReload.abcBtnCount === 5, JSON.stringify(afterReload));
        check('リロード後: 児童0のA選択が保持される', afterReload.student0Selected === true, JSON.stringify(afterReload));
        check('リロード後: 児童1(未入力)は選択なしのまま', afterReload.student1Selected === false, JSON.stringify(afterReload));

        // ================================================================
        // ④ abcTo10換算で観点別集計(思考・判断・表現)に反映される
        // ⑤ 未入力の児童はscore10=nullとして集計から除外される
        // ================================================================
        await page.evaluate(() => { window.showView('grades'); window.showView('records'); });
        await new Promise(r => setTimeout(r, 100));
        const calcResults = await page.evaluate((subj) => window.grdCalculate(subj), '体育');
        const r0 = calcResults.find(x => x.index === 0); // 児童0: A入力済み
        const r1 = calcResults.find(x => x.index === 1); // 児童1: 未入力
        const item0 = r0.thinking.items.find(it => it.name === '振返_ISABCPE_振り返り');
        const item1 = r1.thinking.items.find(it => it.name === '振返_ISABCPE_振り返り');
        check('観点算入: 体育×振り返り(A入力)はabcTo10=10点で思考の集計に入る', item0 && Math.abs(item0.score10 - 10) < 0.01, JSON.stringify(item0));
        check('未入力除外: 児童1のitemはscore10=null', item1 && item1.score10 === null, JSON.stringify(item1));
        check('未入力除外: 児童1の思考平均はnull(他に項目がないため)', r1.thinking.avg === null, JSON.stringify(r1.thinking));
        check('観点算入: 児童0の思考平均は10(他に項目がないため)', Math.abs(r0.thinking.avg - 10) < 0.01, JSON.stringify(r0.thinking));

        // ================================================================
        // ⑥ 課題選択(#recInputTestSelect)のoptgroup見出しに「思考・判断・表現｜振り返り」が並ぶ
        // ================================================================
        const optgroupState = await page.evaluate(() => {
            var sel = document.getElementById('recInputTestSelect');
            var groups = Array.from(sel.querySelectorAll('optgroup')).map(function(g) { return g.label; });
            return { groups: groups, hasTarget: groups.indexOf('思考・判断・表現｜振り返り') >= 0 };
        });
        check('課題選択: optgroup見出しに「思考・判断・表現｜振り返り」が並ぶ', optgroupState.hasTarget === true, JSON.stringify(optgroupState));

        // ================================================================
        // ⑦ 互換性: isABCTestに振り返りを追加する前に作られた「数値方式」の既存データ
        //    (maxScore>0)は、5段階に強制変換せず数値のまま表示・編集・集計されること。
        //    (isABCTest(category, testType, maxScore)の第3引数によるガード。
        //    テスト条件自体を書き換えず、テストデータへの直接注入で再現する)
        // ================================================================
        const legacyTestId = Date.now() + 777;
        await page.evaluate(({ id, date }) => {
            var tests = StorageManager.get(KEYS.tests, []);
            tests.push({
                id: id, subject: '体育', testType: '振り返り', name: '振返_旧数値形式',
                category: '思考・判断・表現', type: 'standard', maxScore: 100,
                date: date, createdAt: new Date().toISOString()
            });
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            var scores = StorageManager.get(KEYS.scores, []);
            scores.push({ id: 900001, studentIndex: 0, testId: id, score: 80, createdAt: new Date().toISOString() });
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            recInvalidateCache();
        }, { id: legacyTestId, date: TEST_DATE });

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 150));
        const legacyScoringUi = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length,
            scInputValue: (document.getElementById('rec-sc-0') || {}).value
        }));
        check('互換性: 数値方式の既存項目は採点画面で数値入力欄のまま(ABCボタンにならない)',
            legacyScoringUi.hasScInput === true && legacyScoringUi.abcBtnCount === 0, JSON.stringify(legacyScoringUi));
        check('互換性: 数値方式の既存項目のスコアが空欄にならず表示される(80)',
            legacyScoringUi.scInputValue === '80', JSON.stringify(legacyScoringUi));

        await page.evaluate(() => { window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));
        const legacyCardText = await page.evaluate((id) => {
            var el = document.querySelector('.rec-test-item-info[onclick*="' + id + '"]');
            return el ? el.closest('.rec-test-item').textContent : null;
        }, legacyTestId);
        check('互換性: 課題一覧のカードに「100点満点」と表示される(ABC評価にならない)',
            legacyCardText && legacyCardText.indexOf('100点満点') >= 0, String(legacyCardText));

        await page.evaluate((id) => { window.recEditTest(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 100));
        const legacyEditState = await maxScoreFieldState();
        check('互換性: 編集画面を開いても満点欄が空欄・disabledにならず、既存の100が見える',
            legacyEditState.disabled === false && legacyEditState.value === '100', JSON.stringify(legacyEditState));
        // キャンセルして保存はしない(このテストは既存データの表示・集計だけを確認する)
        var cancelBtn = await page.$('#recCancelEditBtn');
        if (cancelBtn) { await cancelBtn.click(); await new Promise(r => setTimeout(r, 100)); }

        await page.evaluate(() => { window.showView('grades'); window.showView('records'); });
        await new Promise(r => setTimeout(r, 100));
        const legacyCalc = await page.evaluate((subj) => window.grdCalculate(subj), '体育');
        const legacyR0 = legacyCalc.find(x => x.index === 0);
        const legacyItem0 = legacyR0.thinking.items.find(it => it.name === '振返_旧数値形式');
        check('互換性: 数値方式の既存項目はscoreTo10換算(80/100*10=8点)で思考の集計に入る',
            legacyItem0 && Math.abs(legacyItem0.score10 - 8) < 0.01, JSON.stringify(legacyItem0));

        await page.evaluate((id) => { window.recDeleteTest(id); }, legacyTestId);
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
