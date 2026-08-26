// 段階8-2 機械検証: 作文(既存testType)をisABCTestに追加し、独立した5段階評価項目にしたことの検証。
//
// 変更内容(index.html):
//   - isABCTest(category, testType) に || testType === '作文' を追加
//     (category === '主体性' / testType === 'ルーブリック' / testType === '記述問題' はいずれも変更していない)
//   - recAddTest / recOnTestTypeChange / recEditTest はコード変更なし
//     (isABCTestの追加だけで正しく動く設計のため。段階8の記述問題と同型)
//   - 「記述問題」に関わるコードは一切変更していない(回帰確認あり)
//   - <option>・REC_TYPE_ORDER・_TYPE_ORDER・REC_PREFIX_MAP_TYPE・REC_ALL_PREFIXESは
//     既に登録済みで今回変更なし
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node composition-5rank.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

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
        // 1. 新規作成 → 5段階のABCボタンUIが出る(まずcategory=主体性で確認)
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '作文', name: 'ISABC82_主体性', category: '主体性', date: '2026-06-01' });
        const formState1 = await maxScoreFieldState();
        check('作成フォーム: 作文選択直後、満点欄がdisabled・プレースホルダー「ABC評価」になる', formState1.disabled === true && formState1.placeholder === 'ABC評価', JSON.stringify(formState1));

        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const created1 = await findTestByName('作文_ISABC82_主体性'); // 自動プレフィックスが付く想定
        check('新規作成(主体性): maxScoreが0で保存される', created1 && created1.maxScore === 0, JSON.stringify(created1));
        check('新規作成: 自動プレフィックス「作文_」が付く', created1 && created1.name === '作文_ISABC82_主体性', JSON.stringify(created1));

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created1.id);
        await new Promise(r => setTimeout(r, 150));
        const scoringUiState1 = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('採点画面(主体性): 数値入力欄が出ない', scoringUiState1.hasScInput === false, JSON.stringify(scoringUiState1));
        check('採点画面(主体性): ABCボタン(5個)が出る', scoringUiState1.abcBtnCount === 5, JSON.stringify(scoringUiState1));

        // ================================================================
        // 2. category を3種類すべて試し、どれでも5段階になること(思考・判断・表現を含む)
        // ================================================================
        const categoryCases = [
            { cat: '思考・判断・表現', name: 'ISABC82_思考' },
            { cat: '知識・技能', name: 'ISABC82_知識' }
        ];
        const createdByCat = { '主体性': created1 };
        for (const c of categoryCases) {
            await fillTestForm({ subject: '国語', testType: '作文', name: c.name, category: c.cat, date: '2026-06-01' });
            await page.evaluate(() => { window.recAddTest(); });
            await new Promise(r => setTimeout(r, 150));
            const created = await findTestByName('作文_' + c.name);
            check('新規作成(' + c.cat + '): maxScoreが0で保存される', created && created.maxScore === 0, JSON.stringify(created));
            await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
            await new Promise(r => setTimeout(r, 150));
            const uiState = await page.evaluate(() => ({
                hasScInput: !!document.getElementById('rec-sc-0'),
                abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
            }));
            check('採点画面(' + c.cat + '): ABCボタン(5個)が出て数値入力欄は出ない', uiState.abcBtnCount === 5 && uiState.hasScInput === false, JSON.stringify(uiState));
            createdByCat[c.cat] = created;
        }

        // ================================================================
        // 3. A〜Cを入力 → 10/8.5/7/5/3 で換算されること(期待値リテラル固定・abcTo10は呼ばない)
        // ================================================================
        const abcCases = [['A', 10], ['B+', 8.5], ['B', 7], ['B-', 5], ['C', 3]];
        for (const [grade, expected] of abcCases) {
            await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdByCat['主体性'].id);
            await new Promise(r => setTimeout(r, 150));
            await page.evaluate((g) => { window.recSelectABC(0, g); }, grade);
            await new Promise(r => setTimeout(r, 100));
            // grdCalculateはgrdGetScores()の独自キャッシュ(_grdCacheScores)を見るため、
            // recSaveScores側のキャッシュ無効化だけでは反映されない。実際のアプリでは
            // showView('grades')に切り替えた際にgrdInvalidate()が呼ばれてキャッシュが
            // 作り直される(index.html付近)。テストでも同じ経路を通す。
            await page.evaluate(() => { window.showView('grades'); window.showView('records'); });
            await new Promise(r => setTimeout(r, 100));
            const calcResults = await page.evaluate((subj) => window.grdCalculate(subj), '国語');
            const r0 = calcResults.find(x => x.index === 0);
            const item = r0.attitude.items.find(it => it.name === '作文_ISABC82_主体性');
            check('abcTo10換算: ' + grade + ' → ' + expected + '点', item && Math.abs(item.score10 - expected) < 0.01, JSON.stringify(item));
        }

        // ================================================================
        // 4. 選んだcategoryの観点に正しく算入されること(特に思考・判断・表現)
        // ================================================================
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdByCat['思考・判断・表現'].id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recSelectABC(0, 'A'); });
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdByCat['知識・技能'].id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recSelectABC(0, 'A'); });
        await new Promise(r => setTimeout(r, 100));
        await page.evaluate(() => { window.showView('grades'); window.showView('records'); });
        await new Promise(r => setTimeout(r, 100));
        const calcResults2 = await page.evaluate((subj) => window.grdCalculate(subj), '国語');
        const r0b = calcResults2.find(x => x.index === 0);
        const thinkingItem = r0b.thinking.items.find(it => it.name === '作文_ISABC82_思考');
        const knowledgeItem = r0b.knowledge.items.find(it => it.name === '作文_ISABC82_知識');
        const attitudeHasThinkingOrKnowledge = r0b.attitude.items.some(it => it.name === '作文_ISABC82_思考' || it.name === '作文_ISABC82_知識');
        check('観点算入: category=思考・判断・表現で作った作文は思考の集計に正しく算入される', thinkingItem && Math.abs(thinkingItem.score10 - 10) < 0.01, JSON.stringify(thinkingItem));
        check('観点算入: category=知識・技能で作った作文は知識の集計に入る', knowledgeItem && Math.abs(knowledgeItem.score10 - 10) < 0.01, JSON.stringify(knowledgeItem));
        check('観点算入: 思考・知識で作った作文が主体性の集計に紛れ込んでいない', attitudeHasThinkingOrKnowledge === false, String(attitudeHasThinkingOrKnowledge));

        // ================================================================
        // 5. 課題一覧のカードに「ABC評価」と表示されること
        // ================================================================
        await page.evaluate(() => { window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));
        const cardText = await page.evaluate((id) => {
            var el = document.querySelector('.rec-test-item-info[onclick*="' + id + '"]');
            return el ? el.closest('.rec-test-item').textContent : null;
        }, createdByCat['主体性'].id);
        check('課題一覧: カードに「ABC評価」と表示される', cardText && cardText.indexOf('ABC評価') >= 0, String(cardText));

        // ================================================================
        // 6. 状態遷移: 作成→保存→再描画→課題切り替え→戻る→編集(category変更)→削除
        // ================================================================
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdByCat['知識・技能'].id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdByCat['主体性'].id);
        await new Promise(r => setTimeout(r, 150));
        const afterSwitchBack = await page.evaluate(() => ({
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('状態遷移: 課題を切り替えて戻ってもABCボタン(5個)が表示される', afterSwitchBack.abcBtnCount === 5, JSON.stringify(afterSwitchBack));

        await page.evaluate((id) => { window.recEditTest(id); }, createdByCat['主体性'].id);
        await new Promise(r => setTimeout(r, 100));
        const editFormState = await maxScoreFieldState();
        check('編集画面: 満点欄がdisabled・プレースホルダー「ABC評価」のまま', editFormState.disabled === true && editFormState.placeholder === 'ABC評価', JSON.stringify(editFormState));
        await page.evaluate(() => { document.getElementById('recTestCategory').value = '知識・技能'; window.recOnCategoryChange(); });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterCategoryEdit = await page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(function(t) { return t.id === id; }), createdByCat['主体性'].id);
        check('編集(category変更): categoryが知識・技能に変わってもmaxScoreは0のまま', afterCategoryEdit && afterCategoryEdit.category === '知識・技能' && afterCategoryEdit.maxScore === 0, JSON.stringify(afterCategoryEdit));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdByCat['主体性'].id);
        await new Promise(r => setTimeout(r, 150));
        const afterCategoryEditUi = await page.evaluate(() => ({
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('編集(category変更)後: category=知識・技能でも引き続きABCボタン(5個)のまま(testType=作文のため)', afterCategoryEditUi.abcBtnCount === 5, JSON.stringify(afterCategoryEditUi));

        await page.evaluate((id) => { window.recDeleteTest(id); }, createdByCat['主体性'].id);
        await new Promise(r => setTimeout(r, 150));
        const afterDelete = await page.evaluate(() => ({
            bulkHidden: document.getElementById('recBulkWrap') ? document.getElementById('recBulkWrap').style.display === 'none' : null,
            infoShown: document.getElementById('recInputInfo') ? document.getElementById('recInputInfo').style.display !== 'none' : null
        }));
        check('削除: 採点エリアが隠れ「課題を選択」案内が出る', afterDelete.bulkHidden === true && afterDelete.infoShown === true, JSON.stringify(afterDelete));

        await page.evaluate((id) => { window.recDeleteTest(id); }, createdByCat['思考・判断・表現'].id);
        await page.evaluate((id) => { window.recDeleteTest(id); }, createdByCat['知識・技能'].id);
        await new Promise(r => setTimeout(r, 150));

        // ================================================================
        // 7. 「記述問題」(段階8)に関わる挙動が変更されていないことの回帰確認
        //    記述問題は既にisABCTest対象。今回の変更後も引き続きABC評価のままであること。
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '記述問題', name: 'ISABC82_記述回帰', category: '知識・技能', date: '2026-06-01' });
        const descFormState = await maxScoreFieldState();
        check('記述問題回帰: 満点欄がdisabled・プレースホルダー「ABC評価」のまま(従来どおり)', descFormState.disabled === true && descFormState.placeholder === 'ABC評価', JSON.stringify(descFormState));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const descCreated = await findTestByName('記述_ISABC82_記述回帰');
        check('記述問題回帰: maxScoreが0で保存される(従来どおり)', descCreated && descCreated.maxScore === 0, JSON.stringify(descCreated));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, descCreated.id);
        await new Promise(r => setTimeout(r, 150));
        const descUi = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('記述問題回帰: 採点画面は従来どおりABCボタン(5個)・数値入力欄なし', descUi.hasScInput === false && descUi.abcBtnCount === 5, JSON.stringify(descUi));
        await page.evaluate((id) => { window.recDeleteTest(id); }, descCreated.id);
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
