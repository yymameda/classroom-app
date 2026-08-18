// Phase 0 (v1.14.3) 機械検証: peRecordToScore10() の実技記録0点化バグ修正 + 泳力検定換算表の差し替え
//
// peRecordToScore10() / calcWeightedScore() / KenteiPresets は grdCalculate() を包む IIFE 内部にしか
// 存在せず window には露出していない(実測済み)。window に露出しているのは grdCalculate() のみなので、
// 単体呼び出しではなく grdCalculate() 経由の結果(kItems の score10)で検証する。
// これは実際にアプリが辿る経路そのものであり、むしろ単体テストより実態に即している。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pe-score10.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
function near(a, b, eps) { return typeof a === 'number' && Math.abs(a - b) < (eps || 0.05); }

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
        // favicon.ico の404はブラウザの汎用リソースエラーで msg.text() にURLが含まれないため location().url で判定する
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    // ---- テストデータ投入 ----
    // 単位ごとに1課題・1児童のスコアを用意する。すべて subject='体育', category='知識・技能' に揃え、
    // grdCalculate('体育') の knowledgeTests に確実に拾わせる(recAddTest()と同じ isPE 前提: maxScore=9999, type='standard')。
    const now = Date.now();
    const T = {
        ten:        now + 1,  // 単位「点」: 実際に換算されるべき
        sec:        now + 2,  // 単位「秒」: 換算未対応 → null
        countNoABC: now + 3,  // 単位「回」(peManualABCなし): 換算未対応 → null
        countABC:   now + 4,  // 単位「回」(peManualABCあり、既存ロジック): 回帰確認
        meter:      now + 5,  // 単位「m」: 換算未対応 → null
        cm:         now + 6,  // 単位「cm」: 換算未対応 → null
        timeDiff:   now + 7,  // 単位「タイム差」レガシー: 既存ロジック不変を回帰確認
        timeDiffClip: now + 8, // 「タイム差」10点超クランプの回帰確認
        swim:       now + 9   // 単位「検定:swimming」: 新換算表の境界値確認
    };

    function peTest(id, name, peUnit) {
        return { id, subject: '体育', testType: '実技記録', category: '知識・技能', name: name,
                 type: 'standard', maxScore: 9999, peUnit: peUnit, date: '2026-06-01', createdAt: new Date().toISOString() };
    }

    const tests = [
        peTest(T.ten, '得点テスト', '点'),
        peTest(T.sec, '秒テスト', '秒'),
        peTest(T.countNoABC, '回数テスト(ABCなし)', '回'),
        peTest(T.countABC, '回数テスト(ABCあり)', '回'),
        peTest(T.meter, '距離テスト(m)', 'm'),
        peTest(T.cm, '距離テスト(cm)', 'cm'),
        peTest(T.timeDiff, 'タイム差テスト', 'タイム差'),
        peTest(T.timeDiffClip, 'タイム差クランプテスト', 'タイム差'),
        peTest(T.swim, '泳力検定カード', '検定:swimming')
    ];

    // 泳力検定は複数「児童」= 複数stage境界を1課題内で検証するため、studentIndex 0-12 を全部使う。
    const SWIM_STAGES = [0, 1, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 24];
    const EXPECTED_SWIM = { 0: 1, 1: 2, 6: 2, 7: 4, 12: 4, 13: 7, 14: 7, 15: 8, 16: 8, 17: 9, 18: 9, 19: 10, 24: 10 };

    const students = [];
    for (let i = 0; i < Math.max(1, SWIM_STAGES.length); i++) students.push({ name: '児童' + (i + 1) });

    const scores = [
        { testId: T.ten, studentIndex: 0, score: 8 },                       // 期待: 8
        { testId: T.sec, studentIndex: 0, score: 12.3 },                    // 期待: null(未評価)
        { testId: T.countNoABC, studentIndex: 0, score: 15 },               // 期待: null(未評価)
        { testId: T.countABC, studentIndex: 0, score: 3, peManualABC: 'A' },// 期待: 10(既存ロジック回帰)
        { testId: T.meter, studentIndex: 0, score: 4.5 },                   // 期待: null(未評価)
        { testId: T.cm, studentIndex: 0, score: 230 },                      // 期待: null(未評価)
        // peRecordToScore10() 冒頭の sr.score===null/undefined ガードは「タイム差」分岐より前にあり、
        // 既存(未変更)ロジックとして score も併せて保持している前提。finalScoreのみだと未評価扱いになる。
        { testId: T.timeDiff, studentIndex: 0, score: 7, finalScore: 7 },             // 期待: 7(既存ロジック不変)
        { testId: T.timeDiffClip, studentIndex: 0, score: 13, finalScore: 13 }        // 期待: 10(既存クランプ不変)
    ];
    SWIM_STAGES.forEach((stage, i) => { scores.push({ testId: T.swim, studentIndex: i, stage: stage }); });

    await page.evaluate(({ tests, scores, students }) => {
        // classInfo は本題(PE換算)と無関係だが、初期化コード(setYear欄への代入など)が
        // master.classInfo を無条件参照している箇所があるため、実運用相当の最小値を与えて回避する。
        StorageManager.set(KEYS.master, JSON.stringify({
            students: students,
            classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
        }));
        StorageManager.set(KEYS.tests, JSON.stringify(tests));
        StorageManager.set(KEYS.scores, JSON.stringify(scores));
    }, { tests, scores, students });

    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    const calcResults = await page.evaluate(() => grdCalculate('体育'));

    function itemFor(studentIndex, testId) {
        const r = calcResults.find(x => x.index === studentIndex);
        if (!r) return null;
        return r.knowledge.items.find(it => it.itemKey === 'k_' + testId) || null;
    }

    // ================================================================
    // 5.1: 単位「点」の正しい換算(旧BUGでは常に0だった)
    // ================================================================
    const itTen = itemFor(0, T.ten);
    check('単位「点」: score=8 → score10=8', itTen && near(itTen.score10, 8), JSON.stringify(itTen));

    // ================================================================
    // 5.1/5.2: 換算未対応単位は0点ではなくnull(未評価)。平均から除外される。
    // ================================================================
    const itSec = itemFor(0, T.sec);
    check('単位「秒」: 換算未対応のためscore10=null', itSec && itSec.score10 === null, JSON.stringify(itSec));

    const itCountNoABC = itemFor(0, T.countNoABC);
    check('単位「回」(ABCなし): 換算未対応のためscore10=null', itCountNoABC && itCountNoABC.score10 === null, JSON.stringify(itCountNoABC));

    const itMeter = itemFor(0, T.meter);
    check('単位「m」: 換算未対応のためscore10=null', itMeter && itMeter.score10 === null, JSON.stringify(itMeter));

    const itCm = itemFor(0, T.cm);
    check('単位「cm」: 換算未対応のためscore10=null', itCm && itCm.score10 === null, JSON.stringify(itCm));

    // 平均から除外されていること(knowledge.avgの計算にnullが混入して0を引きずっていないか)
    // 児童0(studentIndex=0)は SWIM_STAGES[0]=0 にも該当するため泳力検定(stage=0→1点)も持つ。
    // 知識・技能項目は 点=8, 秒=null, 回ABCなし=null, 回ABCあり=10, m=null, cm=null, タイム差=7, タイム差クランプ=10, 泳力=1
    // → 有効値は [8, 10, 7, 10, 1] の単純平均 = 36/5 = 7.2 (重み未設定なら均等)
    const r0 = calcResults.find(x => x.index === 0);
    check('知識・技能平均: 未評価項目を除いた単純平均に一致(9999除算による0点混入なし)',
        r0 && near(r0.knowledge.avg, 7.2, 0.1), 'avg=' + (r0 && r0.knowledge.avg));

    // ================================================================
    // 回帰: 単位「回」+ peManualABC の既存ロジックは不変
    // ================================================================
    const itCountABC = itemFor(0, T.countABC);
    check('単位「回」(peManualABC=A): 既存ロジックのまま10点', itCountABC && near(itCountABC.score10, 10), JSON.stringify(itCountABC));

    // ================================================================
    // 回帰: 「タイム差」レガシー経路は一切変更していない
    // ================================================================
    const itTimeDiff = itemFor(0, T.timeDiff);
    check('単位「タイム差」: finalScore=7 → score10=7(既存ロジック不変)', itTimeDiff && near(itTimeDiff.score10, 7), JSON.stringify(itTimeDiff));

    const itTimeDiffClip = itemFor(0, T.timeDiffClip);
    check('単位「タイム差」: finalScore=13 → 10点にクランプ(既存ロジック不変)', itTimeDiffClip && near(itTimeDiffClip.score10, 10), JSON.stringify(itTimeDiffClip));

    // ================================================================
    // 4.6: 泳力検定カード 新換算表の境界値
    // 仕様: 0→1 / 1-6→2 / 7-12→4 / 13-14→7 / 15-16→8 / 17-18→9 / 19-24→10
    // ================================================================
    SWIM_STAGES.forEach((stage, i) => {
        const it = itemFor(i, T.swim);
        const expected = EXPECTED_SWIM[stage];
        check('泳力検定 stage=' + stage + ' → ' + expected + '点',
            it && near(it.score10, expected), 'got=' + (it && it.score10) + ' item=' + JSON.stringify(it));
    });

    // ================================================================
    // コンソールエラーの回帰確認
    // favicon.ico の404は python3 -m http.server にfaviconが無いだけの既知ノイズ(本題と無関係)。
    // ================================================================
    const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
    check('ページ読み込み・grdCalculate実行中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));

    await browser.close();

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
