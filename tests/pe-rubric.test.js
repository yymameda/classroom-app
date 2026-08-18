// 体育「実技ルーブリック採点」(PE_RUBRIC_SPEC.md) Phase1 の機械検証。
//
// §1〜4は共通基盤(peRubricCalcScore10/peRubricApplyScore/入力UI/peRubricRecalcScores)を
// 合成config直接注入(MAT_CONFIG/VOLLEY_CONFIG)で検証する高速な単体テスト。
// §5・§6はソフトバレー/マットそれぞれのプリセット実配線(recAddTest()→
// peRubricGetPresetId→peRubricBuildFromPreset経路)を実際の課題登録フォーム
// 操作で検証する結合テスト。単体テストは残し、実配線テストを追加する方針
// (§1〜4を置き換えるのではなく§5・§6を積み増す)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pe-rubric.test.js

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
const VOLLEY_CONFIG = {
    presetId: 'volley', combine: 'table', bonusMode: 'any', cap: 10,
    items: [ { id: 'v1', name: '5方向', mode: 'trial', blocks: [{ id: 'dir', name: '5方向', trials: 5 }] } ],
    bonus: [],
    conversionTable: [
        {count:5,score10:10},{count:4,score10:9},{count:3,score10:7},
        {count:2,score10:5},{count:1,score10:3},{count:0,score10:1}
    ],
    _presetId: 'volley'
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
    const matTestId = now + 1;
    const volleyTestId = now + 2;
    const nwTestId = now + 3;

    const students = [{name:'児童A'},{name:'児童B'},{name:'児童C'},{name:'児童D'}];
    const tests = [
        { id: matTestId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'マット運動', type:'standard', maxScore:9999, peUnit:'実技:mat', peRubric: JSON.parse(JSON.stringify(MAT_CONFIG)), date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: volleyTestId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'ソフトバレー', type:'standard', maxScore:9999, peUnit:'実技:volley', peRubric: JSON.parse(JSON.stringify(VOLLEY_CONFIG)), date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: nwTestId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'なわとび', type:'standard', maxScore:9999, peUnit:'なわとびカード', date:'2026-08-19', createdAt:new Date().toISOString() }
    ];
    // 児童0=マット完了(①6②10③10④0), 児童1=マット未完了(3/4項目), 児童2=マット全未入力
    const scores = [
        { id: 1, studentIndex: 0, testId: matTestId, rubricData: { items: { g1:1,g2:2,g3:1,g4:0 }, bonus: {} }, score10: 6.5, score: 6.5, createdAt: new Date().toISOString() },
        { id: 2, studentIndex: 1, testId: matTestId, rubricData: { items: { g1:1,g2:2,g3:1 }, bonus: {} }, createdAt: new Date().toISOString() },
        { id: 3, studentIndex: 2, testId: matTestId, rubricData: { items: {}, bonus: {} }, createdAt: new Date().toISOString() }
    ];

    await page.evaluate(({ tests, students, scores }) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year:2026, grade:5, class:1, termSystem:3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { tests, students, scores });
    await page.reload({ waitUntil: 'networkidle0' });

    // ================================================================
    // 1. peRubricCalcScore10() 検算(§7.1)
    // ================================================================
    const calcCheck = await page.evaluate(({ matConfig, volleyConfig }) => {
        var out = {};
        out.matExample = peRubricCalcScore10(matConfig, { items: { g1:1,g2:2,g3:1,g4:0 }, bonus: { b1:1, b2:0 } }); // 期待7
        out.matPartial = peRubricCalcScore10(matConfig, { items: { g1:1,g2:2,g3:1 }, bonus: {} }); // 3/4項目のみ→未完了
        out.matCap = peRubricCalcScore10(matConfig, { items: { g1:2,g2:2,g3:1,g4:2 }, bonus: { b1:1, b2:1 } }); // 頭打ち10
        out.matBonusUntouched = peRubricCalcScore10(matConfig, { items: { g1:1,g2:2,g3:1,g4:0 }, bonus: {} }); // 加点未タップでも完了
        [5,4,3,2,1,0].forEach(function(n) {
            var dir = [];
            for (var i=0;i<5;i++) dir.push(i<n?1:0);
            out['volley'+n] = peRubricCalcScore10(volleyConfig, { items: { v1: { dir: dir } } });
        });
        out.volleyPartial = peRubricCalcScore10(volleyConfig, { items: { v1: { dir: [1,1,null,null,null] } } }); // 2/5(両方○)でも未完了
        out.volleyEmpty = peRubricCalcScore10(volleyConfig, { items: {} });
        return out;
    }, { matConfig: MAT_CONFIG, volleyConfig: VOLLEY_CONFIG });

    check('マット検算: ①6②10③10④0+加点①のみ → 7', calcCheck.matExample.total === 7 && calcCheck.matExample.complete === true, JSON.stringify(calcCheck.matExample));
    check('マット: 3/4項目のみ → complete=false, score10なし', calcCheck.matPartial.complete === false && calcCheck.matPartial.total === null, JSON.stringify(calcCheck.matPartial));
    check('マット: cap10クリップ(全項目最大+加点2つ→11のはずが10)', calcCheck.matCap.total === 10, JSON.stringify(calcCheck.matCap));
    check('マット: bonus未タップでも主要4項目完了ならcomplete=true(bonusは完了条件に含めない)', calcCheck.matBonusUntouched.complete === true && calcCheck.matBonusUntouched.bonus === 0, JSON.stringify(calcCheck.matBonusUntouched));
    check('ソフトバレー検算: 5成功→10', calcCheck.volley5.total === 10);
    check('ソフトバレー検算: 4成功→9(§7.1の必須検算)', calcCheck.volley4.total === 9);
    check('ソフトバレー検算: 3成功→7', calcCheck.volley3.total === 7);
    check('ソフトバレー検算: 2成功→5', calcCheck.volley2.total === 5);
    check('ソフトバレー検算: 1成功→3', calcCheck.volley1.total === 3);
    check('ソフトバレー検算: 0成功→1', calcCheck.volley0.total === 1);
    check('ソフトバレー: 2/5タップ(両方○)でも生カウント2とは無関係にcomplete=false(事故回避)', calcCheck.volleyPartial.complete === false && calcCheck.volleyPartial.total === null, JSON.stringify(calcCheck.volleyPartial));
    check('ソフトバレー: 全未入力→complete=false', calcCheck.volleyEmpty.complete === false);

    // ================================================================
    // 2. 入力UI(commit 2): タップ→保存→完了ゲート→取り消しで削除
    // ================================================================
    const uiCheck = await page.evaluate((testId) => {
        showView('records');
        recSelectTestGoto(testId);
        var out = {};

        recPeRubricToggleTrial(3, 'items', 'v1', 'dir', 0); // 未実施→○
        var s1 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===3 && s.testId===testId;});
        out.afterFirstTap = s1.rubricData.items.v1.dir[0];
        recPeRubricToggleTrial(3, 'items', 'v1', 'dir', 0); // ○→×
        var s2 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===3 && s.testId===testId;});
        out.afterSecondTap = s2.rubricData.items.v1.dir[0];
        recPeRubricToggleTrial(3, 'items', 'v1', 'dir', 0); // ×→未実施(null)
        var s3 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===3 && s.testId===testId;});
        out.afterThirdTap = s3.rubricData.items.v1.dir[0];

        // 5/5成功にして確定
        for (var i=0;i<5;i++) recPeRubricToggleTrial(3, 'items', 'v1', 'dir', i);
        var s4 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===3 && s.testId===testId;});
        out.fullScore10 = s4.score10;
        out.badgeAfterFull = document.getElementById('rec-row-3').querySelector('.rec-pr-badge').textContent;

        // 1枠を未実施に戻す→未完了に復帰、score10削除
        recPeRubricToggleTrial(3, 'items', 'v1', 'dir', 4); // ○→×
        recPeRubricToggleTrial(3, 'items', 'v1', 'dir', 4); // ×→未実施
        var s5 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===3 && s.testId===testId;});
        out.afterRevertHasScore10 = 'score10' in s5;
        out.badgeAfterRevert = document.getElementById('rec-row-3').querySelector('.rec-pr-badge').textContent;

        return out;
    }, volleyTestId);
    check('UI: 3状態サイクル 1回目タップで○(1)', uiCheck.afterFirstTap === 1, 'got='+uiCheck.afterFirstTap);
    check('UI: 3状態サイクル 2回目タップで×(0)', uiCheck.afterSecondTap === 0, 'got='+uiCheck.afterSecondTap);
    check('UI: 3状態サイクル 3回目タップで未実施(null)', uiCheck.afterThirdTap === null, 'got='+JSON.stringify(uiCheck.afterThirdTap));
    check('UI: 5/5成功でscore10=10・確定バッジ', uiCheck.fullScore10 === 10 && uiCheck.badgeAfterFull === '✓ 確定', JSON.stringify(uiCheck));
    check('UI: 1枠を未実施に戻すとscore10キーが削除され未完了バッジに戻る', uiCheck.afterRevertHasScore10 === false && uiCheck.badgeAfterRevert === '入力中', JSON.stringify(uiCheck));

    // ================================================================
    // 3. peRubricRecalcScores() + 基準編集モーダル(commit 3): 黒箱検証
    //    (完了ゲートが再計算・保存モーダル経由でも効くことの回帰防止)
    // ================================================================
    const beforeSnap = await page.evaluate(() => JSON.parse(StorageManager.getRaw(KEYS.scores)));
    const b0 = beforeSnap.find(s=>s.studentIndex===0 && s.testId===matTestId);
    const b1 = beforeSnap.find(s=>s.studentIndex===1 && s.testId===matTestId);
    const b2 = beforeSnap.find(s=>s.studentIndex===2 && s.testId===matTestId);
    check('recalc前提: 未完了(3/4項目)にscore10キーがない', !('score10' in b1));
    check('recalc前提: 全未入力にscore10キーがない', !('score10' in b2));

    const afterRecalc = await page.evaluate((testId) => {
        var tests = JSON.parse(StorageManager.getRaw(KEYS.tests));
        var test = tests.find(function(t){return t.id===testId;});
        peRubricRecalcScores(test); // 基準不変での再計算
        return JSON.parse(StorageManager.getRaw(KEYS.scores));
    }, matTestId);
    const a0 = afterRecalc.find(s=>s.studentIndex===0), a1 = afterRecalc.find(s=>s.studentIndex===1), a2 = afterRecalc.find(s=>s.studentIndex===2);
    check('recalc: 完了レコードは基準不変ならscore10維持(6.5)', a0.score10 === 6.5, 'got='+a0.score10);
    check('recalc: 再計算後も未完了(3/4)にscore10キーが増えない', !('score10' in a1));
    check('recalc: 再計算後も全未入力にscore10キーが増えない', !('score10' in a2));

    const modalFlow = await page.evaluate((testId) => {
        recEditPeRubricConfig(testId);
        var g1lv1 = document.querySelector('#peRubricConfigModal input[data-kind="item"][data-item-id="g1"][data-level-idx="1"]');
        g1lv1.value = '8'; // g1 level1: 6→8(基準を緩める)
        recSavePeRubricConfig(); // 実際の保存ボタン相当の経路
        var tests = JSON.parse(StorageManager.getRaw(KEYS.tests));
        var test = tests.find(function(t){return t.id===testId;});
        var scores = JSON.parse(StorageManager.getRaw(KEYS.scores));
        return {
            modalClosed: !document.getElementById('peRubricConfigModal'),
            configPersisted: test.peRubric.items[0].levels[1].score,
            sr0: scores.find(function(s){return s.studentIndex===0 && s.testId===testId;}),
            sr1: scores.find(function(s){return s.studentIndex===1 && s.testId===testId;}),
            sr2: scores.find(function(s){return s.studentIndex===2 && s.testId===testId;})
        };
    }, matTestId);
    check('保存モーダル: test.peRubricが永続化される(8)', modalFlow.configPersisted === 8, 'got='+modalFlow.configPersisted);
    check('保存モーダル: 完了レコードが新基準(8+10+10+0)/4=7に更新される', modalFlow.sr0.score10 === 7, 'got='+modalFlow.sr0.score10);
    check('保存モーダル経由でも未完了(3/4)にscore10キーが増えない【核心・回帰防止】', !('score10' in modalFlow.sr1), JSON.stringify(modalFlow.sr1));
    check('保存モーダル経由でも全未入力にscore10キーが増えない【核心・回帰防止】', !('score10' in modalFlow.sr2), JSON.stringify(modalFlow.sr2));
    check('保存モーダル: 保存後にモーダルが閉じる', modalFlow.modalClosed);

    const kenteiCheck = await page.evaluate((testId) => {
        recEditKenteiTable(testId);
        var opened = !!document.getElementById('kenteiTableModal');
        recCloseKenteiTableModal();
        return { opened: opened, closedAfter: !document.getElementById('kenteiTableModal') };
    }, nwTestId);
    check('既存の検定カード換算表モーダルが無変更で開閉できる(回帰)', kenteiCheck.opened && kenteiCheck.closedAfter);

    // ================================================================
    // 4. 回帰: grdCalculate()経由で知識・技能に正しく反映される
    //    (児童0のマットは直前の保存モーダル操作でscore10=7が確定済み)
    // ================================================================
    const grd = await page.evaluate((testId) => {
        var calc = grdCalculate('体育');
        var r0 = calc.find(function(r){return r.index===0;});
        var item = r0.knowledge.items.find(function(it){return it.itemKey === 'k_' + testId;});
        return { score10: item ? item.score10 : null };
    }, matTestId);
    check('grdCalculate経由で確定値が知識・技能itemに反映される(児童0のマット7点)', grd.score10 === 7, JSON.stringify(grd));

    // ================================================================
    // 5. プリセット実配線検証(commit4: ソフトバレー)
    //    合成config直接注入ではなく、実際の課題登録フォーム→recAddTest()→
    //    peRubricGetPresetId→peRubricBuildFromPreset の経路そのものを検証する。
    // ================================================================
    const created = await page.evaluate(() => {
        showView('records');
        recShowSub('tests');
        document.getElementById('recTestSubject').value = '体育';
        document.getElementById('recTestType').value = '実技記録';
        recOnTestTypeChange();
        document.getElementById('recTestName').value = 'ソフトバレー(実プリセット)';
        document.getElementById('recTestDate').value = '2026-08-19';
        document.getElementById('recTestPeUnit').value = '実技:volley';
        recOnPeUnitChange();
        var catEl = document.getElementById('recTestCategory');
        var wrap = document.getElementById('recPeDirTrialWrap');
        var noConvertHint = document.getElementById('recPeNoConvertHint');
        var uiState = {
            catValue: catEl.value, catDisabled: catEl.disabled,
            wrapHidden: wrap.style.display === 'none',
            noConvertHintHidden: noConvertHint.style.display !== 'block'
        };
        recAddTest();
        var tests = JSON.parse(StorageManager.getRaw(KEYS.tests));
        var test = tests.find(function(t){ return t.name === 'ソフトバレー(実プリセット)'; });
        return { uiState: uiState, test: test };
    });
    check('フォーム: 実技:volley選択でカテゴリが知識・技能に自動固定・方向欄が隠れる・未対応警告が出ない',
        created.uiState.catValue === '知識・技能' && created.uiState.catDisabled === true &&
        created.uiState.wrapHidden && created.uiState.noConvertHintHidden, JSON.stringify(created.uiState));
    check('recAddTest(): categoryが知識・技能に強制され、peRubricがプリセットから自動生成される',
        created.test && created.test.category === '知識・技能' && !!created.test.peRubric, JSON.stringify(created.test && created.test.category));
    check('プリセット一致(§4.1): combine=table、加点なし、presetId=volley',
        created.test.peRubric.combine === 'table' && created.test.peRubric.bonus.length === 0 &&
        (created.test.peRubric.presetId === 'volley' || created.test.peRubric._presetId === 'volley'),
        JSON.stringify({combine:created.test.peRubric.combine, bonus:created.test.peRubric.bonus}));
    check('プリセット一致(§4.1): 換算表が5→10/4→9/3→7/2→5/1→3/0→1',
        JSON.stringify(created.test.peRubric.conversionTable) === JSON.stringify([
            {count:5,score10:10},{count:4,score10:9},{count:3,score10:7},{count:2,score10:5},{count:1,score10:3},{count:0,score10:1}
        ]), JSON.stringify(created.test.peRubric.conversionTable));
    check('プリセット一致: 5方向×各1試技、①〜⑤のラベル順',
        created.test.peRubric.items[0].blocks.length === 5 &&
        JSON.stringify(created.test.peRubric.items[0].blocks.map(function(b){return b.name;})) === JSON.stringify(['①真正面','②右','③左','④前寄り','⑤後ろ寄り']),
        JSON.stringify(created.test.peRubric.items[0].blocks.map(function(b){return b.name;})));
    check('§8受け入れ基準6: 「本校の実態に応じた目安」注記がpeRubric.noteに存在',
        /本校の実態に応じた目安/.test(created.test.peRubric.note || ''), created.test.peRubric.note);
    check('§4.1判定基準: センターサークル/5m/山なり等の注記がitem.hintに存在',
        /センターサークル/.test(created.test.peRubric.items[0].hint || '') && /5m/.test(created.test.peRubric.items[0].hint || '') && /山なり/.test(created.test.peRubric.items[0].hint || ''),
        created.test.peRubric.items[0].hint);

    const tapResult = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        var card = document.getElementById('rec-row-0');
        var hintCount = card.querySelectorAll('.rec-pr-item-hint').length;
        var trialLabels = Array.from(card.querySelectorAll('.rec-pr-trial-label')).map(function(el){return el.textContent;});
        recPeRubricToggleTrial(0, 'items', 'v1', 'front', 0);
        recPeRubricToggleTrial(0, 'items', 'v1', 'right', 0);
        recPeRubricToggleTrial(0, 'items', 'v1', 'left', 0);
        recPeRubricToggleTrial(0, 'items', 'v1', 'forward', 0);
        var partial = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        recPeRubricToggleTrial(0, 'items', 'v1', 'back', 0); // 5/5に
        var full = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        return { hintCount: hintCount, trialLabels: trialLabels, partialHasScore10: 'score10' in partial, fullScore10: full.score10 };
    }, created.test.id);
    check('実配線UI: 注記(hint)・5方向ラベル(①〜⑤)がカードに表示される',
        tapResult.hintCount > 0 && JSON.stringify(tapResult.trialLabels) === JSON.stringify(['①真正面','②右','③左','④前寄り','⑤後ろ寄り']),
        JSON.stringify(tapResult));
    check('実配線UI: 4/5タップ時点でscore10未保存、5/5成功でscore10=10',
        tapResult.partialHasScore10 === false && tapResult.fullScore10 === 10, JSON.stringify(tapResult));

    // ================================================================
    // 6. プリセット実配線検証(commit5: マット運動)
    // ================================================================
    const matCreated = await page.evaluate(() => {
        document.getElementById('recTestSubject').value = '体育';
        document.getElementById('recTestType').value = '実技記録';
        recOnTestTypeChange();
        document.getElementById('recTestName').value = 'マット運動(実プリセット)';
        document.getElementById('recTestDate').value = '2026-08-19';
        document.getElementById('recTestPeUnit').value = '実技:mat';
        recOnPeUnitChange();
        var catEl = document.getElementById('recTestCategory');
        var wrap = document.getElementById('recPeDirTrialWrap');
        var noConvertHint = document.getElementById('recPeNoConvertHint');
        var uiState = {
            catValue: catEl.value, catDisabled: catEl.disabled,
            wrapHidden: wrap.style.display === 'none',
            noConvertHintHidden: noConvertHint.style.display !== 'block'
        };
        recAddTest();
        var tests = JSON.parse(StorageManager.getRaw(KEYS.tests));
        var test = tests.find(function(t){ return t.name === 'マット運動(実プリセット)'; });
        return { uiState: uiState, test: test };
    });
    check('フォーム: 実技:mat選択でカテゴリ固定・方向欄が隠れる・未対応警告なし(option追加のみで動くことの確認)',
        matCreated.uiState.catValue === '知識・技能' && matCreated.uiState.catDisabled === true &&
        matCreated.uiState.wrapHidden && matCreated.uiState.noConvertHintHidden, JSON.stringify(matCreated.uiState));
    const matPr = matCreated.test.peRubric;
    check('recAddTest(): peRubricがマットプリセットから生成される', matCreated.test && !!matPr && (matPr.presetId==='mat'||matPr._presetId==='mat'));
    check('§4.2一致: combine=average, bonusMode=each, 4項目', matPr.combine==='average' && matPr.bonusMode==='each' && matPr.items.length===4, JSON.stringify({combine:matPr.combine,bonusMode:matPr.bonusMode,n:matPr.items.length}));
    check('§4.2一致: ①②④のlevelsが0/6/10', ['g1','g2','g4'].every(function(id){
        var it = matPr.items.find(function(i){return i.id===id;});
        return JSON.stringify(it.levels.map(function(l){return l.score;})) === JSON.stringify([0,6,10]);
    }), JSON.stringify(matPr.items.map(function(i){return {id:i.id, scores:i.levels.map(function(l){return l.score;})};})));
    check('§4.2一致: ③のlevelsが0/10の2段階', (function(){ var g3=matPr.items.find(function(i){return i.id==='g3';}); return JSON.stringify(g3.levels.map(function(l){return l.score;}))===JSON.stringify([0,10]); })());
    check('levelsラベル: §4.2の文言(未達成/基本安定/発展安定)と一致', matPr.items[0].levels[0].label === '未達成（3回中0〜1回成功）' &&
        matPr.items[0].levels[1].label === '基本の技が安定してできる（3回中2回以上成功）' &&
        matPr.items[0].levels[2].label === '発展技が安定してできる（3回中2回以上成功）',
        JSON.stringify(matPr.items[0].levels));
    check('§4.2一致: 加点2つ(大きな前転/前方倒立回転跳び)、各mode:level、+0.5', matPr.bonus.length===2 &&
        matPr.bonus[0].name==='大きな前転' && matPr.bonus[0].mode==='level' && matPr.bonus[0].levels[1].score===0.5 &&
        matPr.bonus[1].name==='前方倒立回転跳び' && matPr.bonus[1].mode==='level' && matPr.bonus[1].levels[1].score===0.5,
        JSON.stringify(matPr.bonus));
    check('§8受け入れ基準6: マットにも「本校の実態に応じた目安」注記', /本校の実態に応じた目安/.test(matPr.note||''));

    const matTap = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        recPeRubricSelectLevel(1, 'items', 'g1', 1); // 6
        recPeRubricSelectLevel(1, 'items', 'g2', 2); // 10
        recPeRubricSelectLevel(1, 'items', 'g3', 1); // 10
        var partial = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===1 && s.testId===testId;});
        var partialHasScore10 = partial ? ('score10' in partial) : false;
        recPeRubricSelectLevel(1, 'items', 'g4', 0); // 0 → 4/4完了、bonus未タップ
        var noBonus = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===1 && s.testId===testId;});
        var noBonusScore10 = noBonus.score10;
        recPeRubricSelectLevel(1, 'bonus', 'b1', 1); // +0.5
        var withBonus = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===1 && s.testId===testId;});
        return { partialHasScore10: partialHasScore10, noBonusScore10: noBonusScore10, withBonusScore10: withBonus.score10 };
    }, matCreated.test.id);
    check('§7.2/一部入力: 3/4項目時点でscore10未保存(実配線)', matTap.partialHasScore10 === false, JSON.stringify(matTap));
    check('bonus未タップでも4項目完了でcomplete扱い(実配線, score10=6.5)', matTap.noBonusScore10 === 6.5, 'got='+matTap.noBonusScore10);
    check('§7.1検算(実配線): ①6②10③10④0+加点①のみ→7', matTap.withBonusScore10 === 7, 'got='+matTap.withBonusScore10);

    const matCap = await page.evaluate((testId) => {
        recPeRubricSelectLevel(0, 'items', 'g1', 2); // 10 (児童0は空いているのでcap検証に使う)
        recPeRubricSelectLevel(0, 'items', 'g2', 2);
        recPeRubricSelectLevel(0, 'items', 'g3', 1);
        recPeRubricSelectLevel(0, 'items', 'g4', 2);
        recPeRubricSelectLevel(0, 'bonus', 'b1', 1);
        recPeRubricSelectLevel(0, 'bonus', 'b2', 1); // 合計11のはずが10にクリップ
        var sr = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        return { score10: sr.score10 };
    }, matCreated.test.id);
    check('§7.2 cap(実配線): 全項目10+加点2つ→10で頭打ち', matCap.score10 === 10, 'got='+matCap.score10);

    const realErrors = consoleErrors;
    check('ページ読み込み・全操作中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));

    await browser.close();

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
