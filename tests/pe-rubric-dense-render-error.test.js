// recBuildPeRubricDenseCard()の未捕捉throwに対するtry/catch隔離(v1.24.0想定)の機械検証。
//
// 修正前は、対応外のPeRubric設定(displayMode:'dense'の種目でblocks.length!==5等)が
// 1件でもtest.peRubricに混入すると、students.map()全体が例外で止まり
// list.innerHTMLへの代入自体が実行されず、その種目の児童一覧が丸ごと描画されなく
// なっていた(recRenderList()内、他の児童の分も含めて全滅)。
//
// 【重要な注記】ユーザー指示の「1人だけ不正なrubricDataを混入」を文字通り検証しようと
// 実地調査したところ、recBuildPeRubricDenseCard()内の3箇所のthrowはいずれも
// test.peRubric(=そのテストを受ける全児童で共有される設定)由来であり、個々の児童の
// rubricData(回答データ)の形が悪いだけでは(idata[b.id]||[]等、各所に||{}/||[]の
// フォールバックがあり)例外にならないことを確認した。そのため「特定の1人だけ
// 不正データ→その子だけエラー」という状況はこの関数には実在せず、不正な設定を持つ
// テストを受ける児童は全員が個別のエラー表示になる(=以前のような描画ゼロ件への
// 全滅ではなく、1人ずつ独立したエラーメッセージに留まる)、というのが実際の挙動。
// 本テストはその実際の挙動(全滅しない・各児童が個別に区別可能な表示になる・
// 他のテストの表示には影響しない)を検証する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node pe-rubric-dense-render-error.test.js

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
        defaultViewport: { width: 1180, height: 900 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        const text = msg.text();
        // recBuildPeRubricDenseCardのcatch内console.error()は、このテストが意図的に
        // 発生させているエラーのログなので対象外とする。
        if (text.indexOf('recBuildPeRubricDenseCard error') !== -1) return;
        consoleErrors.push(text + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });

    const now = Date.now();
    const brokenTestId = now + 1;
    const validTestId = now + 2;

    // ソフトバレープリセット(displayMode:'dense', combine:'table')を複製し、
    // 1項目のblocksを3個に壊す(dense表示は「5方向決め打ちのCSS」前提のため未対応)。
    const brokenPeRubric = {
        presetId: 'volley', name: 'ソフトバレーボール', emoji: '🏐', combine: 'table', bonusMode: 'any', cap: 10,
        displayMode: 'dense',
        items: [{
            id: 'v1', name: '5方向への返球', mode: 'trial',
            blocks: [
                { id: 'front', name: '①真正面', trials: 1 },
                { id: 'right', name: '②右', trials: 1 },
                { id: 'left', name: '③左', trials: 1 }
            ]
        }],
        bonus: [], conversionTable: [{ count: 5, score10: 10 }, { count: 0, score10: 1 }], note: ''
    };

    const brokenTest = {
        id: brokenTestId, subject: '体育', testType: '実技記録', category: '知識・技能', type: 'standard',
        maxScore: 9999, peUnit: '実技:volley', peRubric: brokenPeRubric,
        date: '2026-08-19', createdAt: new Date().toISOString()
    };
    // 正常系の対照用: 標準のマット運動プリセット(displayMode:'modal', mode:'level')。
    // dense専用のバグが他種目の表示まで巻き込んでいないことの確認に使う。
    const validTest = {
        id: validTestId, subject: '体育', testType: '実技記録', category: '知識・技能', type: 'standard',
        maxScore: 9999, peUnit: '実技:mat',
        date: '2026-08-19', createdAt: new Date().toISOString()
    };

    const students = [{ name: '児童A' }, { name: '児童B' }, { name: '児童C' }];

    await page.evaluate(({ brokenTest, validTest, students }) => {
        StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
        StorageManager.set(KEYS.tests, JSON.stringify([brokenTest, validTest]));
        StorageManager.set(KEYS.scores, JSON.stringify([]));
    }, { brokenTest, validTest, students });
    await page.reload({ waitUntil: 'networkidle0' });

    // ================================================================
    // 1. 壊れたテスト(dense, blocks.length=3)を開いても丸ごと描画停止しない
    // ================================================================
    const brokenFlow = await page.evaluate((testId) => {
        var out = {};
        try {
            showView('records');
            recSelectTestGoto(testId);
            out.threw = false;
        } catch (e) {
            out.threw = true; out.errMsg = e.message;
        }
        var list = document.getElementById('recList');
        out.listChildCount = list ? list.children.length : -1;
        out.rows = [0, 1, 2].map(function(i) {
            var el = document.getElementById('rec-row-' + i);
            return el ? el.textContent : null;
        });
        return out;
    }, brokenTestId);

    check('壊れたPeRubric設定(blocks.length=3)を開いても例外が外に漏れない(recSelectTestGotoが完走する)',
        brokenFlow.threw === false, JSON.stringify(brokenFlow));
    check('児童一覧が丸ごと空にならない(3人分の行が個別に存在する。以前は0件になっていた)',
        brokenFlow.listChildCount === 3, JSON.stringify(brokenFlow));
    check('3人とも各自の行にエラー表示が出て、誰の行か区別できる(氏名入りメッセージ)',
        brokenFlow.rows.every(function(t, i) {
            var name = ['児童A', '児童B', '児童C'][i];
            return t && t.indexOf('表示エラー') !== -1 && t.indexOf(name) !== -1;
        }),
        JSON.stringify(brokenFlow));

    // ================================================================
    // 2. 壊れたテストを表示した後でも、別の正常なテストの表示には影響しない
    //    (1種目の設定不良がアプリ全体を巻き込まないことの確認)
    // ================================================================
    const validFlow = await page.evaluate((testId) => {
        var out = {};
        try {
            recSelectTestGoto(testId);
            out.threw = false;
        } catch (e) {
            out.threw = true; out.errMsg = e.message;
        }
        var list = document.getElementById('recList');
        out.listChildCount = list ? list.children.length : -1;
        out.rows = [0, 1, 2].map(function(i) {
            var el = document.getElementById('rec-row-' + i);
            return el ? el.textContent : null;
        });
        return out;
    }, validTestId);

    check('壊れたテストを見た直後でも、別の正常なマット運動テストは例外なく開ける',
        validFlow.threw === false, JSON.stringify(validFlow));
    check('正常なテストでは3人とも通常表示になり、「表示エラー」を含まない',
        validFlow.listChildCount === 3 && validFlow.rows.every(function(t) { return t && t.indexOf('表示エラー') === -1; }),
        JSON.stringify(validFlow));

    check('検証中にコンソールエラーなし(このテストが意図的に発生させたエラーを除く)',
        consoleErrors.length === 0, JSON.stringify(consoleErrors));

    await browser.close();

    const fail = results.filter(function(r) { return !r.pass; });
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail.length) + '件 / 失敗: ' + fail.length + '件');
    if (fail.length > 0) process.exit(1);
})();
