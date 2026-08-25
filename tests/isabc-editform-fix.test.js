// 段階4-3 機械検証: recEditTest(index.html:9775付近)のisABC判定漏れ修正。
//
// 現象(段階4-2の調査で判明): category='主体性' かつ testType がルーブリック／実技記録／
// まとめテスト／単元テスト／授業態度 以外(例:小テスト)の組み合わせを編集画面で開くと、
// recEditTest内で一旦正しくdisabled=trueになった直後、recOnTestTypeChange()の冒頭の
// 既定リセット(category を見ない)で上書きされ、本来出ないはずの数値入力欄が
// 編集可能な状態で表示される。
//
// このファイルは「修正前に現象を再現し失敗することを確認してから修正する」という
// 手順そのものを記録するため、最初のブロックに再現専用のテストを独立して置く。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node isabc-editform-fix.test.js

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
        await page.evaluate(() => { window.showView('records'); window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));

        async function fillTestForm(fields) {
            await page.evaluate((f) => {
                if ('subject' in f) document.getElementById('recTestSubject').value = f.subject;
                if ('testType' in f) document.getElementById('recTestType').value = f.testType;
                if ('name' in f) document.getElementById('recTestName').value = f.name;
                if ('category' in f) document.getElementById('recTestCategory').value = f.category;
                if ('maxScore' in f) document.getElementById('recTestMaxScore').value = f.maxScore;
                if ('date' in f) document.getElementById('recTestDate').value = f.date;
            }, fields);
        }
        async function findTestByName(name) {
            return page.evaluate((n) => {
                var tests = StorageManager.get(KEYS.tests, []);
                return tests.find(function(t) { return t.name === n; }) || null;
            }, name);
        }
        async function maxScoreFieldState() {
            return page.evaluate(() => {
                var el = document.getElementById('recTestMaxScore');
                return { disabled: el.disabled, value: el.value, placeholder: el.placeholder };
            });
        }

        // ================================================================
        // 再現テスト: category='主体性' + testType='小テスト'(ABC評価専用の
        // 型分岐(まとめ/実技記録/授業態度/ルーブリック)のどれにも該当しない組み合わせ)
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'ISABC43_repro', category: '主体性', maxScore: '', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const created = await findTestByName('ISABC43_repro');
        check('前提: category=主体性+小テストの新規作成でmaxScore=0保存(段階4-2で確認済みの前提再確認)', created && created.maxScore === 0, JSON.stringify(created));

        await page.evaluate((id) => { window.recEditTest(id); }, created.id);
        const stateAfterEdit = await maxScoreFieldState();
        check('再現/修正確認: 編集画面を開くと満点入力欄がdisabled(ABC評価)になる', stateAfterEdit.disabled === true && stateAfterEdit.placeholder === 'ABC評価', JSON.stringify(stateAfterEdit));

        // ================================================================
        // 新規作成時の挙動が変わっていないこと(通常の型→category選択の順で正しく動く)
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '小テスト', name: '', category: '', maxScore: '', date: '' });
        await page.evaluate(() => { window.recOnTestTypeChange(); });
        const freshFormState = await maxScoreFieldState();
        check('新規作成: testType選択直後(category未選択)は満点入力欄が有効なまま', freshFormState.disabled === false, JSON.stringify(freshFormState));

        await page.evaluate(() => { document.getElementById('recTestCategory').value = '主体性'; window.recOnCategoryChange(); });
        const freshFormAfterCat = await maxScoreFieldState();
        check('新規作成: 続けてcategory=主体性を選択するとABC評価に切り替わる(recOnCategoryChange経由、既存動作)', freshFormAfterCat.disabled === true && freshFormAfterCat.placeholder === 'ABC評価', JSON.stringify(freshFormAfterCat));

        // ================================================================
        // 状態遷移: 編集画面を開く → testTypeを変更 → categoryを変更 → 保存 → 再描画
        // ================================================================
        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'ISABC43_transition', category: '知識・技能', maxScore: '60', date: '2026-06-01' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const tTransition = await findTestByName('ISABC43_transition');
        check('状態遷移(前提): 通常テストがmaxScore=60で作成されている', tTransition && tTransition.maxScore === 60, JSON.stringify(tTransition));

        await page.evaluate((id) => { window.recSelectTestGoto(id); }, tTransition.id);
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((id) => { window.recEditTest(id); }, tTransition.id);
        await page.evaluate(() => { document.getElementById('recTestType').value = '授業課題'; window.recOnTestTypeChange(); });
        await page.evaluate(() => { document.getElementById('recTestCategory').value = '主体性'; });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const afterTransitionSave = await page.evaluate((id) => StorageManager.get(KEYS.tests, []).find(function(t) { return t.id === id; }), tTransition.id);
        check('状態遷移: testType→授業課題・category→主体性 変更後、maxScore=0で保存される', afterTransitionSave && afterTransitionSave.maxScore === 0 && afterTransitionSave.testType === '授業課題' && afterTransitionSave.category === '主体性', JSON.stringify(afterTransitionSave));

        const rerenderState = await page.evaluate(() => ({
            hasScInput: !!document.getElementById('rec-sc-0'),
            abcBtnCount: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length
        }));
        check('状態遷移: 保存後の再描画でABCボタン(5個)に切り替わっている', rerenderState.abcBtnCount === 5 && rerenderState.hasScInput === false, JSON.stringify(rerenderState));

        await page.evaluate((id) => { window.recEditTest(id); }, tTransition.id);
        const reopenState = await maxScoreFieldState();
        check('状態遷移: 再度編集画面を開いても満点入力欄がdisabled(ABC評価)のまま', reopenState.disabled === true && reopenState.placeholder === 'ABC評価', JSON.stringify(reopenState));

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
