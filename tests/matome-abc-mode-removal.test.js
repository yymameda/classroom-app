// 段階5 機械検証: まとめテストの設問別ABCモードUI除去の検証。
//
// 除去したのは以下4箇所(index.html):
//   1. テスト作成フォームの「入力方式一括」ボタン(全て点数/全てABC)と説明文のABC部分
//   2. recRenderMatomePreview() の各設問「点/ABC」トグルボタン
//   3. recRenderMatomeModalGrid() のABC入力分岐(常にプレーン数値入力になる)
// 実データのmatomeQuestionModesはすべて"point"(abcは1件も無いことを確認済み)のため、
// 既存データの再現テストは行わず、新規作成したまとめテストのみで検証する
// (ユーザー承認済み: 段階5指示メッセージ参照)。
//
// 追記(段階6): matomeQuestionModesの書き込み側自体を段階6で削除したため、
// このファイル内でmatomeQuestionModesを参照していたチェックは「フィールドが
// 付かないこと」の確認に更新した(段階6の承認済み変更を反映)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node matome-abc-mode-removal.test.js

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

        // ================================================================
        // 1. テスト作成フォーム: 「入力方式一括」ボタン・ABC説明文が存在しないこと
        // ================================================================
        await page.evaluate(() => {
            document.getElementById('recTestSubject').value = '算数';
            document.getElementById('recTestType').value = 'まとめテスト';
            document.getElementById('recTestName').value = 'ABC除去検証まとめ';
            document.getElementById('recTestDate').value = '2026-06-01';
        });
        await new Promise(r => setTimeout(r, 100));
        const formUiState = await page.evaluate(() => {
            var uniformModeBtns = Array.prototype.slice.call(document.querySelectorAll('[onclick*="recSetMatomeUniformMode"]'));
            var modeToggleBtns = document.querySelectorAll('.rec-mq-mode-btn');
            var explainText = document.querySelector('#recMatomeFields p') ? document.querySelector('#recMatomeFields p').textContent : '';
            return {
                uniformModeBtnCount: uniformModeBtns.length,
                modeToggleBtnCount: modeToggleBtns.length,
                explainMentionsABC: explainText.indexOf('ABC') >= 0
            };
        });
        check('作成フォーム: 「入力方式一括」(全て点数/全てABC)ボタンが存在しない', formUiState.uniformModeBtnCount === 0, JSON.stringify(formUiState));
        check('作成フォーム: 各設問の「点/ABC」トグルボタンが存在しない', formUiState.modeToggleBtnCount === 0, JSON.stringify(formUiState));
        check('作成フォーム: 説明文にABCの記述が残っていない', formUiState.explainMentionsABC === false, JSON.stringify(formUiState));

        // ================================================================
        // 2. 新規作成したまとめテストのmatomeQuestionModesが常に'point'になること
        // ================================================================
        await page.evaluate(() => {
            document.getElementById('recMatomeQCount').value = '2';
            window.recRenderMatomePreview();
        });
        await new Promise(r => setTimeout(r, 100));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const created = await page.evaluate(() => {
            var tests = StorageManager.get(KEYS.tests, []);
            return tests.find(function(t) { return t.name === 'ABC除去検証まとめ'; }) || null;
        });
        check('新規作成: まとめテストが作られ、maxScore=配点合計(5+5=10)', created && created.maxScore === 10, JSON.stringify(created));
        // 段階6でmatomeQuestionModes書き込み側自体を削除したため、フィールドが付かないことを確認する
        // (段階5時点では常に'point'配列になる想定だったが、段階6の追加削除でフィールド自体が無くなった)。
        check('新規作成: matomeQuestionModesフィールドが付かない(段階6でUI除去に伴い書き込み側も削除済み)',
            created && !('matomeQuestionModes' in created),
            JSON.stringify(created));

        // ================================================================
        // 3. 採点画面: ABC入力UI(ボタン・数字キー欄)が存在せず、常にプレーン数値入力であること
        // ================================================================
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        const modalUiState = await page.evaluate(() => {
            var grid = document.getElementById('recMatomeGrid');
            return {
                abcBtnCount: grid.querySelectorAll('.rec-mq-abc-btn').length,
                abcKeyCount: grid.querySelectorAll('.rec-mq-abc-key').length,
                numberInputCount: grid.querySelectorAll('input[type="number"]').length
            };
        });
        check('採点画面: ABCボタン(rec-mq-abc-btn)が存在しない', modalUiState.abcBtnCount === 0, JSON.stringify(modalUiState));
        check('採点画面: ABC数字キー入力欄(rec-mq-abc-key)が存在しない', modalUiState.abcKeyCount === 0, JSON.stringify(modalUiState));
        check('採点画面: 2設問とも数値入力欄(type=number)になっている', modalUiState.numberInputCount === 2, JSON.stringify(modalUiState));

        // ================================================================
        // 4. 採点: 数値を入力して保存 → 正しく保存される
        // ================================================================
        await page.evaluate(() => {
            document.getElementById('rec-mq-0').value = '4';
            document.getElementById('rec-mq-1').value = '3';
            window.recUpdateMatomeTotal();
        });
        await new Promise(r => setTimeout(r, 100));
        const totalDisplay = await page.evaluate(() => document.getElementById('recMqTotal').textContent);
        check('採点画面: 合計表示が4+3=7になる', totalDisplay === '7', totalDisplay);

        await page.evaluate(() => { window.recMatomeModalSave(); });
        await new Promise(r => setTimeout(r, 150));
        let sc = await page.evaluate((id) => StorageManager.get(KEYS.scores, []).find(function(s) { return s.testId === id && s.studentIndex === 0; }), created.id);
        check('保存: answersが[4,3]で保存され、score=7になる', sc && sc.score === 7 && sc.answers[0] === 4 && sc.answers[1] === 3, JSON.stringify(sc));

        // ================================================================
        // 状態遷移: 保存後の再描画で同じ値が表示される(再度モーダルを開く)
        // ================================================================
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        const reopenedValues = await page.evaluate(() => ({
            q1: document.getElementById('rec-mq-0').value,
            q2: document.getElementById('rec-mq-1').value
        }));
        check('状態遷移: 保存後に再度開いても値(4,3)が保持されている', reopenedValues.q1 === '4' && reopenedValues.q2 === '3', JSON.stringify(reopenedValues));

        // ================================================================
        // 状態遷移: 課題を切り替えて戻る
        // ================================================================
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });
        await page.evaluate(() => {
            document.getElementById('recTestSubject').value = '国語';
            document.getElementById('recTestType').value = '小テスト';
            document.getElementById('recTestName').value = 'ABC除去検証_他課題';
            document.getElementById('recTestCategory').value = '知識・技能';
            document.getElementById('recTestMaxScore').value = '50';
            document.getElementById('recTestDate').value = '2026-06-01';
        });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const otherTest = await page.evaluate(() => StorageManager.get(KEYS.tests, []).find(function(t) { return t.name === 'ABC除去検証_他課題'; }));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, otherTest.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        const backToMatomeUiOk = await page.evaluate(() => !!document.querySelector('.rec-row .rec-test-item, #recList'));
        await page.evaluate(() => { window.recOpenMatomeModal(0); });
        await new Promise(r => setTimeout(r, 150));
        const afterSwitchBackValues = await page.evaluate(() => ({
            q1: document.getElementById('rec-mq-0') ? document.getElementById('rec-mq-0').value : null,
            q2: document.getElementById('rec-mq-1') ? document.getElementById('rec-mq-1').value : null
        }));
        check('状態遷移: 別課題に切り替えてから戻っても値(4,3)が保持されている', afterSwitchBackValues.q1 === '4' && afterSwitchBackValues.q2 === '3', JSON.stringify(afterSwitchBackValues));
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });

        // ================================================================
        // まとめテストの編集: 設問数を増やして更新保存 → 引き続き点/ABCボタンなしで動く
        // ================================================================
        await page.evaluate((id) => { window.recEditTest(id); }, created.id);
        await new Promise(r => setTimeout(r, 100));
        const editFormUiState = await page.evaluate(() => ({
            modeToggleBtnCount: document.querySelectorAll('.rec-mq-mode-btn').length,
            qCount: document.getElementById('recMatomeQCount').value
        }));
        check('編集画面を開いた際もABCトグルボタンが存在しない', editFormUiState.modeToggleBtnCount === 0, JSON.stringify(editFormUiState));
        await page.evaluate(() => {
            document.getElementById('recMatomeQCount').value = '3';
            window.recRenderMatomePreview();
        });
        await new Promise(r => setTimeout(r, 100));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const updated = await page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(function(t) { return t.id === id; }), created.id);
        check('編集・更新保存: 設問数3・maxScore=15(5*3)に更新される', updated && updated.matomePoints.length === 3 && updated.maxScore === 15, JSON.stringify(updated));
        // 段階6でmatomeQuestionModes書き込み側自体を削除したため、更新後もフィールドが付かないことを確認する
        check('編集・更新保存: 更新後もmatomeQuestionModesフィールドが付かない(段階6でUI除去に伴い書き込み側も削除済み)', updated && !('matomeQuestionModes' in updated), JSON.stringify(updated));

        // ================================================================
        // 削除: まとめテストを削除すると採点画面が「未選択」状態に戻る
        // ================================================================
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        const beforeDelete = await page.evaluate(() => document.getElementById('recBulkWrap') ? document.getElementById('recBulkWrap').style.display !== 'none' : false);
        check('削除確認の前提: 採点画面が表示されている', beforeDelete === true, '');
        await page.evaluate((id) => { window.recDeleteTest(id); }, created.id);
        await new Promise(r => setTimeout(r, 150));
        const afterDelete = await page.evaluate(() => ({
            bulkHidden: document.getElementById('recBulkWrap') ? document.getElementById('recBulkWrap').style.display === 'none' : null,
            infoShown: document.getElementById('recInputInfo') ? document.getElementById('recInputInfo').style.display !== 'none' : null,
            stillInTests: !!StorageManager.get(KEYS.tests, []).find(function(t) { return t.name === 'ABC除去検証まとめ'; })
        }));
        check('削除: 採点エリアが隠れ「課題を選択」案内が出る', afterDelete.bulkHidden === true && afterDelete.infoShown === true, JSON.stringify(afterDelete));
        check('削除: テストがストレージから消える', afterDelete.stillInTests === false, JSON.stringify(afterDelete));

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
