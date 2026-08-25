// 成績換算ロジック 機械検証（段階0、成績入力形式統一プロジェクトの前提整備）
//
// 旧 test_grades.js は abcTo10 等を index.html からファイル内に「手動コピー」して
// 単体検証していたが、実装側の変更（A/B+/B/B-/C の5段階拡張）に追随できず、
// 気づかれないまま乖離していた（コピー側は A/B/C の3段階のままだった）。
// tests/README.md の方針（ロジック切り出しをせず index.html をそのまま動かす）に
// 合わせ、puppeteer-core で実ページを操作し、window に公開された実装関数
// （grdCalculate / grdGetCurrentTerm）を経由して実装本体を直接検証する方式に
// 書き換える。以後の「成績入力形式の全アプリ標準化」作業（段階1〜8）は、
// このファイルが abcTo10 等の換算値を守るという前提で進める。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node test_grades.js
//
// --- 今回のスコープ外（意図的に検証しないもの。理由を明記） ---
// - nawatobiToScore10: コメント(index.html 7641, 7720)により
//   kenteiConfig の conversionTable へ「写経」済みで、呼び出し箇所が
//   コード中に存在しない（実質的に死んでいる）。実際に使われている
//   なわとび/泳力の換算表は pe-score10.test.js が検証済み。
// - grdGetTermRange: 定義(index.html 14992)はあるが、実際の呼び出し箇所が
//   コメント中の言及以外に見つからない（未使用）。
// - calcPfEval/convertEval（新体力テストのA〜E 5段階）: abcTo10とは無関係の
//   別系統（今回の「A/B+/B/B-/C」統一の対象外と既に確認済み）。
// - calcWeightedScore の「itemにweightフィールドが無い(undefined)場合は
//   w=0扱いにする」という分岐: grdCalculate は必ず grdGetItemWeight() で
//   数値化した weight を各itemに付けてから calcWeightedScore に渡すため、
//   実運用経路では発生しない（純粋関数としての境界仕様であり、実データ
//   経由では再現できない）。
// - grdGetCurrentTerm の2学期制(termSystem=2)の境界: 今回は3学期制のみ検証。
//
// これらは「実装から呼べないので検証しない」であって、「削除してよい」
// という判断ではない。将来これらの関数が実際に呼ばれるようになった場合は
// 別途検証を追加すること。

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
function near(a, b, eps) { return typeof a === 'number' && Math.abs(a - b) < (eps || 0.05); }

async function setMockDate(page, ts) {
    await page.evaluate((fixed, enable) => {
        if (!window.__RealDate) window.__RealDate = Date;
        if (!enable) { window.Date = window.__RealDate; return; }
        const RealDate = window.__RealDate;
        class MockDate extends RealDate {
            constructor(...args) {
                if (args.length === 0) return new RealDate(fixed);
                return new RealDate(...args);
            }
            static now() { return fixed; }
        }
        window.Date = MockDate;
    }, ts || 0, ts !== null && ts !== undefined);
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
        // favicon.ico の404は python3 -m http.server にfaviconが無いだけの既知ノイズ。
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    // ---- 実データキーの退避（tests/README.md「確立済みノウハウ」に従う） ----
    const REAL_KEYS = await page.evaluate(() => ({
        master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores,
        gradesExternal: KEYS.grades_external, gradeWeights: KEYS.grade_weights
    }));
    async function getKey(k) { return page.evaluate((kk) => StorageManager.getRaw(kk), k); }
    async function setKey(k, v) { await page.evaluate((kk, vv) => { StorageManager.setImmediate(kk, vv); }, k, v); }
    async function restoreKey(k, raw) {
        if (raw === null || raw === undefined) await page.evaluate((kk) => { StorageManager.remove(kk); }, k);
        else await setKey(k, raw);
    }
    const backup = {};
    for (const k of Object.values(REAL_KEYS)) backup[k] = await getKey(k);

    try {
        const now = Date.now();

        // 学級名簿は10名。教科が異なれば集計は独立するため、同じ studentIndex を
        // 別教科のケースで使い回しても互いに汚染しない。idx8/9はrecSaveAllScores検証専用
        // (国語の他ケースと同じ知識・技能カテゴリだが、既存のkAvg集計を汚染しないよう
        // 新規テスト・新規studentIndexで完全に分離する)。
        const students = [];
        for (let i = 0; i < 10; i++) students.push({ name: '児童' + (i + 1) });

        function T(id, subject, category, testType, maxScore, extra) {
            return Object.assign({ id, subject, category, testType, type: 'standard', maxScore, date: '2026-06-01', createdAt: new Date().toISOString() }, extra || {});
        }

        const ID = {
            houtei5: now + 1,                          // 家庭: abcTo10 5段階の実値そのもの
            jpBoundary: now + 2, jpClamp: now + 3, jpNegative: now + 4, // 国語: scoreTo10/score10ToABC境界
            mathK: now + 5, mathT: now + 6, mathA: now + 7,             // 算数: abcToNum/最終評定
            scienceW1: now + 8, scienceW2: now + 9,                     // 理科: calcWeightedScore(重み付き)
            socialZ1: now + 10, socialZ2: now + 11, socialSolo: now + 12, // 社会: 全重み0/null除外
            peAttitude: now + 13, pePractical: now + 14,                // 体育: 授業態度記号 / peManualABC直書き
            jpValidate: now + 15,                                       // 国語: recSaveAllScores(段階1)の範囲外拒否
            // 段階2: 得点セルの「／満点 (割合%)」表示
            pctNormal: now + 16,   // 通常テスト: 端数を含む割合の丸め確認(13/15→87%)
            pctNoMax: now + 17,    // maxScore=0(通常テストの異常系)→割合を出さない
            pctMarker: now + 18,   // maxScore=9999(実技記録の変換不要マーカー)→割合を出さない
            pctMatome: now + 19    // まとめテスト: 満点が設問配点合計(3点)の小さいケース
        };

        const tests = [
            T(ID.houtei5, '家庭', '主体性', 'ルーブリック', 0),
            T(ID.jpBoundary, '国語', '知識・技能', '小テスト', 100),
            T(ID.jpClamp, '国語', '知識・技能', '授業課題', 100),
            T(ID.jpNegative, '国語', '知識・技能', '授業課題', 100),
            T(ID.mathK, '算数', '知識・技能', '小テスト', 0),
            T(ID.mathT, '算数', '思考・判断・表現', '小テスト', 0),
            T(ID.mathA, '算数', '主体性', 'ルーブリック', 0),
            T(ID.scienceW1, '理科', '知識・技能', '小テスト', 100),
            T(ID.scienceW2, '理科', '知識・技能', '小テスト', 100),
            T(ID.socialZ1, '社会', '知識・技能', '小テスト', 100),
            T(ID.socialZ2, '社会', '知識・技能', '小テスト', 100),
            T(ID.socialSolo, '社会', '知識・技能', '小テスト', 100),
            T(ID.peAttitude, '体育', '主体性', '授業態度', 10),
            T(ID.pePractical, '体育', '知識・技能', '実技記録', 9999, { peUnit: '回' }),
            T(ID.jpValidate, '国語', '知識・技能', '小テスト', 100),
            T(ID.pctNormal, '国語', '知識・技能', '小テスト', 15),
            T(ID.pctNoMax, '国語', '知識・技能', '小テスト', 0),
            T(ID.pctMarker, '体育', '知識・技能', '実技記録', 9999, { peUnit: '点' }),
            T(ID.pctMatome, '国語', '複合', 'まとめテスト', 3, { type: 'matome', matomePoints: [1, 1, 1] })
        ];

        const scores = [
            // 家庭: A/B+/B/B-/C の実値 (abcTo10 の全アプリ標準値を保護する最重要ケース)
            { testId: ID.houtei5, studentIndex: 0, score: 'A' },
            { testId: ID.houtei5, studentIndex: 1, score: 'B+' },
            { testId: ID.houtei5, studentIndex: 2, score: 'B' },
            { testId: ID.houtei5, studentIndex: 3, score: 'B-' },
            { testId: ID.houtei5, studentIndex: 4, score: 'C' },

            // 国語: score10ToABC 境界 (閾値80/50%はデフォルト値、KEYS.grade_thresholds未設定時)
            { testId: ID.jpBoundary, studentIndex: 0, score: 80 }, // 8.0/80→A
            { testId: ID.jpBoundary, studentIndex: 1, score: 79 }, // 7.9→B
            { testId: ID.jpBoundary, studentIndex: 2, score: 50 }, // 5.0→B
            { testId: ID.jpBoundary, studentIndex: 3, score: 49 }, // 4.9→C
            { testId: ID.jpBoundary, studentIndex: 4, score: 0 },  // 0→C(空文字ではない)
            { testId: ID.jpClamp, studentIndex: 5, score: 120 },   // 満点超過はクランプ
            // 段階1でrecSaveAllScoresに0〜maxScoreクランプを追加したが、これは「新規入力」の
            // 経路のみに効く制約であり、scoreTo10自体(=既存データを読んで10点換算する計算)は
            // 意図的に変更していない(段階1の要件「既存データには影響を与えない」)。
            // ここではlocalStorageに直接-10を注入し、recSaveAllScoresを経由しない
            // (=バリデーション導入後でも起こりうる)「既に保存されている範囲外データを
            // 読んだ場合」の計算結果が変わらないことを確認する。
            { testId: ID.jpNegative, studentIndex: 6, score: -10 },

            // 算数: abcToNum / 最終評定(hyoutei)の閾値 (デフォルト grade3=8 / grade2=5)
            { testId: ID.mathK, studentIndex: 0, score: 'A' }, { testId: ID.mathT, studentIndex: 0, score: 'A' }, { testId: ID.mathA, studentIndex: 0, score: 'A' }, // AAA(9)→3
            { testId: ID.mathK, studentIndex: 1, score: 'A' }, { testId: ID.mathT, studentIndex: 1, score: 'A' }, { testId: ID.mathA, studentIndex: 1, score: 'B' }, // AAB(8)→3
            { testId: ID.mathK, studentIndex: 2, score: 'A' }, { testId: ID.mathT, studentIndex: 2, score: 'B' }, { testId: ID.mathA, studentIndex: 2, score: 'B' }, // ABB(7)→2
            { testId: ID.mathK, studentIndex: 3, score: 'B' }, { testId: ID.mathT, studentIndex: 3, score: 'B' }, { testId: ID.mathA, studentIndex: 3, score: 'C' }, // BBC(5)→2
            { testId: ID.mathK, studentIndex: 4, score: 'B' }, { testId: ID.mathT, studentIndex: 4, score: 'C' }, { testId: ID.mathA, studentIndex: 4, score: 'C' }, // BCC(4)→1
            { testId: ID.mathK, studentIndex: 5, score: 'A' }, { testId: ID.mathT, studentIndex: 5, score: 'A' }, // 主体性未入力→評定なし('')

            // 理科: 重み付き平均 (2:1 → (10*2+4*1)/3=8)
            { testId: ID.scienceW1, studentIndex: 0, score: 100 }, // score10=10
            { testId: ID.scienceW2, studentIndex: 0, score: 40 },  // score10=4

            // 社会: 全重み0→単純平均フォールバック(idx0) / 未評価null項目は除外(idx1)
            { testId: ID.socialZ1, studentIndex: 0, score: 100 }, // score10=10, weight=0
            { testId: ID.socialZ2, studentIndex: 0, score: 40 },  // score10=4,  weight=0
            { testId: ID.socialSolo, studentIndex: 1, score: 60 }, // score10=6, idx1はZ1/Z2の記録なし

            // 体育: 授業態度(○/－/×→A/B/C) と 実技記録peManualABC直書き(14360, 段階4で置換予定)
            { testId: ID.peAttitude, studentIndex: 0, score: '○' },
            { testId: ID.peAttitude, studentIndex: 1, score: '－' },
            { testId: ID.peAttitude, studentIndex: 2, score: '×' },
            { testId: ID.pePractical, studentIndex: 0, score: 3, peManualABC: 'A' },
            { testId: ID.pePractical, studentIndex: 1, score: 3, peManualABC: 'B' },
            { testId: ID.pePractical, studentIndex: 2, score: 3, peManualABC: 'C' },

            // 段階2: 得点セルの「／満点 (割合%)」表示
            // idx0-7は国語の既存ケース(jpBoundary等)で使用中のため、集計汚染を避けてidx8/9を使う
            { testId: ID.pctNormal, studentIndex: 8, score: 13 },   // 13/15 → 86.66...% を87%に丸める
            { testId: ID.pctNoMax, studentIndex: 9, score: 10 },    // maxScore=0 → 割合は出ない
            { testId: ID.pctMarker, studentIndex: 0, score: 8 },    // maxScore=9999(マーカー) → 割合は出ない
            // idx0だと_matomeExtract()が category='複合'/型未設定を「知識・技能」扱いする
            // 既存挙動により国語の知識・技能集計(idx0-4)を汚染するため、idx8を使う
            { testId: ID.pctMatome, studentIndex: 8, answers: [1, 1, 0] } // 2/3 → 67%
        ];

        const weights = {
            '理科': { knowledge: { ['k_' + ID.scienceW1]: 2, ['k_' + ID.scienceW2]: 1 } },
            '社会': { knowledge: { ['k_' + ID.socialZ1]: 0, ['k_' + ID.socialZ2]: 0 } }
        };

        await page.evaluate(({ tests, scores, students, weights }) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: students,
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            // 専科(grdExtCalculate経由): k/t/aはA/B/Cのまま保持され、abcTo10による10点換算を経ない
            // （発見1: 「専科C=4→C=3」に対応する計算経路自体が無い、という調査結果の裏付けにもなる）。
            StorageManager.setImmediate(KEYS.grades_external, JSON.stringify({
                subjects: ['音楽'],
                data: { '音楽': { '0': { k: 'A', t: 'B', a: 'C', h: 2 } } }
            }));
            StorageManager.setImmediate(KEYS.grade_weights, JSON.stringify(weights));
        }, { tests, scores, students, weights });

        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));

        async function calc(subject) { return page.evaluate((s) => grdCalculate(s, 'all'), subject); }
        function itemOf(results, idx, prefix, testId) {
            const r = results.find(x => x.index === idx);
            if (!r) return null;
            const bucket = prefix === 'k' ? r.knowledge : prefix === 't' ? r.thinking : r.attitude;
            return bucket.items.find(it => it.itemKey === prefix + '_' + testId) || null;
        }

        // ================================================================
        // abcTo10: 全アプリ標準の5段階換算値そのもの
        // ================================================================
        const houtei5 = await calc('家庭');
        [['A', 0, 10], ['B+', 1, 8.5], ['B', 2, 7], ['B-', 3, 5], ['C', 4, 3]].forEach(([label, idx, expect]) => {
            const it = itemOf(houtei5, idx, 'a', ID.houtei5);
            check('abcTo10: ' + label + ' → ' + expect + '点', it && near(it.score10, expect), JSON.stringify(it));
        });

        // ================================================================
        // scoreTo10 / score10ToABC
        // ================================================================
        const jp = await calc('国語');
        function kABCof(idx) { const r = jp.find(x => x.index === idx); return r ? r.knowledge.abc : undefined; }
        check('score10ToABC: 8.0/閾値80→A', kABCof(0) === 'A', kABCof(0));
        check('score10ToABC: 7.9→B', kABCof(1) === 'B', kABCof(1));
        check('score10ToABC: 5.0→B', kABCof(2) === 'B', kABCof(2));
        check('score10ToABC: 4.9→C', kABCof(3) === 'C', kABCof(3));
        check('score10ToABC: 0→C(空文字ではない)', kABCof(4) === 'C', kABCof(4));
        const it7 = jp.find(x => x.index === 7);
        check('score10ToABC: 対象テストなし→空文字', it7 && it7.knowledge.abc === '', JSON.stringify(it7 && it7.knowledge.abc));
        const itClamp = itemOf(jp, 5, 'k', ID.jpClamp);
        check('scoreTo10: 満点超過はクランプ(120/100→10)', itClamp && near(itClamp.score10, 10), JSON.stringify(itClamp));
        const itNeg = itemOf(jp, 6, 'k', ID.jpNegative);
        check('scoreTo10: 既存の範囲外データ(-10)を読んだ場合、計算自体は変わらない(-10/100→-1、段階1はrecSaveAllScoresの新規入力のみ対象)', itNeg && near(itNeg.score10, -1), JSON.stringify(itNeg));

        // ================================================================
        // recOnScoreBlur / recSaveAllScores(段階1、設計修正版):
        // 範囲外(0未満/maxScore超過)はクランプせず「保存しない」+ 入力欄を
        // ハイライトして修正を促す方式。両者は recScoreOutOfRange() を共有する。
        //
        // 【重要】段階1の1回目の実装は、DOMに直接値を入れてrecSaveAllScores()を
        // 呼ぶだけのテストで「PASS」していたが、実機では「保存ボタンを押すと
        // 必ず入力欄からフォーカスが外れ、recSaveAllScoresより先にrecOnScoreBlurの
        // クランプが走ってしまう」という、実際のユーザー操作の順序に起因する
        // バグが発生した。これを二度と見落とさないため、以下は
        // page.click()→page.type()→次の要素をclick(=blur発火)→保存ボタンをclick
        // という実際のクリック・キー入力による操作順序で再現する
        // (DOMに直接値を代入するだけの手段は使わない)。
        // idx0=範囲内(正常保存)、idx8=下限割れ、idx9=上限超過。maxScore=100。
        // ================================================================
        await page.evaluate((testId) => {
            window.showView('records');
            window.recSelectTestGoto(testId);
        }, ID.jpValidate);
        await new Promise(r => setTimeout(r, 200));

        await page.click('#rec-sc-0');
        await page.type('#rec-sc-0', '80');
        await page.click('#rec-sc-8'); // rec-sc-0からフォーカスが外れ、recOnScoreBlur(0)が実際に発火する
        await new Promise(r => setTimeout(r, 100));
        await page.type('#rec-sc-8', '-20');
        await page.click('#rec-sc-9'); // rec-sc-8からフォーカスが外れ、recOnScoreBlur(8)が実際に発火する
        await new Promise(r => setTimeout(r, 100));

        // --- ここでrecOnScoreBlurの結果だけを検証する(recSaveAllScoresはまだ呼んでいない) ---
        const afterBlur8 = await page.evaluate(() => ({
            value: document.getElementById('rec-sc-8').value,
            hasError: document.getElementById('rec-sc-8').classList.contains('range-error')
        }));
        check('recOnScoreBlur: 範囲外(-20)はblur後も値が書き換わらない(クランプされない)', afterBlur8.value === '-20', JSON.stringify(afterBlur8));
        check('recOnScoreBlur: 範囲外(-20)はblur後にrange-errorでハイライトされる', afterBlur8.hasError === true, JSON.stringify(afterBlur8));

        // v1.21.13: 範囲外の値には割合を表示しない(赤ハイライトなのに「113%」等の
        // それらしい計算結果を隣に出すとメッセージが矛盾するため、実機で発覚)。
        const pctAfterBlur8 = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-8');
            return el ? el.textContent : null;
        });
        check('割合表示: 範囲外(-20)はblur後も「／maxScore」のみで割合は出ない', pctAfterBlur8 === '／100', pctAfterBlur8);

        const savedAfterBlur8 = await page.evaluate((testId) => {
            return StorageManager.get(KEYS.scores, []).filter(function(s) { return s.testId === testId; });
        }, ID.jpValidate);
        check('recOnScoreBlur: 範囲外(-20)はblur時点で保存されない', !savedAfterBlur8.some(function(s) { return s.studentIndex === 8; }), JSON.stringify(savedAfterBlur8));

        const blurToastMsg = await page.evaluate(() => {
            var el = document.getElementById('toastMsg');
            return el ? el.textContent : '';
        });
        check('recOnScoreBlur: クランプ警告トースト「丸めました」は出ない(ハイライトで示すため)', blurToastMsg.indexOf('丸めました') === -1, blurToastMsg);

        await page.type('#rec-sc-9', '9999');

        // --- 保存ボタンをclick(実機と同じ順序: これがrec-sc-9のblur→recSaveAllScoresの順で発火する) ---
        await page.click('button[onclick="recSaveAllScores()"]');
        await new Promise(r => setTimeout(r, 200));

        const afterFirstSave = await page.evaluate(() => ({
            v0: document.getElementById('rec-sc-0') ? document.getElementById('rec-sc-0').value : null,
            v8: document.getElementById('rec-sc-8') ? document.getElementById('rec-sc-8').value : null,
            v9: document.getElementById('rec-sc-9') ? document.getElementById('rec-sc-9').value : null,
            err0: document.getElementById('rec-sc-0') ? document.getElementById('rec-sc-0').classList.contains('range-error') : null,
            err8: document.getElementById('rec-sc-8') ? document.getElementById('rec-sc-8').classList.contains('range-error') : null,
            err9: document.getElementById('rec-sc-9') ? document.getElementById('rec-sc-9').classList.contains('range-error') : null
        }));
        check('保存ボタンclick後: 範囲外(-20)の値は書き換えられず、打った値のまま残る(blur→saveの順序でも)', afterFirstSave.v8 === '-20', JSON.stringify(afterFirstSave));
        check('保存ボタンclick後: 範囲外(9999)の値も書き換えられず、打った値のまま残る', afterFirstSave.v9 === '9999', JSON.stringify(afterFirstSave));
        check('保存ボタンclick後: 範囲外(-20)の行は range-error クラスでハイライトされたまま', afterFirstSave.err8 === true, JSON.stringify(afterFirstSave));
        check('保存ボタンclick後: 範囲外(9999)の行は range-error クラスでハイライトされる', afterFirstSave.err9 === true, JSON.stringify(afterFirstSave));
        check('保存ボタンclick後: 範囲内(80)の行は range-error クラスが付かない', afterFirstSave.err0 === false, JSON.stringify(afterFirstSave));

        const pctAfterFirstSave = await page.evaluate(() => ({
            p0: document.getElementById('rec-pct-0') ? document.getElementById('rec-pct-0').textContent : null,
            p8: document.getElementById('rec-pct-8') ? document.getElementById('rec-pct-8').textContent : null,
            p9: document.getElementById('rec-pct-9') ? document.getElementById('rec-pct-9').textContent : null
        }));
        check('割合表示: 範囲内(80)は保存後も割合が表示される(／100(80%))', pctAfterFirstSave.p0 === '／100(80%)', JSON.stringify(pctAfterFirstSave));
        check('割合表示: 範囲外(-20)は保存ボタンclick後も割合が出ない(／100のみ)', pctAfterFirstSave.p8 === '／100', JSON.stringify(pctAfterFirstSave));
        check('割合表示: 範囲外(9999)も保存ボタンclick後、割合が出ない(／100のみ)', pctAfterFirstSave.p9 === '／100', JSON.stringify(pctAfterFirstSave));

        const savedAfterFirst = await page.evaluate((testId) => {
            return StorageManager.get(KEYS.scores, []).filter(function(s) { return s.testId === testId; });
        }, ID.jpValidate);
        check('保存ボタンclick後: 範囲内(idx0)は保存される', savedAfterFirst.some(function(s) { return s.studentIndex === 0 && s.score === 80; }), JSON.stringify(savedAfterFirst));
        check('保存ボタンclick後: 範囲外(idx8, -20)はblur→save両方をすり抜けず未保存', !savedAfterFirst.some(function(s) { return s.studentIndex === 8; }), JSON.stringify(savedAfterFirst));
        check('保存ボタンclick後: 範囲外(idx9, 9999)は未保存', !savedAfterFirst.some(function(s) { return s.studentIndex === 9; }), JSON.stringify(savedAfterFirst));

        const firstToastMsg = await page.evaluate(() => {
            var el = document.getElementById('toastMsg');
            return el ? el.textContent : '';
        });
        check('recSaveAllScores: トーストに保存件数(1件)と未保存件数(2件)が示される',
            firstToastMsg.indexOf('1 件保存しました') >= 0 && firstToastMsg.indexOf('2件は範囲外のため未保存') >= 0, firstToastMsg);

        // --- idx8を範囲内の値(50)に直す→保存ボタンをclick ---
        // → ハイライトが解除されることを確認する。ここで検証したいのは「値を直して再保存
        // すればハイライトが消える」ことであり、フィールドのクリア手段そのものは今回の
        // バグ(blur→saveの順序)と無関係なため、既存値のクリアだけは直接代入で行う
        // (直後のtype()による入力と、保存ボタンのclick→blurの順序は実操作のまま維持する)。
        await page.evaluate(() => { document.getElementById('rec-sc-8').value = ''; });
        await page.click('#rec-sc-8');
        await page.type('#rec-sc-8', '50');
        await page.click('button[onclick="recSaveAllScores()"]'); // クリック自体がrec-sc-8のblurを先に発火させる
        await new Promise(r => setTimeout(r, 200));

        const afterSecondSave = await page.evaluate(() => ({
            v8: document.getElementById('rec-sc-8') ? document.getElementById('rec-sc-8').value : null,
            err8: document.getElementById('rec-sc-8') ? document.getElementById('rec-sc-8').classList.contains('range-error') : null,
            err9: document.getElementById('rec-sc-9') ? document.getElementById('rec-sc-9').classList.contains('range-error') : null
        }));
        check('値を直して再保存するとハイライトが解除される', afterSecondSave.err8 === false, JSON.stringify(afterSecondSave));
        check('直していない行(idx9)は引き続きハイライトされたまま', afterSecondSave.err9 === true, JSON.stringify(afterSecondSave));

        const savedAfterSecond = await page.evaluate((testId) => {
            return StorageManager.get(KEYS.scores, []).filter(function(s) { return s.testId === testId; });
        }, ID.jpValidate);
        check('直した値(50)が保存されている', savedAfterSecond.some(function(s) { return s.studentIndex === 8 && s.score === 50; }), JSON.stringify(savedAfterSecond));

        // ================================================================
        // recRenderList(段階2): 得点セルの「／満点 (割合%)」表示
        // 実際の点数入力画面をrecSelectTestGotoで開き、DOMの表示テキストを直接確認する。
        // ================================================================
        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctNormal);
        await new Promise(r => setTimeout(r, 150));
        const pctNormalText = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-8');
            return el ? el.textContent : null;
        });
        check('割合表示: 13/15点は四捨五入で87%になる(端数の丸め方の確認)', pctNormalText === '／15(87%)', pctNormalText);

        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctNoMax);
        await new Promise(r => setTimeout(r, 150));
        const pctNoMaxText = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-9');
            return el ? el.textContent : null;
        });
        check('割合表示: maxScore=0のテストでは割合(「(100%)」等)を一切表示しない', pctNoMaxText === '', JSON.stringify(pctNoMaxText));

        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctMarker);
        await new Promise(r => setTimeout(r, 150));
        const pctMarkerText = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-0');
            return el ? el.textContent : null;
        });
        check('割合表示: maxScore=9999(実技記録の変換不要マーカー)では割合を表示しない', pctMarkerText === '', JSON.stringify(pctMarkerText));

        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctMatome);
        await new Promise(r => setTimeout(r, 150));
        const pctMatomeText = await page.evaluate(() => {
            var btn = document.querySelector('#rec-row-8 .rec-row-score-area button');
            return btn ? btn.textContent : null;
        });
        check('割合表示: まとめテスト(満点3点の小さいケース)でも「2/3点 (67%)」のように破綻しない', pctMatomeText === '2/3点 (67%)', JSON.stringify(pctMatomeText));

        // --- ライブ更新: 保存前でも入力中の値で割合が更新されること ---
        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctNormal);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { document.getElementById('rec-sc-1').value = ''; });
        await page.click('#rec-sc-1');
        await page.type('#rec-sc-1', '9'); // 9/15 = 60%
        const liveP = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-1');
            return el ? el.textContent : null;
        });
        check('割合表示: 保存前(入力中)でもoninputでライブ更新される(9/15→60%)', liveP === '／15(60%)', liveP);

        // --- ライブ更新: 範囲内→範囲外に打ち替えたら割合が消え、範囲内に戻せば再び出ること ---
        await page.evaluate(() => { document.getElementById('rec-sc-1').value = ''; });
        await page.type('#rec-sc-1', '20'); // 20/15 → 範囲外(maxScore超過)
        const liveOutOfRangeP = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-1');
            return el ? el.textContent : null;
        });
        check('割合表示: 範囲内→範囲外に打ち替えると、ライブ更新で割合が消える(／15のみ)', liveOutOfRangeP === '／15', liveOutOfRangeP);

        await page.evaluate(() => { document.getElementById('rec-sc-1').value = ''; });
        await page.type('#rec-sc-1', '10'); // 10/15 → 範囲内に戻す(66.66...%→67%)
        const liveBackToRangeP = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-1');
            return el ? el.textContent : null;
        });
        check('割合表示: 範囲外→範囲内に打ち直すと、ライブ更新で割合が再び出る(10/15→67%)', liveBackToRangeP === '／15(67%)', liveBackToRangeP);

        // ================================================================
        // recSyncScoreCell(段階2 事故修正): 状態遷移(満点変更・category変更・
        // 課題切り替え・削除)をまたいでも入力形式/割合が正しく同期されること。
        // 「一度描画した画面に対する操作」だけでなく、実際のrecEditTest/recAddTest/
        // recDeleteTestを呼んで画面の外側から状態を変える操作を再現する。
        // ================================================================

        // --- ベースライン: pctNormal(maxScore=15, idx8=13点) ---
        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctNormal);
        await new Promise(r => setTimeout(r, 150));
        const beforeEdit = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-8');
            return el ? el.textContent : null;
        });
        check('状態遷移: 満点変更前のベースライン(13/15→87%)', beforeEdit === '／15(87%)', beforeEdit);

        // --- 満点変更: 既に開いている採点画面が無条件に作り直されること ---
        await page.evaluate((testId) => { window.recEditTest(testId); }, ID.pctNormal);
        await page.evaluate(() => { document.getElementById('recTestMaxScore').value = '20'; });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterMaxEdit = await page.evaluate(() => ({
            max: document.getElementById('rec-sc-8') ? document.getElementById('rec-sc-8').getAttribute('max') : null,
            pct: document.getElementById('rec-pct-8') ? document.getElementById('rec-pct-8').textContent : null
        }));
        check('状態遷移: 満点を15→20に変更すると、開いたままの採点画面のmax属性が更新される', afterMaxEdit.max === '20', JSON.stringify(afterMaxEdit));
        check('状態遷移: 満点変更後、割合が新しい満点で再計算される(13/20→65%、古い15基準の87%が残らない)', afterMaxEdit.pct === '／20(65%)', JSON.stringify(afterMaxEdit));

        // --- category変更: 得点欄→ABCボタンに切り替わること ---
        await page.evaluate((testId) => { window.recEditTest(testId); }, ID.pctNormal);
        await page.evaluate(() => { document.getElementById('recTestCategory').value = '主体性'; });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterCatToABC = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-8'),
            abcBtnCount: document.querySelectorAll('#rec-row-8 .rec-abc-btn').length
        }));
        check('状態遷移: categoryを主体性に変更すると、得点入力欄が消える', afterCatToABC.hasScInput === false, JSON.stringify(afterCatToABC));
        check('状態遷移: categoryを主体性に変更すると、ABCボタン(5個)に切り替わる', afterCatToABC.abcBtnCount === 5, JSON.stringify(afterCatToABC));

        // --- 逆方向: 主体性→他のcategoryに戻すと得点欄+正しい割合に戻ること ---
        await page.evaluate((testId) => { window.recEditTest(testId); }, ID.pctNormal);
        await page.evaluate(() => {
            document.getElementById('recTestCategory').value = '知識・技能';
            document.getElementById('recTestMaxScore').value = '15';
        });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterCatBack = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-8'),
            pct: document.getElementById('rec-pct-8') ? document.getElementById('rec-pct-8').textContent : null
        }));
        check('状態遷移: categoryを知識・技能に戻すと得点入力欄に戻る', afterCatBack.hasScInput === true, JSON.stringify(afterCatBack));
        check('状態遷移: category復帰後、既存の得点(13)と満点(15)で割合が正しい(87%)', afterCatBack.pct === '／15(87%)', JSON.stringify(afterCatBack));

        // --- 課題切り替え: 別の課題に切り替えてから戻っても割合が正しいこと ---
        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctMarker);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((testId) => { window.recSelectTestGoto(testId); }, ID.pctNormal);
        await new Promise(r => setTimeout(r, 150));
        const afterSwitchBack = await page.evaluate(() => {
            var el = document.getElementById('rec-pct-8');
            return el ? el.textContent : null;
        });
        check('状態遷移: 別の課題に切り替えてから戻っても割合は正しい(87%)', afterSwitchBack === '／15(87%)', afterSwitchBack);

        // --- 削除: 開いている課題を削除すると採点画面が「未選択」状態に戻ること ---
        await page.evaluate(() => {
            document.getElementById('recTestSubject').value = '国語';
            document.getElementById('recTestType').value = '小テスト';
            document.getElementById('recTestName').value = '削除確認用';
            document.getElementById('recTestCategory').value = '知識・技能';
            document.getElementById('recTestMaxScore').value = '10';
            document.getElementById('recTestDate').value = '2026-06-01';
        });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const created = await page.evaluate(() => {
            var tests = StorageManager.get(KEYS.tests, []);
            return tests.find(function(t) { return t.name === '削除確認用' && t.subject === '国語'; }) || null;
        });
        check('状態遷移(削除確認の前提): 削除確認用の課題が作成されている', !!created, JSON.stringify(created));
        const createdId = created ? created.id : null;

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdId);
        await new Promise(r => setTimeout(r, 150));
        const beforeDelete = await page.evaluate(() => !!document.getElementById('rec-sc-0'));
        check('状態遷移(削除確認の前提): 採点画面に得点入力欄が出ている', beforeDelete === true, '');

        await page.evaluate((id) => { window.recDeleteTest(id); }, createdId);
        await new Promise(r => setTimeout(r, 150));
        const afterDelete = await page.evaluate(() => ({
            bulkHidden: document.getElementById('recBulkWrap') ? document.getElementById('recBulkWrap').style.display === 'none' : null,
            infoShown: document.getElementById('recInputInfo') ? document.getElementById('recInputInfo').style.display !== 'none' : null
        }));
        // recRenderInputArea()の「未選択」分岐は#recBulkWrapを非表示にするだけで、
        // #recList自体のDOM(前の課題の採点行)は消さない仕様(既存挙動)。次に別の課題を
        // 選べばrecRenderList()が中身を作り直すため実害はない。ここでは「未選択の案内が
        // 表示され、採点エリアが隠れている」ことを確認する(=画面として古い課題が
        // 見え続けることはない)。
        check('状態遷移: 開いていた課題を削除すると、採点エリアが隠れ「課題を選択」案内が出る', afterDelete.bulkHidden === true && afterDelete.infoShown === true, JSON.stringify(afterDelete));

        // ================================================================
        // abcToNum / 最終評定(hyoutei)
        // ================================================================
        const math = await calc('算数');
        function hyouteiOf(idx) { const r = math.find(x => x.index === idx); return r ? { h: r.hyoutei, t: r.totalNum } : undefined; }
        check('abcToNum/最終評定: AAA(9)→3', hyouteiOf(0).h === 3, JSON.stringify(hyouteiOf(0)));
        check('abcToNum/最終評定: AAB(8)→3', hyouteiOf(1).h === 3, JSON.stringify(hyouteiOf(1)));
        check('abcToNum/最終評定: ABB(7)→2', hyouteiOf(2).h === 2, JSON.stringify(hyouteiOf(2)));
        check('abcToNum/最終評定: BBC(5)→2', hyouteiOf(3).h === 2, JSON.stringify(hyouteiOf(3)));
        check('abcToNum/最終評定: BCC(4)→1', hyouteiOf(4).h === 1, JSON.stringify(hyouteiOf(4)));
        check('abcToNum/最終評定: 主体性未入力→評定なし(空文字)', hyouteiOf(5).h === '', JSON.stringify(hyouteiOf(5)));

        // ================================================================
        // calcWeightedScore
        // ================================================================
        const science = await calc('理科');
        const scienceAvg = science.find(x => x.index === 0).knowledge.avg;
        check('calcWeightedScore: 重み2:1 → (10*2+4*1)/3=8', near(scienceAvg, 8), 'avg=' + scienceAvg);

        const social = await calc('社会');
        const socialAvg0 = social.find(x => x.index === 0).knowledge.avg;
        check('calcWeightedScore: 全項目の重みが0→単純平均へフォールバック((10+4)/2=7)', near(socialAvg0, 7), 'avg=' + socialAvg0);
        const socialAvg1 = social.find(x => x.index === 1).knowledge.avg;
        check('calcWeightedScore: 未評価(null)項目は除外され、残り1件の値がそのまま採用される(=6)', near(socialAvg1, 6), 'avg=' + socialAvg1);

        // ================================================================
        // 授業態度(○/－/×) と 実技記録peManualABC直書き(14360)
        // ================================================================
        const pe = await calc('体育');
        [['○', 'A', 0, 10], ['－', 'B', 1, 7], ['×', 'C', 2, 3]].forEach(([symbol, label, idx, expect]) => {
            const it = itemOf(pe, idx, 'a', ID.peAttitude);
            check('授業態度: ' + symbol + '→' + label + '→' + expect + '点(現行の記号解釈規則、段階7以降もこの解釈を維持)', it && near(it.score10, expect), JSON.stringify(it));
        });
        [['A', 0, 10], ['B', 1, 7], ['C', 2, 3]].forEach(([label, idx, expect]) => {
            const it = itemOf(pe, idx, 'k', ID.pePractical);
            check('実技記録peManualABC: ' + label + '→' + expect + '点(段階4でabcTo10呼び出しへ統一予定、値は不変であること)', it && near(it.score10, expect), JSON.stringify(it));
        });

        // ================================================================
        // 専科(grdExtCalculate): k/t/aは10点換算されず、totalNumのみabcToNumで合算される
        // ================================================================
        const music = await calc('音楽');
        const musicR = music.find(x => x.index === 0);
        check('専科: k/t/aはA/B/Cのまま保持され10点換算されない', musicR && musicR.knowledge.abc === 'A' && musicR.thinking.abc === 'B' && musicR.attitude.abc === 'C', JSON.stringify(musicR));
        check('専科: totalNumはabcToNum(A=3,B=2,C=1)の合算(3+2+1=6)', musicR && musicR.totalNum === 6, 'totalNum=' + (musicR && musicR.totalNum));
        check('専科: hyouteiは自動算出されず保存値をそのまま返す(grdExtSuggestHyouteiは候補提示ボタン専用で、この経路には無関係)', musicR && musicR.hyoutei === 2, 'hyoutei=' + (musicR && musicR.hyoutei));

        // ================================================================
        // grdGetCurrentTerm (3学期制のみ、MockDateで固定)
        // ================================================================
        await setMockDate(page, new Date(2026, 6, 5).getTime());
        const term1 = await page.evaluate(() => grdGetCurrentTerm());
        check('grdGetCurrentTerm: 3学期制 7月→1学期', term1 === '1', term1);

        await setMockDate(page, new Date(2026, 8, 1).getTime());
        const term2 = await page.evaluate(() => grdGetCurrentTerm());
        check('grdGetCurrentTerm: 3学期制 9月→2学期', term2 === '2', term2);

        await setMockDate(page, new Date(2027, 0, 15).getTime());
        const term3 = await page.evaluate(() => grdGetCurrentTerm());
        check('grdGetCurrentTerm: 3学期制 1月→3学期', term3 === '3', term3);

        await setMockDate(page, null);
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
        await setMockDate(page, null);
    }

    // ---- 触れた実データキーがすべて元の値に戻っていることの確認 ----
    let allRestored = true;
    const restoreDetail = {};
    for (const k of Object.values(REAL_KEYS)) {
        const cur = await getKey(k);
        restoreDetail[k] = (cur === backup[k]);
        if (cur !== backup[k]) allRestored = false;
    }
    check('触れた実データキーがすべて元の値に復元されている', allRestored, JSON.stringify(restoreDetail));

    const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
    check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));

    await browser.close();

    const fail = results.filter(r => !r.pass).length;
    console.log('\n===== 結果: PASS ' + (results.length - fail) + ' / FAIL ' + fail + ' / 合計 ' + results.length + ' =====');
    process.exit(fail > 0 ? 1 : 0);
})();
