// recToggleAbsent() の非破壊化(v1.15.3)の機械検証。
//
// 旧実装は欠席化時にレコードを{score:'',absent:true}のみへ全置換し、解除時は
// レコードごと削除していた(欠席往復1回で入力済みデータが消える)。この修正で
// 「absentフラグの付け外しのみ、他フィールドは保持」に変える。
//
// 併せて、absentレコードのscoreが保持されることに伴い新設した各種ガード
// (grdCalculate/recSaveAllScores/recOnScoreBlur/recSelectABC/peRecordToScore10)
// が正しく効くことも検証する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node absent.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

const MAT_CONFIG = {
    presetId: 'mat', combine: 'average', bonusMode: 'each', cap: 10,
    items: [
        { id: 'g1', name: '①前転グループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本',score:6},{label:'発展',score:10}] },
        { id: 'g2', name: '②後転グループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本',score:6},{label:'発展',score:10}] },
        { id: 'g3', name: '③倒立回転グループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'できる',score:10}] },
        { id: 'g4', name: '④平均立ちグループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本',score:6},{label:'発展',score:10}] }
    ],
    bonus: [
        { id: 'b1', name: '大きな前転', mode: 'level', levels: [{label:'未達成',score:0},{label:'達成',score:0.5}] },
        { id: 'b2', name: '前方倒立回転跳び', mode: 'level', levels: [{label:'未達成',score:0},{label:'達成',score:0.5}] }
    ],
    _presetId: 'mat'
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 900 }
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

    const now = Date.now();
    const numTestId = now + 1;   // 通常の100点テスト(国語・知識/技能)
    const matTestId = now + 2;   // 実技ルーブリック(マット運動)
    const legacyTestId = now + 3; // 旧形式の欠席レコード検証用の別テスト

    const students = [{ name: '児童A' }, { name: '児童B' }, { name: '児童C' }, { name: '児童D' }];
    const tests = [
        { id: numTestId, subject: '国語', testType: '単元テスト', category: '知識・技能', type: 'standard', maxScore: 100, name: '漢字テスト', date: '2026-08-19', createdAt: new Date().toISOString() },
        { id: matTestId, subject: '体育', testType: '実技記録', category: '知識・技能', type: 'standard', maxScore: 9999, peUnit: '実技:mat', peRubric: JSON.parse(JSON.stringify(MAT_CONFIG)), date: '2026-08-19', createdAt: new Date().toISOString() },
        { id: legacyTestId, subject: '算数', testType: '単元テスト', category: '知識・技能', type: 'standard', maxScore: 100, name: '計算テスト', date: '2026-08-19', createdAt: new Date().toISOString() }
    ];
    // 児童3(index3)のlegacyTestIdに、旧実装が生成していた形の欠席レコード(5フィールドのみ)を直接投入する
    const scores = [
        { id: 1, studentIndex: 3, testId: legacyTestId, score: '', absent: true, createdAt: new Date().toISOString() }
    ];

    await page.evaluate(({ tests, students, scores }) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { tests, students, scores });
    await page.reload({ waitUntil: 'networkidle0' });

    // ================================================================
    // 1〜4: 点数入力→欠席化→grdCalculate/recSaveAllScoresでの非破壊確認→解除
    // ================================================================
    const flow = await page.evaluate((testId) => {
        showView('records');
        recSelectTestGoto(testId);
        var out = {};

        // 1. 85点を入力
        var input = document.getElementById('rec-sc-0');
        input.value = '85';
        recOnScoreBlur(0);
        var afterInput = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 0 && s.testId === testId; });
        out.afterInputScore = afterInput ? afterInput.score : null;

        // 2. 欠席化
        recToggleAbsent(0);
        var afterAbsent = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 0 && s.testId === testId; });
        out.afterAbsentScore = afterAbsent ? afterAbsent.score : undefined;
        out.afterAbsentFlag = afterAbsent ? afterAbsent.absent : undefined;

        // 3. grdCalculateで85点が算入されないことを確認
        var calc = grdCalculate('国語');
        var r0 = calc.find(function(r) { return r.index === 0; });
        var item = r0.knowledge.items.find(function(it) { return it.itemKey === 'k_' + testId; });
        out.grdItemScore10 = item ? item.score10 : 'ITEM_NOT_FOUND';

        // 4. recSaveAllScores()を実行してもabsent/scoreが壊れないことを確認
        //    (input.valueは85のままdisabledで残っているはず)
        var inputStillThere = document.getElementById('rec-sc-0');
        out.inputValueBeforeBulkSave = inputStillThere ? inputStillThere.value : null;
        out.inputDisabled = inputStillThere ? inputStillThere.disabled : null;
        recSaveAllScores();
        var afterBulkSave = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 0 && s.testId === testId; });
        out.afterBulkSaveScore = afterBulkSave ? afterBulkSave.score : undefined;
        out.afterBulkSaveAbsent = afterBulkSave ? afterBulkSave.absent : undefined;

        // 5. 欠席解除 → 85点が復活していること(レコードが削除されていないこと)
        recToggleAbsent(0);
        var afterRelease = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 0 && s.testId === testId; });
        out.afterReleaseScore = afterRelease ? afterRelease.score : undefined;
        out.afterReleaseAbsent = afterRelease ? ('absent' in afterRelease) : undefined;
        out.afterReleaseExists = !!afterRelease;

        return out;
    }, numTestId);

    check('1. 85点入力が保存される', flow.afterInputScore === 85, 'got=' + flow.afterInputScore);
    check('1. 欠席化後もscore:85が保持される(absentと両立)', flow.afterAbsentScore === 85 && flow.afterAbsentFlag === true, JSON.stringify(flow));
    check('2. grdCalculate()は欠席中の85点を集計に算入しない(score10=null)', flow.grdItemScore10 === null, 'got=' + JSON.stringify(flow.grdItemScore10));
    check('(前提確認) 欠席行のinputはdisabledだが値85が残っている', flow.inputValueBeforeBulkSave === '85' && flow.inputDisabled === true, JSON.stringify(flow));
    check('3. recSaveAllScores()を実行してもabsentフラグが消えない', flow.afterBulkSaveAbsent === true, 'got=' + flow.afterBulkSaveAbsent);
    check('3. recSaveAllScores()を実行してもscoreが上書きされない', flow.afterBulkSaveScore === 85, 'got=' + flow.afterBulkSaveScore);
    check('4. 欠席解除でscore:85が復活する(レコード削除ではない)', flow.afterReleaseScore === 85 && flow.afterReleaseExists === true, JSON.stringify(flow));
    check('4. 欠席解除後はabsentキー自体が消える', flow.afterReleaseAbsent === false, 'got=' + flow.afterReleaseAbsent);

    // ================================================================
    // 5. ルーブリック種目(rubricData)での欠席往復
    // ================================================================
    const rubricFlow = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        var out = {};

        // 児童1にマットの一部項目を入力(完了はさせない。rubricDataがあることの確認が目的)
        recPeRubricSelectLevel(1, 'items', 'g1', 1); // 基本(6点)
        recPeRubricSelectLevel(1, 'items', 'g2', 2); // 発展(10点)
        var beforeAbsent = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 1 && s.testId === testId; });
        out.rubricDataBefore = beforeAbsent ? beforeAbsent.rubricData : null;

        // recToggleAbsent()自体はテスト種別を見ないため、UIにボタンが無くても直接呼び出せる
        recToggleAbsent(1);
        var afterAbsent = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 1 && s.testId === testId; });
        out.rubricDataAfterAbsent = afterAbsent ? afterAbsent.rubricData : null;
        out.absentFlagAfterAbsent = afterAbsent ? afterAbsent.absent : undefined;

        recToggleAbsent(1); // 解除
        var afterRelease = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 1 && s.testId === testId; });
        out.rubricDataAfterRelease = afterRelease ? afterRelease.rubricData : null;
        out.absentFlagAfterRelease = afterRelease ? ('absent' in afterRelease) : undefined;

        return out;
    }, matTestId);

    check('5. マット: 欠席化後もrubricDataが保持される', JSON.stringify(rubricFlow.rubricDataAfterAbsent) === JSON.stringify(rubricFlow.rubricDataBefore) && rubricFlow.absentFlagAfterAbsent === true, JSON.stringify(rubricFlow));
    check('5. マット: 欠席解除後もrubricDataが保持される', JSON.stringify(rubricFlow.rubricDataAfterRelease) === JSON.stringify(rubricFlow.rubricDataBefore) && rubricFlow.absentFlagAfterRelease === false, JSON.stringify(rubricFlow));

    // ================================================================
    // 6. 旧形式の欠席レコード(score:'', absent:true の5フィールドのみ)を
    //    読んでも例外が出ないこと
    // ================================================================
    const legacyFlow = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        var out = {};
        var before = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 3 && s.testId === testId; });
        out.beforeShape = before;

        var threw = false, errMsg = '';
        try {
            var calc = grdCalculate('算数');
            var r3 = calc.find(function(r) { return r.index === 3; });
            var item = r3.knowledge.items.find(function(it) { return it.itemKey === 'k_' + testId; });
            out.grdItemScore10 = item ? item.score10 : 'ITEM_NOT_FOUND';
            recSaveAllScores();
            recToggleAbsent(3); // 解除
        } catch (e) {
            threw = true; errMsg = e.message;
        }
        out.threw = threw; out.errMsg = errMsg;
        var after = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s) { return s.studentIndex === 3 && s.testId === testId; });
        out.afterShape = after;
        return out;
    }, legacyTestId);

    check('6. 旧形式の欠席レコードを読んでも例外が出ない', legacyFlow.threw === false, JSON.stringify(legacyFlow));
    check('6. 旧形式の欠席レコードもgrdCalculate()でscore10=null扱いになる', legacyFlow.grdItemScore10 === null, 'got=' + JSON.stringify(legacyFlow.grdItemScore10));
    check('6. 旧形式の欠席レコードも解除後はレコードが残りabsentキーが消える', legacyFlow.afterShape && !('absent' in legacyFlow.afterShape), JSON.stringify(legacyFlow.afterShape));

    check('ページ読み込み・全操作中にコンソールエラーなし(favicon.ico除く)', consoleErrors.length === 0, JSON.stringify(consoleErrors));

    await browser.close();

    const fail = results.filter(function(r) { return !r.pass; });
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail.length) + '件 / 失敗: ' + fail.length + '件');
    if (fail.length > 0) process.exit(1);
})();
