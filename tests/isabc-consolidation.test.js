// 段階4-2 機械検証: isABC判定(category==='主体性' || testType==='ルーブリック')の
// 分散していた8箇所(うち7箇所が対象、9762行目のドリフトは別タスクとして未修正のまま残す)を
// isABCTest(category, testType) に集約したことの回帰確認。
//
// 最重要: recAddTest() の maxScore決定式(9629-9630行目付近)は isABC の「計算方法」にのみ
// 依存する。isABCTest()の返り値が旧来の直書き条件と完全に一致する限り、この式の出力は
// 集約の前後で不変のはず。以下の6パターンで実測する。
//
// 状態遷移(一度描画した画面への操作だけでは不十分。段階1・2で「テストは通るが実機で壊れる」
// 事故が連続したため): 新規作成→保存→再描画/課題切り替えて戻る/category変更に追随/削除後の再描画
// を、実際の window.recAddTest / recEditTest / recSelectTestGoto / recDeleteTest 呼び出しで再現する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node isabc-consolidation.test.js

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
                students: [{ name: '児童1' }, { name: '児童2' }],
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([]));
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));

        // 課題管理タブを開く(記録タブ→課題管理サブタブ)
        await page.evaluate(() => { window.showView('records'); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate(() => { window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));

        async function fillTestForm(fields) {
            await page.evaluate((f) => {
                if ('subject' in f) document.getElementById('recTestSubject').value = f.subject;
                if ('testType' in f) document.getElementById('recTestType').value = f.testType;
                if ('name' in f) document.getElementById('recTestName').value = f.name;
                if ('category' in f) document.getElementById('recTestCategory').value = f.category;
                if ('maxScore' in f) document.getElementById('recTestMaxScore').value = f.maxScore;
                if ('date' in f) document.getElementById('recTestDate').value = f.date;
                if ('matomeQCount' in f) document.getElementById('recMatomeQCount').value = f.matomeQCount;
            }, fields);
        }
        async function findTestByName(name) {
            return page.evaluate((n) => {
                var tests = StorageManager.get(KEYS.tests, []);
                return tests.find(function(t) { return t.name === n; }) || null;
            }, name);
        }

        // ================================================================
        // (a) recAddTest の maxScore決定式: 6パターン網羅
        // 期待値はabcTo10とは無関係にrecAddTest自身の式(9629-9630行目付近)から導かれる
        // リテラル値。isABCTest集約の前後で変わらないことをこのテストで保証する。
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'ISABC_主体性', category: '主体性', maxScore: '', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tCategoryOnly = await findTestByName('ISABC_主体性');
        check('パターン1 category=主体性: maxScore=0', tCategoryOnly && tCategoryOnly.maxScore === 0, JSON.stringify(tCategoryOnly));

        await fillTestForm({ subject: '家庭', testType: 'ルーブリック', name: 'ISABC_ルーブリック', category: '知識・技能', maxScore: '', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tRubric = await findTestByName('ISABC_ルーブリック');
        check('パターン2 testType=ルーブリック(category=知識・技能): maxScore=0', tRubric && tRubric.maxScore === 0, JSON.stringify(tRubric));

        await fillTestForm({ subject: '体育', testType: '授業態度', name: 'ISABC_授業態度', category: '知識・技能', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tAttitude = await findTestByName('ISABC_授業態度');
        check('パターン3 授業態度: maxScore=10', tAttitude && tAttitude.maxScore === 10, JSON.stringify(tAttitude));

        await fillTestForm({ subject: '体育', testType: '実技記録', name: 'ISABC_実技記録', category: '知識・技能', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tPE = await findTestByName('ISABC_実技記録');
        check('パターン4 実技記録: maxScore=9999', tPE && tPE.maxScore === 9999, JSON.stringify(tPE));

        // まとめテスト: 種別選択でrecOnTestTypeChange→recRenderMatomePreviewが走り、
        // 設問数を2に絞ると既定配点5点×2問=10点になる(recRenderMatomePreviewの既定値'5'、index.html該当箇所)。
        await fillTestForm({ subject: '算数', testType: 'まとめテスト', name: 'ISABC_まとめ', date: '2026-06-01' });
        await page.evaluate(() => {
            document.getElementById('recMatomeQCount').value = '2';
            window.recRenderMatomePreview();
        });
        await new Promise(r => setTimeout(r, 100));
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tMatome = await findTestByName('ISABC_まとめ');
        check('パターン5 まとめテスト(設問2問×既定5点): maxScore=10(=matomeMaxScore)', tMatome && tMatome.maxScore === 10, JSON.stringify(tMatome));

        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'ISABC_通常', category: '知識・技能', maxScore: '80', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tNormal = await findTestByName('ISABC_通常');
        check('パターン6 通常の得点テスト(満点80): maxScore=80', tNormal && tNormal.maxScore === 80, JSON.stringify(tNormal));

        // ================================================================
        // (b) 状態遷移: 新規作成→保存→再描画後も同じ判定・同じ入力UIが出ること
        // ================================================================
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, tCategoryOnly.id);
        await new Promise(r => setTimeout(r, 150));
        const afterCreateAbc = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('状態遷移: 主体性テスト作成直後、得点入力欄が出ない', afterCreateAbc.hasScInput === false, JSON.stringify(afterCreateAbc));
        check('状態遷移: 主体性テスト作成直後、ABCボタン(5個)が出る', afterCreateAbc.abcBtnCount === 5, JSON.stringify(afterCreateAbc));

        const listShowsAbcLabel = await page.evaluate((id) => {
            var el = document.querySelector('.rec-test-item .rec-test-item-info[onclick*="' + id + '"]');
            return el ? el.closest('.rec-test-item').textContent.indexOf('ABC評価') >= 0 : null;
        }, tCategoryOnly.id);
        check('状態遷移: 課題一覧カードに「ABC評価」表示が出る', listShowsAbcLabel === true, String(listShowsAbcLabel));

        // --- 課題を切り替えて戻る ---
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, tNormal.id);
        await new Promise(r => setTimeout(r, 150));
        const switchedToNormal = await page.evaluate(() => !!document.getElementById('rec-sc-0'));
        check('課題切り替え: 通常テストへ切り替えると得点入力欄が出る', switchedToNormal === true, '');

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, tCategoryOnly.id);
        await new Promise(r => setTimeout(r, 150));
        const backToAbc = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('課題切り替え: 主体性テストに戻るとABCボタン(5個)に戻る', backToAbc.abcBtnCount === 5 && backToAbc.hasScInput === false, JSON.stringify(backToAbc));

        // --- categoryを変更したときに判定が追随する(testType=ルーブリックは踏まない: 9762行目の
        //     既知ドリフト(別タスク)を避けるため、tNormal(小テスト)のcategoryのみ変更する)。
        //     rec-sc-0/rec-row-0 は「現在選択中のテスト」の行に対して使い回されるDOM idのため、
        //     編集対象を先に明示的に選択してから判定する(選択を切り替え忘れると別テストの
        //     表示を見て誤ってPASSする)。 ---
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, tNormal.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recEditTest(id); }, tNormal.id);
        await page.evaluate(() => { document.getElementById('recTestCategory').value = '主体性'; });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterCategoryToAbc = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('category変更: 知識・技能→主体性でABCボタンに切り替わる', afterCategoryToAbc.abcBtnCount === 5 && afterCategoryToAbc.hasScInput === false, JSON.stringify(afterCategoryToAbc));

        await page.evaluate((id) => { window.recEditTest(id); }, tNormal.id);
        await page.evaluate(() => { document.getElementById('recTestCategory').value = '知識・技能'; document.getElementById('recTestMaxScore').value = '80'; });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterCategoryBack = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('category変更(復帰): 主体性→知識・技能で得点入力欄に戻る', afterCategoryBack.hasScInput === true && afterCategoryBack.abcBtnCount === 0, JSON.stringify(afterCategoryBack));

        // --- 削除後の再描画 ---
        // rec-sc-0はテスト固有ではなく「現在選択中のテストの児童0行」のidのため、削除後に
        // 他のテストへ自動選択が移ると存在し続ける可能性がある。既存のtest_grades.jsと同じ
        // recBulkWrap/recInputInfoの表示状態(「課題を選択」案内)で判定する。
        const createdId = tAttitude.id;
        await page.evaluate((id) => { window.recSelectTestGoto(id); }, createdId);
        await new Promise(r => setTimeout(r, 150));
        const beforeDelete = await page.evaluate(() => !!document.getElementById('rec-sc-0'));
        check('削除確認の前提: 削除対象の採点画面が表示されている', beforeDelete === true, '');

        await page.evaluate((id) => { window.recDeleteTest(id); }, createdId);
        await new Promise(r => setTimeout(r, 150));
        const afterDelete = await page.evaluate(() => ({
            bulkHidden: document.getElementById('recBulkWrap') ? document.getElementById('recBulkWrap').style.display === 'none' : null,
            infoShown: document.getElementById('recInputInfo') ? document.getElementById('recInputInfo').style.display !== 'none' : null
        }));
        check('削除後の再描画: 採点エリアが隠れ「課題を選択」案内が出る', afterDelete.bulkHidden === true && afterDelete.infoShown === true, JSON.stringify(afterDelete));
        const stillInTests = await page.evaluate((id) => !!StorageManager.get(KEYS.tests, []).find(function(t) { return t.id === id; }), createdId);
        check('削除後の再描画: 削除した課題がストレージから消える', stillInTests === false, String(stillInTests));

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
