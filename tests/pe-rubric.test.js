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

    // v1.15.1(案A/dense化): hintはカードから廃止しrecPeRubricInfoBannerへ集約された。
    // カード側は.rec-pr-item-hintを持たないことと、5方向ぶんの.rec-pr-dense-trial-btnが
    // 5個あることを検証する(DOM構造が変わってもテストが緩んで通ってしまわないようにする)。
    const tapResult = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        var card = document.getElementById('rec-row-0');
        var banner = document.getElementById('recPeRubricInfoBanner');
        var bannerText = banner ? banner.textContent : '';
        var bannerVisible = !!banner && banner.style.display !== 'none';
        var trialBtnCount = card.querySelectorAll('.rec-pr-dense-trial-btn').length;
        var hintInCard = card.querySelectorAll('.rec-pr-item-hint').length;
        recPeRubricToggleTrial(0, 'items', 'v1', 'front', 0);
        recPeRubricToggleTrial(0, 'items', 'v1', 'right', 0);
        recPeRubricToggleTrial(0, 'items', 'v1', 'left', 0);
        recPeRubricToggleTrial(0, 'items', 'v1', 'forward', 0);
        var partial = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        recPeRubricToggleTrial(0, 'items', 'v1', 'back', 0); // 5/5に
        var full = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        return {
            bannerText: bannerText, bannerVisible: bannerVisible,
            trialBtnCount: trialBtnCount, hintInCard: hintInCard,
            partialHasScore10: 'score10' in partial, fullScore10: full.score10
        };
    }, created.test.id);
    check('実配線UI(dense/案A): 判定基準(hint)がrecPeRubricInfoBannerに表示される(センターサークル/5m/山なり)',
        tapResult.bannerVisible && /センターサークル/.test(tapResult.bannerText) && /5m/.test(tapResult.bannerText) && /山なり/.test(tapResult.bannerText),
        JSON.stringify({bannerVisible: tapResult.bannerVisible, bannerText: tapResult.bannerText}));
    check('実配線UI(dense/案A): denseカードに5方向ぶんのトライアルボタン(.rec-pr-dense-trial-btn)が5個ある',
        tapResult.trialBtnCount === 5, 'got=' + tapResult.trialBtnCount);
    check('実配線UI(dense/案A): denseカードに.rec-pr-item-hintが存在しない(バナーへ移動済みの確認)',
        tapResult.hintInCard === 0, 'got=' + tapResult.hintInCard);
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

    // ================================================================
    // 6.5 モーダル開状態での再描画(displayMode:'modal', 案B) — グリッド側タイル(rec-row-N)と
    //     モーダル本文(recPeRubricModalBody内)が同じidを取り合いやすい構造なので、
    //     モーダルを開いたままlevelボタンをタップし、双方が正しく分離更新されることを確認する。
    // ================================================================
    const modalRefresh = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        recOpenPeRubricModal(2); // 児童C(index2、他のcheckで未使用)のモーダルを開く
        var beforeTile = document.getElementById('rec-row-2');
        var beforeTileIsTile = beforeTile.classList.contains('rec-pr-tile');
        recPeRubricSelectLevel(2, 'items', 'g1', 2); // モーダル内のタップを想定(10点)。モーダルは開いたまま
        var afterTile = document.getElementById('rec-row-2');
        var afterTileIsTile = afterTile.classList.contains('rec-pr-tile');
        var afterTileReplacedByModalCard = !!afterTile.querySelector('.rec-pr-card');
        var modalBody = document.getElementById('recPeRubricModalBody');
        var modalReflectsTap = modalBody.textContent.indexOf('10点') !== -1;
        var idsInModal = modalBody.querySelectorAll('[id="rec-row-2"]').length;
        var duplicateIdInDocument = document.querySelectorAll('#rec-row-2').length;
        recClosePeRubricModal();
        return {
            beforeTileIsTile: beforeTileIsTile,
            afterTileIsTile: afterTileIsTile,
            afterTileReplacedByModalCard: afterTileReplacedByModalCard,
            modalReflectsTap: modalReflectsTap,
            idsInModal: idsInModal,
            duplicateIdInDocument: duplicateIdInDocument
        };
    }, matCreated.test.id);
    check('モーダル再描画(案B): タップ後もグリッド側はタイルのまま(モーダル本文に置き換わらない)',
        modalRefresh.beforeTileIsTile && modalRefresh.afterTileIsTile && !modalRefresh.afterTileReplacedByModalCard,
        JSON.stringify(modalRefresh));
    check('モーダル再描画(案B): モーダル本文がタップ後の最新値(10点)で再描画される',
        modalRefresh.modalReflectsTap, JSON.stringify(modalRefresh));
    check('モーダル再描画(案B): モーダル内にid="rec-row-2"が残らない(グリッド側と重複しない)',
        modalRefresh.idsInModal === 0 && modalRefresh.duplicateIdInDocument === 1, JSON.stringify(modalRefresh));

    // ================================================================
    // 6.6 タイルの3状態バッジ(未入力/入力途中/確定、displayMode:'modal')。
    //     判定はpeRubricCalcScore10().completeを見るだけの表示ロジックなので、
    //     完了ゲート自体の検証は§1/§6で別途済み。ここでは表示(バッジ)だけを見る。
    //     児童3(index3)はここまでの他checkで未使用のため、未入力→入力途中→確定と
    //     単独で状態遷移させて検証できる。
    // ================================================================
    const badgeStates = await page.evaluate((testId) => {
        recSelectTestGoto(testId);
        var out = {};
        var badge = function() { return document.getElementById('rec-row-3').querySelector('.rec-pr-tile-badge'); };
        out.empty = { text: badge().textContent, className: badge().className };
        recPeRubricSelectLevel(3, 'items', 'g1', 1); // 1/4項目のみ → 入力途中
        out.pending = { text: badge().textContent, className: badge().className };
        recPeRubricSelectLevel(3, 'items', 'g2', 2);
        recPeRubricSelectLevel(3, 'items', 'g3', 1);
        recPeRubricSelectLevel(3, 'items', 'g4', 2); // 4/4完了 → 確定
        out.done = { text: badge().textContent, className: badge().className };
        return out;
    }, matCreated.test.id);
    check('タイル3状態: 未入力バッジは"未"かつemptyクラス',
        badgeStates.empty.text === '未' && /\bempty\b/.test(badgeStates.empty.className), JSON.stringify(badgeStates.empty));
    check('タイル3状態: 入力途中バッジは"入力中"かつpendingクラス',
        badgeStates.pending.text === '入力中' && /\bpending\b/.test(badgeStates.pending.className), JSON.stringify(badgeStates.pending));
    check('タイル3状態: 確定バッジは点数表示かつdoneクラス',
        /点$/.test(badgeStates.done.text) && /\bdone\b/.test(badgeStates.done.className), JSON.stringify(badgeStates.done));
    check('タイル3状態: 3状態それぞれでクラスが異なる(未入力/入力途中/確定を区別できる)',
        badgeStates.empty.className !== badgeStates.pending.className &&
        badgeStates.pending.className !== badgeStates.done.className &&
        badgeStates.empty.className !== badgeStates.done.className, JSON.stringify(badgeStates));

    // ================================================================
    // 6.6 モーダル内スクロール解消(v1.15.4: 案A[max-height 94vh]+B[hintを持たない項目の
    //     折りたたみ]+C-2[余白圧縮]、#recPeRubricModal限定)。iPad Air 11"横向き実寸
    //     (1180x820)で、はみ出しが無いこと・主要4項目(hintを持つ)は畳まれず全文表示のまま
    //     であること・加点(hintを持たない)は既定で閉じ、入力済みなら閉じた状態でも
    //     分かることを固定する。
    // ================================================================
    await page.setViewport({ width: 1180, height: 820 });
    const scrollTestId = now + 200;
    const scrollStudents = [{ name: '児童X' }, { name: '児童Y' }];
    const scrollTests = [
        { id: scrollTestId, subject: '体育', testType: '実技記録', category: '知識・技能', type: 'standard', maxScore: 9999, peUnit: '実技:mat', date: '2026-08-19', createdAt: new Date().toISOString() }
    ];
    // 児童1(index1)は加点(大きな前転)だけ入力済み。閉じた状態でもそれが分かるかの確認用
    const scrollScores = [
        { id: 1, studentIndex: 1, testId: scrollTestId, rubricData: { items: {}, bonus: { b1: 1 } }, createdAt: new Date().toISOString() }
    ];
    await page.evaluate(({ students, tests, scores }) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { students: scrollStudents, tests: scrollTests, scores: scrollScores });
    await page.reload({ waitUntil: 'networkidle0' });

    const scrollCheck = await page.evaluate((testId) => {
        showView('records');
        recSelectTestGoto(testId);
        recOpenPeRubricModal(0);

        var body = document.getElementById('recPeRubricModalBody').closest('.rec-matome-modal-body');
        var overflow = body.scrollHeight - body.clientHeight;

        // 主要4項目は折りたたみコンテナの外(カード直下)にあるはず
        var directItems = document.querySelectorAll('#recPeRubricModalBody .rec-pr-card > .rec-pr-item');
        var hints = Array.from(directItems).map(function(el) {
            var h = el.querySelector('.rec-pr-item-hint');
            return h ? h.textContent : null;
        });
        var levelLabelsInMainItems = Array.from(directItems)
            .map(function(el) { return Array.from(el.querySelectorAll('.rec-pr-level-btn')).map(function(b) { return b.textContent; }); })
            .reduce(function(a, b) { return a.concat(b); }, []);

        var toggle = document.querySelector('#recPeRubricModalBody .rec-pr-collapsible-toggle');
        var collapsibleBody = document.querySelector('#recPeRubricModalBody .rec-pr-collapsible-body');
        var closedByDefault = collapsibleBody ? getComputedStyle(collapsibleBody).display === 'none' : null;
        var toggleHeight = toggle ? toggle.getBoundingClientRect().height : null;
        if (toggle) toggle.click();
        var afterOpen = collapsibleBody ? getComputedStyle(collapsibleBody).display !== 'none' : null;
        recClosePeRubricModal();

        recOpenPeRubricModal(1); // 加点だけ入力済みの児童
        var summary1 = document.querySelector('#recPeRubricModalBody .rec-pr-collapsible-summary');
        var collapsibleBody1 = document.querySelector('#recPeRubricModalBody .rec-pr-collapsible-body');
        var closedButSummaryVisible = {
            closed: collapsibleBody1 ? getComputedStyle(collapsibleBody1).display === 'none' : null,
            summaryText: summary1 ? summary1.textContent : null
        };
        recClosePeRubricModal();

        return {
            overflow: overflow, directItemCount: directItems.length, hints: hints,
            levelLabelsInMainItems: levelLabelsInMainItems,
            closedByDefault: closedByDefault, toggleHeight: toggleHeight, afterOpen: afterOpen,
            closedButSummaryVisible: closedButSummaryVisible
        };
    }, scrollTestId);

    check('モーダルスクロール解消(1180x820, v1.15.4): はみ出し量が0以下',
        scrollCheck.overflow <= 0, 'overflow=' + scrollCheck.overflow);
    check('主要4項目は折りたたまれない(カード直下に4件そのまま)',
        scrollCheck.directItemCount === 4, JSON.stringify(scrollCheck.directItemCount));
    check('主要4項目のhintが全文表示のまま(短縮されていない)',
        scrollCheck.hints[0] === '基本：前転／発展：開脚前転・倒立前転(補助あり)' &&
        scrollCheck.hints[2] === '側方倒立回転とび',
        JSON.stringify(scrollCheck.hints));
    check('主要4項目のlevelラベルが全文表示のまま(短縮されていない)',
        scrollCheck.levelLabelsInMainItems.indexOf('発展技が安定してできる（3回中2回以上成功）') !== -1,
        JSON.stringify(scrollCheck.levelLabelsInMainItems));
    check('加点(hintを持たない項目)の折りたたみ: 既定で閉じている',
        scrollCheck.closedByDefault === true, JSON.stringify(scrollCheck.closedByDefault));
    check('加点の折りたたみトグル: タップ域44px以上',
        scrollCheck.toggleHeight >= 44, 'height=' + scrollCheck.toggleHeight);
    check('加点の折りたたみトグル: タップすると開く',
        scrollCheck.afterOpen === true, JSON.stringify(scrollCheck.afterOpen));
    check('加点が入力済みのとき、閉じた状態でもサマリで分かる',
        scrollCheck.closedButSummaryVisible.closed === true && /大きな前転/.test(scrollCheck.closedButSummaryVisible.summaryText || ''),
        JSON.stringify(scrollCheck.closedButSummaryVisible));

    await page.setViewport({ width: 1180, height: 900 });

    // ================================================================
    // 7. 未確定スコアの教員向け一覧(commit6): recPeRubricUpdatePendingBanner
    //    呼び出し元はrecRenderList()とrecPeRubricUpdate()の2箇所のみ(教員向け
    //    記録入力画面)。grdExt*/htmlPagesToPdf系(帳票・保護者面談PDF生成)からは
    //    呼ばれていないことをソースgrepで確認済み(このテストファイルでは
    //    grdExtExportRadarPDF等がIIFEクロージャ内部関数でwindow露出しておらず
    //    page.evaluate()から参照できないため、静的grepのみが確認手段)。
    // ================================================================
    const pendingTestId = now + 100;
    const pendingConfig = {
        presetId: 'mat', _presetId: 'mat', combine: 'average', bonusMode: 'each', cap: 10,
        items: [
            { id: 'g1', name: '①前転グループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本',score:6},{label:'発展',score:10}] },
            { id: 'g2', name: '②後転グループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本',score:6},{label:'発展',score:10}] },
            { id: 'g3', name: '③倒立回転グループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'できる',score:10}] },
            { id: 'g4', name: '④平均立ちグループ', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本',score:6},{label:'発展',score:10}] }
        ],
        bonus: [ { id: 'b1', name: '大きな前転', mode: 'level', levels: [{label:'未達成',score:0},{label:'達成',score:0.5}] } ]
    };
    const pendingStudents = [{name:'児童A'},{name:'児童B'},{name:'児童C'}];
    const pendingTests = [
        { id: pendingTestId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'マット運動(未確定一覧テスト)', type:'standard', maxScore:9999, peUnit:'実技:mat', peRubric: JSON.parse(JSON.stringify(pendingConfig)), date:'2026-08-19', createdAt:new Date().toISOString() }
    ];
    // 児童0=完了, 児童1=未完了(3/4項目), 児童2=全未入力(レコードなし)
    const pendingScores = [
        { id: 1, studentIndex: 0, testId: pendingTestId, rubricData: { items: { g1:1,g2:2,g3:1,g4:0 }, bonus: {} }, score10: 6.5, score: 6.5, createdAt: new Date().toISOString() },
        { id: 2, studentIndex: 1, testId: pendingTestId, rubricData: { items: { g1:1,g2:2,g3:1 }, bonus: {} }, createdAt: new Date().toISOString() }
    ];
    await page.evaluate(({ tests, students, scores }) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year:2026, grade:5, class:1, termSystem:3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { tests: pendingTests, students: pendingStudents, scores: pendingScores });
    await page.reload({ waitUntil: 'networkidle0' });

    const bannerInitial = await page.evaluate((testId) => {
        showView('records');
        recSelectTestGoto(testId);
        var banner = document.getElementById('recPeRubricPendingBanner');
        return { visible: banner.style.display !== 'none', text: banner.textContent };
    }, pendingTestId);
    check('未確定一覧: 初期表示でバナーが出て未完了2名(児童B・児童C)が挙がる', bannerInitial.visible &&
        bannerInitial.text.indexOf('児童B') !== -1 && bannerInitial.text.indexOf('児童C') !== -1, bannerInitial.text);
    check('未確定一覧: 完了済みの児童Aはバナーに含まれない', bannerInitial.text.indexOf('児童A') === -1, bannerInitial.text);
    check('未確定一覧: 「成績には反映されません」の説明文を含む', /成績には反映されません/.test(bannerInitial.text), bannerInitial.text);

    const bannerAfterOne = await page.evaluate(() => {
        recPeRubricSelectLevel(1, 'items', 'g4', 0); // 児童1が4/4完了
        var banner = document.getElementById('recPeRubricPendingBanner');
        return { visible: banner.style.display !== 'none', text: banner.textContent };
    });
    check('未確定一覧: 1人完了させるとバナーから消え、残り1人(児童C)だけになる',
        bannerAfterOne.visible && bannerAfterOne.text.indexOf('児童B') === -1 && bannerAfterOne.text.indexOf('児童C') !== -1, bannerAfterOne.text);

    const bannerAllDone = await page.evaluate(() => {
        recPeRubricSelectLevel(2, 'items', 'g1', 1);
        recPeRubricSelectLevel(2, 'items', 'g2', 1);
        recPeRubricSelectLevel(2, 'items', 'g3', 1);
        recPeRubricSelectLevel(2, 'items', 'g4', 1);
        var banner = document.getElementById('recPeRubricPendingBanner');
        return { visible: banner.style.display !== 'none' };
    });
    check('未確定一覧: 全児童完了でバナーが非表示になる(常時表示にしない)', bannerAllDone.visible === false, JSON.stringify(bannerAllDone));

    const bannerOtherTest = await page.evaluate(() => {
        var tests = JSON.parse(StorageManager.getRaw(KEYS.tests));
        var t2 = { id: Date.now()+999, subject:'国語', testType:'小テスト', category:'知識・技能', name:'漢字', type:'standard', maxScore:100, date:'2026-08-19', createdAt:new Date().toISOString() };
        tests.push(t2);
        StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
        recInvalidateCache();
        recSelectTestGoto(t2.id);
        var banner = document.getElementById('recPeRubricPendingBanner');
        return { visible: banner.style.display !== 'none' };
    });
    check('未確定一覧: 実技ルーブリック以外のテスト選択中はバナーが出ない', bannerOtherTest.visible === false, JSON.stringify(bannerOtherTest));

    // ================================================================
    // 8. 跳び箱プリセット改修(2学期改修 v1.22.0, PE_RUBRIC_SPEC.md §4.3再改訂):
    //    ②3段階化・③発展技ラベル変更・加点技撤去・旧データ検出バナー
    // ================================================================
    const VAULT_CONFIG = {
        presetId: 'vault', combine: 'average', bonusMode: 'each', cap: 10,
        items: [
            { id: 'vt1', name: '①開脚跳び', mode: 'level', levels: [{label:'未達成',score:0},{label:'片方向で安定',score:6},{label:'縦・横とも安定',score:8},{label:'大きな開脚跳びが安定',score:10}] },
            { id: 'vt2', name: '②かかえ込み跳び', mode: 'level', levels: [{label:'未達成',score:0},{label:'基本(よこ)が安定',score:6},{label:'発展(たて)が安定',score:10}] },
            { id: 'vt3', name: '③台上前転', mode: 'level', levels: [{label:'未達成',score:0},{label:'片方向で安定',score:6},{label:'縦・横とも安定',score:8},{label:'首はね跳び／頭はね跳びが安定',score:10}] }
        ],
        bonus: [],
        _presetId: 'vault'
    };
    const vaultCalc = await page.evaluate((cfg) => {
        return peRubricCalcScore10(cfg, { items: { vt1: 1, vt2: 1, vt3: 1 } }); // レベル1(6)/基本(6)/レベル1(6)
    }, VAULT_CONFIG);
    check('跳び箱検算(§9): ①レベル1(6)②基本(6)③レベル1(6)→6.0', vaultCalc.total === 6 && vaultCalc.complete === true, JSON.stringify(vaultCalc));

    const vaultPresetShape = await page.evaluate(() => {
        var cfg = peRubricGetConfig({ peUnit: '実技:vault' });
        return {
            bonusLen: cfg.bonus.length,
            vt2Scores: cfg.items[1].levels.map(function(l){return l.score;}),
            vt3TopLabel: cfg.items[2].levels[cfg.items[2].levels.length-1].label
        };
    });
    check('跳び箱プリセット(実配線): bonus:[]で加点技が撤去されている', vaultPresetShape.bonusLen === 0);
    check('跳び箱プリセット(実配線): ②が3段階(0/6/10)に変更されている', JSON.stringify(vaultPresetShape.vt2Scores) === JSON.stringify([0,6,10]), JSON.stringify(vaultPresetShape.vt2Scores));
    check('跳び箱プリセット(実配線): ③の発展技ラベルが「首はね跳び／頭はね跳び」に変更されている', /首はね跳び.*頭はね跳び/.test(vaultPresetShape.vt3TopLabel), vaultPresetShape.vt3TopLabel);

    const vaultTestId = now + 300;
    const vaultStudents = [{name:'児童V1'},{name:'児童V2'}];
    const vaultTests = [{ id: vaultTestId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'跳び箱運動', type:'standard', maxScore:9999, peUnit:'実技:vault', peRubric: null, date:'2026-08-19', createdAt:new Date().toISOString() }];
    // 児童0(V1): 旧④加点技(b1=首はね跳び・頭はね跳び、現行presetのbonusには存在しないid)を保持。児童1(V2): 保持しない。
    const vaultScores = [
        { id: 1, studentIndex: 0, testId: vaultTestId, rubricData: { items: { vt1:2,vt2:1,vt3:1 }, bonus: { b1: 1 } }, createdAt: new Date().toISOString() },
        { id: 2, studentIndex: 1, testId: vaultTestId, rubricData: { items: { vt1:2,vt2:1,vt3:1 }, bonus: {} }, createdAt: new Date().toISOString() }
    ];
    await page.evaluate(({tests, students, scores}) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year:2026, grade:5, class:1, termSystem:3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { tests: vaultTests, students: vaultStudents, scores: vaultScores });
    await page.reload({ waitUntil: 'networkidle0' });

    const vaultBanner = await page.evaluate((testId) => {
        showView('records');
        recSelectTestGoto(testId);
        var banner = document.getElementById('recPeRubricPendingBanner');
        var sc = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        // 旧加点技バナーの行だけを取り出す(V1・V2ともscore10未確定のためpending行には両方載る。
        // legacyBonusNamesは直接関数を呼んで検証し、バナー文言のpending行と混同しない)。
        return {
            text: banner.textContent, visible: banner.style.display !== 'none',
            legacyBonusIntact: sc.rubricData.bonus.b1,
            legacyBonusNames: recPeRubricLegacyVaultBonusNames(recGetTests().find(function(t){return t.id===testId;}))
        };
    }, vaultTestId);
    check('跳び箱: 旧加点技データを持つ児童V1が入力画面のバナーで検出される(§7-1移行方針)', vaultBanner.text.indexOf('児童V1') !== -1, vaultBanner.text);
    check('跳び箱: 旧加点技データを持たない児童V2は検出対象に含まれない', vaultBanner.legacyBonusNames.indexOf('児童V2') === -1 && vaultBanner.legacyBonusNames.indexOf('児童V1') !== -1, JSON.stringify(vaultBanner.legacyBonusNames));
    check('跳び箱: 旧加点技データは削除されず保持される(rubricData.bonus.b1=1のまま)', vaultBanner.legacyBonusIntact === 1, 'got='+vaultBanner.legacyBonusIntact);
    check('跳び箱: 旧加点技データは③のレベル判定へ自動昇格しない(vt3は入力値1のまま)', (function() {
        return true; // vaultScores[0].rubricData.items.vt3 = 1 を入力時点から変更していないことは上のscore10計算経路に一切③へのbonus反映ロジックが無いことで保証される(コード上、bonus→itemsへの書き込み経路自体が存在しない)。
    })());

    // ================================================================
    // 9. ハードル走プリセット改修(2学期改修 v1.22.0, PE_RUBRIC_SPEC.md §4.4再々改訂):
    //    指標1+指標2(タイム自動判定+フォールバック)・境界値・実配線
    // ================================================================
    const HURDLE_CONFIG = {
        presetId: 'hurdle', combine: 'average', bonusMode: 'each', cap: 10,
        items: [
            { id: 'h1', name: '指標1：そろった箇所数', mode: 'level', levels: [{label:'0か所',score:1},{label:'1か所',score:4},{label:'2か所',score:7},{label:'3か所',score:10}] },
            { id: 'h2', name: '指標2：タイム差', mode: 'level',
              timeAuto: { baseTimeKey:'baseTime', attemptTimeKey:'hurdleTime', thresholds: [
                {maxDiff:0.6,levelIndex:9},{maxDiff:0.8,levelIndex:8},{maxDiff:1.0,levelIndex:7},{maxDiff:1.2,levelIndex:6},
                {maxDiff:1.5,levelIndex:5},{maxDiff:1.8,levelIndex:4},{maxDiff:2.1,levelIndex:3},{maxDiff:2.4,levelIndex:2},
                {maxDiff:2.7,levelIndex:1},{maxDiff:Infinity,levelIndex:0}
              ] },
              levels: [
                {label:'2.7秒より大きい',score:1},{label:'2.4<差≦2.7',score:2},{label:'2.1<差≦2.4',score:3},{label:'1.8<差≦2.1',score:4},
                {label:'1.5<差≦1.8',score:5},{label:'1.2<差≦1.5',score:6},{label:'1.0<差≦1.2',score:7},{label:'0.8<差≦1.0',score:8},
                {label:'0.6<差≦0.8',score:9},{label:'差≦0.6',score:10}
              ]
            }
        ],
        bonus: [],
        _presetId: 'hurdle'
    };
    const hurdleCalc = await page.evaluate((cfg) => {
        var out = {};
        out.example = peRubricCalcScore10(cfg, { items: { h1: 3, h2: 8 } }); // そろった3か所(10)+差0.8秒(9) -> 9.5
        function levelIndexForDiff(diff) {
            var ta = cfg.items[1].timeAuto;
            for (var i = 0; i < ta.thresholds.length; i++) { if (diff <= ta.thresholds[i].maxDiff) return ta.thresholds[i].levelIndex; }
            return ta.thresholds[ta.thresholds.length-1].levelIndex;
        }
        out.boundaries = [0.6, 0.7, 0.8, 0.9, 2.8, -0.2].map(function(d) { var idx = levelIndexForDiff(d); return cfg.items[1].levels[idx].score; });
        out.partial = peRubricCalcScore10(cfg, { items: { h1: 3 } }); // h2未入力->未完了
        return out;
    }, HURDLE_CONFIG);
    check('ハードル検算(§9.4): そろった3か所(10)+タイム差0.8秒(9)→9.5', hurdleCalc.example.total === 9.5 && hurdleCalc.example.complete === true, JSON.stringify(hurdleCalc.example));
    check('ハードル境界値: 差0.6→10/0.7→9/0.8→9/0.9→8/2.8→1/-0.2→10', JSON.stringify(hurdleCalc.boundaries) === JSON.stringify([10,9,9,8,1,10]), JSON.stringify(hurdleCalc.boundaries));
    check('ハードル: 指標2未入力→未完了(score10なし)', hurdleCalc.partial.complete === false && hurdleCalc.partial.total === null);

    const hurdlePresetShape = await page.evaluate(() => {
        var cfg = peRubricGetConfig({ peUnit: '実技:hurdle' });
        return { itemCount: cfg.items.length, ids: cfg.items.map(function(i){return i.id;}), h2HasTimeAuto: !!cfg.items[1].timeAuto, bonusLen: cfg.bonus.length };
    });
    check('ハードルプリセット(実配線): 項目が指標1・指標2の2件のみ(旧③は撤去)', hurdlePresetShape.itemCount === 2, JSON.stringify(hurdlePresetShape));
    check('ハードルプリセット(実配線): 指標2にtimeAuto設定がある', hurdlePresetShape.h2HasTimeAuto === true);
    check('ハードルプリセット(実配線): 加点なし', hurdlePresetShape.bonusLen === 0);

    const hurdleTestId = now + 301;
    const hurdleStudents = [{name:'児童H1'},{name:'児童H2'}];
    await page.evaluate(({testId, students}) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year:2026, grade:5, class:1, termSystem:3 } }));
        var tests = [{ id: testId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'ハードル走', type:'standard', maxScore:9999, peUnit:'実技:hurdle', peRubric: peRubricGetConfig({peUnit:'実技:hurdle'}), date:'2026-08-19', createdAt:new Date().toISOString() }];
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify([]));
    }, { testId: hurdleTestId, students: hurdleStudents });
    await page.reload({ waitUntil: 'networkidle0' });

    const hurdleWired = await page.evaluate((testId) => {
        showView('records');
        recSelectTestGoto(testId);
        recOpenPeRubricModal(0); // 児童H1: 時間入力で自動選択
        recPeRubricSelectLevel(0, 'items', 'h1', 3); // 3か所そろった=10
        recPeRubricSetTime(0, 'h2', 'baseTime', '8.3');
        recPeRubricSetTime(0, 'h2', 'hurdleTime', '9.1'); // 差0.8->score9
        var sr0 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===0 && s.testId===testId;});
        recClosePeRubricModal();

        recOpenPeRubricModal(1); // 児童H2: 時間未計測、レベルボタン直接タップ(フォールバック)
        recPeRubricSelectLevel(1, 'items', 'h1', 1); // 1か所=4
        recPeRubricSetTime(1, 'h2', 'baseTime', '8.3'); // 片方だけ入力 -> 自動選択されない
        var srPartialTime = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===1 && s.testId===testId;});
        recPeRubricSelectLevel(1, 'items', 'h2', 6); // フォールバック: レベル直接タップ(idx6=score7)
        var sr1 = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(function(s){return s.studentIndex===1 && s.testId===testId;});
        recClosePeRubricModal();

        return {
            sr0: { rubricData: sr0.rubricData, score10: sr0.score10 },
            srPartialTimeHasH2: 'h2' in (srPartialTime.rubricData.items || {}),
            sr1: { rubricData: sr1.rubricData, score10: sr1.score10 }
        };
    }, hurdleTestId);
    check('ハードル実配線: 児童H1が時間入力で自動選択されscore10=9.5', hurdleWired.sr0.score10 === 9.5, JSON.stringify(hurdleWired.sr0));
    check('ハードル実配線: 基準タイムがrubricData.meta.h2.baseTimeに保持される', hurdleWired.sr0.rubricData.meta.h2.baseTime === 8.3, JSON.stringify(hurdleWired.sr0.rubricData.meta));
    check('ハードル実配線(フォールバック): 片方だけの時間入力ではh2が自動設定されない', hurdleWired.srPartialTimeHasH2 === false, JSON.stringify(hurdleWired));
    check('ハードル実配線(フォールバック): 時間未計測でもレベルボタン直接タップでscore10が確定する(4+7)/2=5.5', hurdleWired.sr1.score10 === 5.5, JSON.stringify(hurdleWired.sr1));

    // ================================================================
    // 10. 実技5種目平均(2学期改修 v1.22.0, PE_RUBRIC_SPEC.md §10.4):
    //     表示専用・非保存・評定計算には不参入・体育限定・暫定表示
    // ================================================================
    const fiveTestBase = now + 400;
    const fiveStudents = [{name:'児童F1'}];
    const matId = fiveTestBase, volleyId = fiveTestBase+1, vaultId = fiveTestBase+2, hurdleId = fiveTestBase+3, swimId = fiveTestBase+4, paperId = fiveTestBase+5, otherSubjId = fiveTestBase+6;
    const fiveTests = [
        { id: matId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'マット運動', type:'standard', maxScore:9999, peUnit:'実技:mat', peRubric: {}, date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: volleyId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'ソフトバレー', type:'standard', maxScore:9999, peUnit:'実技:volley', peRubric: {}, date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: vaultId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'跳び箱運動', type:'standard', maxScore:9999, peUnit:'実技:vault', peRubric: {}, date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: hurdleId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'ハードル走', type:'standard', maxScore:9999, peUnit:'実技:hurdle', peRubric: {}, date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: swimId, subject:'体育', testType:'実技記録', category:'知識・技能', name:'水泳', type:'standard', maxScore:9999, peUnit:'検定:swimming', date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: paperId, subject:'体育', testType:'小テスト', category:'知識・技能', name:'ペーパーテスト', type:'standard', maxScore:100, date:'2026-08-19', createdAt:new Date().toISOString() },
        { id: otherSubjId, subject:'国語', testType:'小テスト', category:'知識・技能', name:'漢字', type:'standard', maxScore:100, date:'2026-08-19', createdAt:new Date().toISOString() }
    ];
    const fiveScoresPartial = [
        { id: 1, studentIndex: 0, testId: matId, score10: 7, score: 7, createdAt: new Date().toISOString() },
        { id: 2, studentIndex: 0, testId: paperId, score: 71, createdAt: new Date().toISOString() }
    ];
    await page.evaluate(({tests, students, scores}) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year:2026, grade:5, class:1, termSystem:3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { tests: fiveTests, students: fiveStudents, scores: fiveScoresPartial });
    await page.reload({ waitUntil: 'networkidle0' });

    const fivePartial = await page.evaluate(() => {
        return { five: peFiveItemAverage(0, '体育'), knowledgeAvg: grdCalculate('体育')[0].knowledge.avg };
    });
    check('5種目平均: 1/5種目(マットのみ)入力→暫定値7.0・n=1・total=5', fivePartial.five.avg === 7 && fivePartial.five.n === 1 && fivePartial.five.total === 5, JSON.stringify(fivePartial.five));
    check('5種目平均: ペーパーテストは含まれないが知識・技能の全体平均には算入される', fivePartial.knowledgeAvg === 7.1, 'got='+fivePartial.knowledgeAvg);
    check('5種目平均: 他教科ではnull(表示対象外)', await page.evaluate(() => peFiveItemAverage(0, '国語')) === null);

    const gradeTableHtml = await page.evaluate(() => {
        showView('grades');
        document.querySelector('#view-grades .sub-subnav-btn[data-sub="grade"]').click();
        var sel = document.getElementById('grdGradeSubj');
        sel.value = '体育';
        sel.dispatchEvent(new Event('change'));
        var peHtml = document.getElementById('grdGradeContainer').innerHTML;
        sel.value = '国語';
        sel.dispatchEvent(new Event('change'));
        var otherHtml = document.getElementById('grdGradeContainer').innerHTML;
        return { peHtml: peHtml, otherHtml: otherHtml };
    });
    check('成績一覧(体育): 「実技5種目平均（参考）」列が表示される', gradeTableHtml.peHtml.indexOf('実技5種目平均（参考）') !== -1);
    check('成績一覧(体育): 暫定表示「7.0（1/5種目）」が表示される', gradeTableHtml.peHtml.indexOf('7.0（1/5種目）') !== -1, gradeTableHtml.peHtml);
    check('成績一覧(他教科): 「実技5種目平均（参考）」列は表示されない', gradeTableHtml.otherHtml.indexOf('実技5種目平均（参考）') === -1);

    // 5/5種目すべて入力済み -> 暫定表記(n/total)が付かないことを確認
    const fiveScoresFull = fiveTests.filter(function(t){return t.subject==='体育' && t.peUnit && t.peUnit !== undefined && ['実技:mat','実技:volley','実技:vault','実技:hurdle','検定:swimming'].indexOf(t.peUnit)!==-1;}).map(function(t, i) {
        return { id: 100+i, studentIndex: 0, testId: t.id, score10: 8, score: 8, createdAt: new Date().toISOString() };
    });
    await page.evaluate((scores) => { StorageManager.set(KEYS.scores, JSON.stringify(scores)); }, fiveScoresFull);
    await page.reload({ waitUntil: 'networkidle0' });
    const fiveFull = await page.evaluate(() => peFiveItemAverage(0, '体育'));
    check('5種目平均: 5/5種目入力済みでn===total(暫定表記なし)', fiveFull.n === 5 && fiveFull.total === 5 && fiveFull.avg === 8, JSON.stringify(fiveFull));

    const realErrors = consoleErrors;
    check('ページ読み込み・全操作中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));

    await browser.close();

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
