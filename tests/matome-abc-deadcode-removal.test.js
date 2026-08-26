// 段階6 機械検証: 段階5でUI除去した結果、到達不能になったABCモード関連コードの削除確認。
//
// 削除したもの(index.html):
//   REC_ABC5_RATIO / recAbcToPoints / recToggleMqMode / recSetMatomeUniformMode /
//   recMatomeSelectABC / recMatomeKeyABC / recMatomeApplyABC / recMatomeGradeToDigit /
//   REC_DIGIT_TO_GRADE / REC_GRADE_TO_DIGIT / recMatomeAllFilled /
//   recEditTest内のmode復元コード / ABC関連CSS(.rec-mq-abc-btn等) /
//   recGetMatomeFormData・recAddTestのmatomeQuestionModes書き込み側
//
// 既存データ(matomeQuestionModesはすべて"point")に対する互換性も確認するため、
// 念のため旧データ形式(matomeQuestionModesに"abc"が残っている想定)のテストを
// 疑似的に用意し、UI除去後もエラーなく開けて点数が変わらないことを検証する
// (実データにabcは0件だが、コード上の互換性として安全側に倒して確認する)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node matome-abc-deadcode-removal.test.js

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
        const now = Date.now();
        // 旧データ互換確認用: matomeQuestionModesに"abc"が残っている想定の既存テスト
        // (実データには存在しないが、削除後もエラーなく開けることをコードレベルで保証するため)
        const legacyTestId = now + 1;

        await page.evaluate((legacyId) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: [{ name: '検証用A' }, { name: '検証用B' }],
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([
                {
                    id: legacyId, subject: '算数', testType: 'まとめテスト', category: '複合', name: '旧データ互換確認まとめ',
                    type: 'matome', maxScore: 10, date: '2026-06-01', createdAt: new Date().toISOString(),
                    matomePoints: [5, 5], matomeQuestionTypes: ['知', '思'],
                    matomeQuestionModes: ['abc', 'point'], // 旧データ形式(段階5前に作られた想定)
                    matomeQCount: 2
                }
            ]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([
                { id: legacyId + 100, studentIndex: 0, testId: legacyId, score: 8, answers: [5, 3], createdAt: new Date().toISOString() }
            ]));
        }, legacyTestId);
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));

        // ================================================================
        // 1. 削除した関数がグローバルに存在しないこと(確実に削除されたことの確認)
        // ================================================================
        const removedSymbols = await page.evaluate(() => ({
            recToggleMqMode: typeof window.recToggleMqMode,
            recSetMatomeUniformMode: typeof window.recSetMatomeUniformMode,
            recMatomeSelectABC: typeof window.recMatomeSelectABC,
            recMatomeKeyABC: typeof window.recMatomeKeyABC
        }));
        check('削除した関数(window公開分)がすべてundefinedになっている', Object.values(removedSymbols).every(function(t) { return t === 'undefined'; }), JSON.stringify(removedSymbols));

        // ================================================================
        // 2. 旧データ形式(matomeQuestionModes: ['abc','point'])の既存テストを開いて
        //    点数が変わらないこと(既存のまとめテストが開けなくなる事態がないこと)
        // ================================================================
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        const legacyModalState = await page.evaluate(() => ({
            q1: document.getElementById('rec-mq-0') ? document.getElementById('rec-mq-0').value : null,
            q2: document.getElementById('rec-mq-1') ? document.getElementById('rec-mq-1').value : null,
            abcBtnCount: document.querySelectorAll('.rec-mq-abc-btn').length,
            total: document.getElementById('recMqTotal') ? document.getElementById('recMqTotal').textContent : null
        }));
        check('旧データ互換: matomeQuestionModes=["abc","point"]のテストを開いてもエラーなく、既存の点数(5,3)がそのまま表示される',
            legacyModalState.q1 === '5' && legacyModalState.q2 === '3', JSON.stringify(legacyModalState));
        check('旧データ互換: ABCボタンは描画されない(UI完全除去)', legacyModalState.abcBtnCount === 0, JSON.stringify(legacyModalState));
        check('旧データ互換: 合計表示が保存済みのscore(8)と一致する', legacyModalState.total === '8', JSON.stringify(legacyModalState));
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });

        // ================================================================
        // 3. 新規作成・採点・保存・状態遷移(段階5と同様、回帰確認として最小限)
        // ================================================================
        await page.evaluate(() => {
            document.getElementById('recTestSubject').value = '国語';
            document.getElementById('recTestType').value = 'まとめテスト';
            document.getElementById('recTestName').value = 'ABC死コード削除検証';
            document.getElementById('recTestDate').value = '2026-06-01';
            document.getElementById('recMatomeQCount').value = '2';
            window.recRenderMatomePreview();
        });
        await new Promise(r => setTimeout(r, 100));
        const newFormUiState = await page.evaluate(() => ({
            modeToggleBtnCount: document.querySelectorAll('.rec-mq-mode-btn').length,
            uniformModeBtnCount: document.querySelectorAll('[onclick*="recSetMatomeUniformMode"]').length
        }));
        check('新規作成フォーム: ABC関連ボタンが一切存在しない', newFormUiState.modeToggleBtnCount === 0 && newFormUiState.uniformModeBtnCount === 0, JSON.stringify(newFormUiState));

        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const created = await page.evaluate(() => StorageManager.get(KEYS.tests, []).find(function(t) { return t.name === 'ABC死コード削除検証'; }));
        check('新規作成: まとめテストが作られ、matomeQuestionModesフィールド自体が付かない', created && !('matomeQuestionModes' in created), JSON.stringify(created));

        const savedQ = await page.evaluate((id) => {
            var all = StorageManager.get(KEYS.matome_questions, {});
            return all[id] || null;
        }, created.id);
        check('新規作成: matomeQストアの設問オブジェクトにもmodeフィールドが付かない', Array.isArray(savedQ) && savedQ.every(function(q) { return !('mode' in q); }), JSON.stringify(savedQ));

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => {
            document.getElementById('rec-mq-0').value = '4';
            document.getElementById('rec-mq-1').value = '5';
            window.recUpdateMatomeTotal();
        });
        await new Promise(r => setTimeout(r, 100));
        await page.evaluate(() => { window.recMatomeModalSave(); });
        await new Promise(r => setTimeout(r, 150));
        let sc = await page.evaluate((id) => StorageManager.get(KEYS.scores, []).find(function(s) { return s.testId === id && s.studentIndex === 0; }), created.id);
        check('採点・保存: answersが[4,5]・score=9で保存される', sc && sc.score === 9 && sc.answers[0] === 4 && sc.answers[1] === 5, JSON.stringify(sc));

        // 状態遷移: 再描画
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        const reopened = await page.evaluate(() => ({
            q1: document.getElementById('rec-mq-0').value,
            q2: document.getElementById('rec-mq-1').value
        }));
        check('状態遷移: 保存後の再描画で値(4,5)が保持される', reopened.q1 === '4' && reopened.q2 === '5', JSON.stringify(reopened));

        // 状態遷移: 課題切り替えて戻る
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, legacyTestId);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        const afterSwitchBack = await page.evaluate(() => ({
            q1: document.getElementById('rec-mq-0') ? document.getElementById('rec-mq-0').value : null,
            q2: document.getElementById('rec-mq-1') ? document.getElementById('rec-mq-1').value : null
        }));
        check('状態遷移: 課題切り替えて戻っても値(4,5)が保持される', afterSwitchBack.q1 === '4' && afterSwitchBack.q2 === '5', JSON.stringify(afterSwitchBack));
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });

        // 状態遷移: 編集
        await page.evaluate((id) => { window.recEditTest(id); }, created.id);
        await new Promise(r => setTimeout(r, 100));
        const editState = await page.evaluate(() => ({
            modeToggleBtnCount: document.querySelectorAll('.rec-mq-mode-btn').length,
            qCount: document.getElementById('recMatomeQCount').value
        }));
        check('編集画面: ABCトグルボタンが存在せず、正常に開ける', editState.modeToggleBtnCount === 0 && editState.qCount === '2', JSON.stringify(editState));
        await page.evaluate(() => { window.recAddTest(); }); // 変更なしでそのまま更新保存
        await new Promise(r => setTimeout(r, 150));
        const afterEditSave = await page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(function(t) { return t.id === id; }), created.id);
        check('編集・更新保存: 更新後もmatomeQuestionModesフィールドが付かない', afterEditSave && !('matomeQuestionModes' in afterEditSave), JSON.stringify(afterEditSave));

        // 状態遷移: 削除
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recDeleteTest(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        const afterDelete = await page.evaluate(() => ({
            bulkHidden: document.getElementById('recBulkWrap') ? document.getElementById('recBulkWrap').style.display === 'none' : null,
            infoShown: document.getElementById('recInputInfo') ? document.getElementById('recInputInfo').style.display !== 'none' : null
        }));
        check('削除: 採点エリアが隠れ「課題を選択」案内が出る', afterDelete.bulkHidden === true && afterDelete.infoShown === true, JSON.stringify(afterDelete));

        // ================================================================
        // コンソールエラーの回帰確認(削除した関数への参照が残っていればここで検出される)
        // ================================================================
        const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
        check('検証中にコンソールエラーなし(favicon.ico除く。削除関数への参照残存があればここで検出)', realErrors.length === 0, realErrors.join(' | '));
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
