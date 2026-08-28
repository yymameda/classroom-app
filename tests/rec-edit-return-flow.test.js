// v1.22.2 機械検証: 成績入力画面 → 課題編集への遷移／復帰フローを検証する。
//
//   window.recEditCurrentTest()    : 入力画面の「✏️ この課題を編集」ボタン用。
//                                     recGoToTestMgmt(recCurrentTestId)を呼ぶだけの薄いラッパー
//                                     (recCurrentTestIdはMODULE:RECORDS IIFE内のクロージャ変数で
//                                     inline onclick(グローバルスコープ実行)から直接参照できない)。
//   window.recGoToTestMgmt(testId) : testIdありなら管理画面へ遷移し、recEditTest(testId)で
//                                     編集フォームを開く。入力画面の選択課題・フィルタを
//                                     recReturnToTestId/recReturnInputFiltersに退避する。
//   window.recReturnToInput()      : 保存成功後、または「← 入力に戻る」ボタン押下時に
//                                     入力画面へ戻り、退避値からrecCurrentTestIdを復元する。
//                                     復帰対象の課題が削除済みならrecCurrentTestId=nullで開く。
//   recAddTest()内のmaxScore超過確認: 編集で満点を下げ、既存得点が新しい満点を超える場合、
//                                     confirm()で警告し、キャンセル可能。既存得点は書き換えない。
//
// recCurrentTestId/recEditingTestId/recReturnFlowActiveはIIFE内部のクロージャ変数でwindowに
// 露出していないため、既存テスト(recaddtest-maxscore-validation.test.js等)と同じ方針で、
// 内部変数を直接覗かずDOM上の観測可能な効果(プルダウンの選択値・フォームのタイトル/ボタン文言・
// 「← 入力に戻る」ボタンの表示/非表示・localStorageの保存内容)だけで検証する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node rec-edit-return-flow.test.js

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

    const MASTER = {
        students: [{ name: '検証太郎' }, { name: '検証花子' }, { name: '検証次郎' }],
        classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
    };

    async function seed(tests, scores) {
        await page.evaluate((m, t, s, keys) => {
            StorageManager.setImmediate(keys.master, JSON.stringify(m));
            StorageManager.setImmediate(keys.tests, JSON.stringify(t));
            StorageManager.setImmediate(keys.scores, JSON.stringify(s));
        }, MASTER, tests, scores, REAL_KEYS);
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('input'); });
        await new Promise(r => setTimeout(r, 150));
    }

    async function getTest(id) {
        return page.evaluate((tid, keys) => {
            var tests = StorageManager.get(keys.tests, []);
            return tests.find(function(t) { return t.id === tid; }) || null;
        }, id, REAL_KEYS);
    }
    async function getScoreRec(testId, studentIndex) {
        return page.evaluate((tid, idx, keys) => {
            var scores = StorageManager.get(keys.scores, []);
            return scores.find(function(s) { return s.testId === tid && s.studentIndex === idx; }) || null;
        }, testId, studentIndex, REAL_KEYS);
    }
    async function activeSub() {
        return page.evaluate(() => {
            var active = document.querySelector('#view-records .rec-sub.active');
            return active ? active.id : null;
        });
    }
    async function testFormState() {
        return page.evaluate(() => ({
            name: document.getElementById('recTestName').value,
            maxScore: document.getElementById('recTestMaxScore').value,
            title: document.getElementById('recTestFormTitle').textContent,
            saveBtnLabel: document.getElementById('recAddTestBtn').textContent,
            hasCancelBtn: !!document.getElementById('recCancelEditBtn'),
            returnBtnVisible: document.getElementById('recReturnToInputBtn').style.display !== 'none'
        }));
    }
    async function inputScreenState() {
        return page.evaluate(() => ({
            selectValue: document.getElementById('recInputTestSelect').value,
            infoVisible: document.getElementById('recInputInfo').style.display !== 'none',
            bulkVisible: document.getElementById('recBulkWrap').style.display !== 'none',
            maxAttr: (document.getElementById('rec-sc-0') || {}).max
        }));
    }

    try {
        // ================================================================
        // Check 1+2: 入力画面 → 編集ボタン → 管理画面遷移＋プリフィル → 保存 → 復帰
        // ================================================================
        const TEST_A = { id: 900001, subject: '国語', testType: '小テスト', name: 'EDT_課題A', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-01', createdAt: new Date().toISOString() };
        const TEST_B = { id: 900002, subject: '算数', testType: '小テスト', name: 'EDT_課題B', category: '知識・技能', type: 'standard', maxScore: 50, date: '2026-06-02', createdAt: new Date().toISOString() };
        const SCORE_A0 = { id: 1, studentIndex: 0, testId: 900001, score: 80, createdAt: new Date().toISOString() };
        await seed([TEST_A, TEST_B], [SCORE_A0]);

        await page.select('#recInputTestSelect', String(TEST_A.id));
        await new Promise(r => setTimeout(r, 150));
        const beforeEdit = await inputScreenState();
        check('前提: 課題選択で入力欄が表示される', beforeEdit.bulkVisible === true && beforeEdit.selectValue === String(TEST_A.id), JSON.stringify(beforeEdit));

        await page.click('#recEditThisTestBtn');
        await new Promise(r => setTimeout(r, 150));

        const sub1 = await activeSub();
        check('1. 編集ボタンで管理画面(tests)に遷移する', sub1 === 'rec-sub-tests', String(sub1));

        const formState = await testFormState();
        // v1.22.3: recEditTest()が開いた瞬間はrecAutoPrefix()を抑制するため、名前は無断で
        // 書き換わらずtest.nameのまま読み込まれる(_recSuppressAutoPrefixの検証)。
        check('1. 対象課題がフォームに読み込まれている(name)', formState.name === 'EDT_課題A', JSON.stringify(formState));
        check('1. 対象課題がフォームに読み込まれている(maxScore)', formState.maxScore === '100', JSON.stringify(formState));
        check('1. 編集モードのタイトル・保存ボタン文言に切り替わる', formState.title === '✏️ 課題を編集中' && formState.saveBtnLabel === '更新を保存', JSON.stringify(formState));
        check('1. キャンセルボタンが表示される(編集モード)', formState.hasCancelBtn === true, JSON.stringify(formState));
        check('1. 「← 入力に戻る」ボタンが表示される', formState.returnBtnVisible === true, JSON.stringify(formState));

        // 名前とmaxScoreを変更して保存（既存得点80 <= 新maxScore80なので超過なし・confirm不要）
        await page.evaluate(() => { document.getElementById('recTestName').value = 'EDT_課題A_改'; });
        await page.evaluate(() => { document.getElementById('recTestMaxScore').value = '80'; });
        // 既存得点(80)が新maxScore(80)を超えないためconfirmは出ない想定(出た場合はテストがハングし検出できる)
        await page.click('#recAddTestBtn');
        await new Promise(r => setTimeout(r, 200));

        const sub2 = await activeSub();
        check('2. 保存成功後に入力画面へ自動復帰する', sub2 === 'rec-sub-input', String(sub2));

        const restored = await inputScreenState();
        check('2. 復帰後、元の課題(A)が選択状態', restored.selectValue === String(TEST_A.id), JSON.stringify(restored));
        check('2. 入力画面の表示(満点)が編集内容を即座に反映', restored.maxAttr === '80', JSON.stringify(restored));

        const savedA = await getTest(TEST_A.id);
        check('2. 課題データ自体も更新されている', !!savedA && savedA.name === 'EDT_課題A_改' && savedA.maxScore === 80, JSON.stringify(savedA));

        // ================================================================
        // Check 3: 管理画面で別の課題(B)を編集してから戻っても、復帰先は入力していた課題(A)
        // ================================================================
        await page.click('#recEditThisTestBtn'); // 再度、課題Aを選んだ状態から編集へ
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((bid) => { window.recEditTest(bid); }, TEST_B.id); // 一覧から別課題(B)を編集
        await new Promise(r => setTimeout(r, 100));
        const formStateB = await testFormState();
        check('前提: 管理画面上で別課題(B)への編集に切り替わっている', formStateB.name === 'EDT_課題B', JSON.stringify(formStateB));

        await page.evaluate(() => { document.getElementById('recTestName').value = 'EDT_課題B_改'; });
        // 課題B(maxScore=50)には既存得点が無いためconfirmは出ない想定
        await page.click('#recAddTestBtn');
        await new Promise(r => setTimeout(r, 200));

        const afterB = await inputScreenState();
        check('3. 別課題(B)を編集後も復帰先は入力していた課題(A)', afterB.selectValue === String(TEST_A.id), JSON.stringify(afterB));

        const savedB = await getTest(TEST_B.id);
        check('3. 別課題(B)自体は独立して更新されている', !!savedB && savedB.name === 'EDT_課題B_改', JSON.stringify(savedB));

        // ================================================================
        // Check A(v1.22.3): _recSuppressAutoPrefixの検証
        //   - 編集で開く→何も変更せず保存、を3回繰り返しても課題名が変わらない
        //   - 編集中にユーザーが種別ドロップダウンを手動変更した場合は、
        //     従来どおりプレフィックスが付け替わる(抑制が効きすぎていないこと)
        // ================================================================
        const TEST_E = { id: 900005, subject: '算数', testType: '小テスト', name: 'SUP_課題E', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-05', createdAt: new Date().toISOString() };
        await seed([TEST_E], []);
        await page.evaluate(() => { window.recShowSub('tests'); });

        for (let round = 1; round <= 3; round++) {
            await page.evaluate((eid) => { window.recEditTest(eid); }, TEST_E.id);
            await new Promise(r => setTimeout(r, 80));
            const nameAfterOpen = await page.evaluate(() => document.getElementById('recTestName').value);
            check('A' + round + '. 編集で開いただけでは課題名が変わらない(open時)', nameAfterOpen === 'SUP_課題E', nameAfterOpen);
            await page.click('#recAddTestBtn');
            await new Promise(r => setTimeout(r, 150));
            const savedE = await getTest(TEST_E.id);
            check('A' + round + '. 変更せず保存しても課題名が変わらない(保存後)', !!savedE && savedE.name === 'SUP_課題E', JSON.stringify(savedE));
        }

        // ユーザーが種別を手動変更した場合は、従来どおりrecAutoPrefixが発火する
        await page.evaluate((eid) => { window.recEditTest(eid); }, TEST_E.id);
        await new Promise(r => setTimeout(r, 80));
        await page.select('#recTestType', '記述問題'); // page.selectはネイティブchangeイベントを発火させる
        await new Promise(r => setTimeout(r, 80));
        const nameAfterManualTypeChange = await page.evaluate(() => document.getElementById('recTestName').value);
        check('A4. 編集中に種別を手動変更するとプレフィックスが付け替わる(抑制が効きすぎていない)', nameAfterManualTypeChange === '記述_SUP_課題E', nameAfterManualTypeChange);

        // ================================================================
        // Check G(v1.22.3): バックアップ復元由来などでname欠損の課題データが
        // 直接localStorageに入っていた場合、recEditTest()で開くと'(名称未設定)'が
        // 入り、保存が拒否されずに完了すること(recAddTestの!nameガードのすり抜け防止)。
        // ================================================================
        const TEST_G = { id: 900007, subject: '国語', testType: '小テスト', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-07', createdAt: new Date().toISOString() }; // nameフィールドなし
        await seed([TEST_G], []);
        await page.evaluate(() => { window.recShowSub('tests'); });
        await page.evaluate((gid) => { window.recEditTest(gid); }, TEST_G.id);
        await new Promise(r => setTimeout(r, 80));
        const nameFallback = await page.evaluate(() => document.getElementById('recTestName').value);
        check('G1. name欠損の課題を開くと名前欄に(名称未設定)が入る', nameFallback === '(名称未設定)', nameFallback);

        // 既存得点が無いためconfirmは出ない想定(出た場合はpage.clickがハングし検出できる)
        await page.click('#recAddTestBtn');
        await new Promise(r => setTimeout(r, 200));
        const savedG = await getTest(TEST_G.id);
        check('G2. name欠損の課題でも保存が拒否されず完了する', !!savedG && savedG.name === '(名称未設定)', JSON.stringify(savedG));

        // ================================================================
        // Check 4: 既存得点を超えるmaxScoreへの変更は警告 → キャンセル可 → 続行時も既存得点は不変
        // ================================================================
        const TEST_C = { id: 900003, subject: '理科', testType: '小テスト', name: 'EDT_課題C', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-03', createdAt: new Date().toISOString() };
        const SCORE_C0 = { id: 2, studentIndex: 0, testId: 900003, score: 90, createdAt: new Date().toISOString() };
        const SCORE_C1 = { id: 3, studentIndex: 1, testId: 900003, score: 30, createdAt: new Date().toISOString() };
        const SCORE_C2 = { id: 4, studentIndex: 2, testId: 900003, score: 95, createdAt: new Date().toISOString() };
        await seed([TEST_C], [SCORE_C0, SCORE_C1, SCORE_C2]);
        await page.evaluate(() => { window.recShowSub('tests'); });
        await page.evaluate((cid) => { window.recEditTest(cid); }, TEST_C.id);
        await new Promise(r => setTimeout(r, 100));

        // 4a: キャンセル → 保存されない・得点も不変
        let dialogMsg = null;
        page.once('dialog', async d => { dialogMsg = d.message(); await d.dismiss(); });
        await page.evaluate(() => { document.getElementById('recTestMaxScore').value = '50'; });
        await page.click('#recAddTestBtn');
        await new Promise(r => setTimeout(r, 200));
        check('4a. maxScore超過で確認ダイアログが出て対象人数(2人)を明示', !!dialogMsg && dialogMsg.indexOf('2人') !== -1, String(dialogMsg));
        const cTestAfterCancel = await getTest(TEST_C.id);
        check('4a. キャンセルすると課題は更新されない(maxScoreは100のまま)', !!cTestAfterCancel && cTestAfterCancel.maxScore === 100, JSON.stringify(cTestAfterCancel));

        // 4b: 続行 → 保存される・既存得点は書き換えられない
        page.once('dialog', async d => { await d.accept(); });
        await page.evaluate(() => { document.getElementById('recTestMaxScore').value = '50'; });
        await page.click('#recAddTestBtn');
        await new Promise(r => setTimeout(r, 200));
        const cTestAfterOk = await getTest(TEST_C.id);
        check('4b. 続行するとmaxScoreは更新される', !!cTestAfterOk && cTestAfterOk.maxScore === 50, JSON.stringify(cTestAfterOk));
        const c0 = await getScoreRec(TEST_C.id, 0);
        const c2 = await getScoreRec(TEST_C.id, 2);
        check('4b. 超過していた既存得点は書き換えられない(90のまま)', !!c0 && c0.score === 90, JSON.stringify(c0));
        check('4b. 超過していた既存得点は書き換えられない(95のまま)', !!c2 && c2.score === 95, JSON.stringify(c2));

        // ================================================================
        // Check 5: 復帰対象の課題が削除済みの場合、エラーにならず未選択状態で復帰する
        // ================================================================
        const TEST_D = { id: 900004, subject: '社会', testType: '小テスト', name: 'EDT_課題D', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-04', createdAt: new Date().toISOString() };
        await seed([TEST_D], []);
        await page.select('#recInputTestSelect', String(TEST_D.id));
        await new Promise(r => setTimeout(r, 150));
        await page.click('#recEditThisTestBtn');
        await new Promise(r => setTimeout(r, 150));

        // 管理画面にいる間に、他経路で対象課題(D)自体が削除された状況を再現する
        // (recDeleteTest経由だとrecCurrentTestId連動クリアが先に走ってしまい、
        //  recReturnToInput側の削除済みガードを独立して検証できないため、
        //  ストレージを直接書き換えて「外部で消えた」状態を作る)
        await page.evaluate((keys) => {
            StorageManager.setImmediate(keys.tests, JSON.stringify([]));
            window.recInvalidateCache();
        }, REAL_KEYS);

        await page.click('#recReturnToInputBtn');
        await new Promise(r => setTimeout(r, 200));

        const afterDelete = await inputScreenState();
        const afterDeleteSub = await activeSub();
        check('5. 削除済み課題への復帰でエラーにならず入力画面が開く', afterDeleteSub === 'rec-sub-input', String(afterDeleteSub));
        check('5. 課題未選択状態(プルダウン未選択)に戻る', afterDelete.selectValue === '', JSON.stringify(afterDelete));
        check('5. 課題未選択の案内表示に戻る', afterDelete.infoVisible === true && afterDelete.bulkVisible === false, JSON.stringify(afterDelete));

        // ================================================================
        // testIdなしの既存呼び出し（後方互換）
        // ================================================================
        await seed([TEST_A], [SCORE_A0]);
        await page.select('#recInputTestSelect', String(TEST_A.id));
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recGoToTestMgmt(); }); // 引数なし＝既存の「授業課題の管理へ」相当
        await new Promise(r => setTimeout(r, 150));
        const legacySub = await activeSub();
        const legacyForm = await testFormState();
        check('後方互換: testIdなしは従来どおりtests画面へ遷移するのみ', legacySub === 'rec-sub-tests', String(legacySub));
        check('後方互換: testIdなしでは編集モードに入らない(新規追加フォームのまま)', legacyForm.title === '📝 新しい課題を追加' && legacyForm.name === '', JSON.stringify(legacyForm));
        check('後方互換: testIdなしでは「← 入力に戻る」ボタンを出さない', legacyForm.returnBtnVisible === false, JSON.stringify(legacyForm));

        // ================================================================
        // コンソールエラーの回帰確認
        // ================================================================
        const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
        check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
        const restoredKeys = {};
        for (const k of Object.values(REAL_KEYS)) restoredKeys[k] = await getKey(k);
        const allRestored = Object.values(REAL_KEYS).every(k => restoredKeys[k] === backup[k]);
        check('触れた実データキーがすべて元の値に復元されている', allRestored, JSON.stringify({ restored: Object.keys(REAL_KEYS) }));
        await browser.close();
    }

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
