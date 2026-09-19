// 課題の編集で観点(category)を変えたとき、入力形式(inputMode)と満点(maxScore)が矛盾しないこと。
//
// 経緯: v1.49.0で recAddTest が入力形式を「フォームのタブ状態」で決めるようになった。観点セレクトの
// onchange はタブを自動で切り替える(知識・技能→主体性なら5段階)が、保存時は「タブに触れていない編集は
// 元データの inputMode フラグをそのまま引き継ぐ」ため、{category:'主体性', maxScore:0, inputMode:'score'} という
// 矛盾したデータになり、入力画面が満点0の数値欄になっていた。
// 得点が入力済みの課題は入力形式をロックする仕様なので、観点を変えてもタブは自動で切り替えない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node category-edit-inputmode.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    page.on('dialog', d => d.accept());

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const backup = await page.evaluate(() => [StorageManager.getRaw(KEYS.master), StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores)]);

    async function fresh() {
        await page.evaluate(() => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: '甲' }, { name: '乙' }], classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.setImmediate(KEYS.tests, '[]');
            StorageManager.setImmediate(KEYS.scores, '[]');
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
    }
    // 実UIと同じ順序(種別→名前→観点→満点→日付、種別・観点は onchange 発火)で新規作成
    async function createTest(name, category, max) {
        return page.evaluate((name, category, max) => {
            const set = (id, v) => { document.getElementById(id).value = v; };
            showView('records'); recShowSub('tests');
            set('recTestSubject', '国語'); set('recTestType', '小テスト'); recOnTestTypeChange();
            set('recTestName', name); set('recTestCategory', category); recOnCategoryChange();
            if (max) set('recTestMaxScore', max);
            set('recTestDate', '2026-06-01');
            recAddTest();
            return StorageManager.get(KEYS.tests, []).find(t => t.name.indexOf(name) !== -1);
        }, name, category, max);
    }
    // 課題を編集して観点だけ変更(観点セレクトの onchange 発火)して保存
    async function editCategory(id, category, max) {
        return page.evaluate((id, category, max) => {
            const set = (idd, v) => { document.getElementById(idd).value = v; };
            recSelectTestGoto(id); recEditTest(id);
            set('recTestCategory', category); recOnCategoryChange();
            if (max) set('recTestMaxScore', max);
            const tabAbc = document.getElementById('recInputModeAbc5Btn').classList.contains('active');
            recAddTest();
            const t = StorageManager.get(KEYS.tests, []).find(t => t.id === id);
            return {
                cat: t.category, max: t.maxScore, mode: t.inputMode, effective: getItemInputMode(t), tabAbc: tabAbc,
                hasNum: !!document.getElementById('rec-sc-0'), abcBtns: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length,
                maxAttr: document.getElementById('rec-sc-0') ? document.getElementById('rec-sc-0').getAttribute('max') : null,
                pct: document.getElementById('rec-pct-0') ? document.getElementById('rec-pct-0').textContent : null
            };
        }, id, category, max);
    }

    try {
        // (1) 得点未入力: 知識・技能(得点80) → 主体性 : 5段階に追随し、maxScore=0・inputMode=abc5
        await fresh();
        let t = await createTest('CE1', '知識・技能', '80');
        check('前提: 新規作成は 得点(score)・満点80', t && t.maxScore === 80 && t.inputMode === 'score', JSON.stringify(t));
        let r = await editCategory(t.id, '主体性');
        check('得点未入力で 知識・技能→主体性: 保存は maxScore=0・inputMode=abc5(矛盾しない)', r.cat === '主体性' && r.max === 0 && r.mode === 'abc5', JSON.stringify(r));
        check('得点未入力で 知識・技能→主体性: 入力画面は5段階ボタンになる', r.abcBtns === 5 && r.hasNum === false, JSON.stringify(r));

        // (2) さらに 主体性 → 知識・技能(満点60): 得点に戻る
        r = await editCategory(t.id, '知識・技能', '60');
        check('得点未入力で 主体性→知識・技能: 保存は maxScore=60・inputMode=score', r.cat === '知識・技能' && r.max === 60 && r.mode === 'score', JSON.stringify(r));
        check('得点未入力で 主体性→知識・技能: 入力画面は得点欄になる', r.hasNum === true && r.abcBtns === 0, JSON.stringify(r));

        // (3) 得点入力済み: 観点を変えても入力形式はロックされたまま(タブは切り替わらず、maxScoreも保持)
        await fresh();
        t = await createTest('CE2', '知識・技能', '80');
        await page.evaluate((id) => {
            const scores = [{ id: 1, studentIndex: 0, testId: id, score: 70, createdAt: new Date().toISOString() }];
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            recInvalidateCache();
        }, t.id);
        r = await editCategory(t.id, '主体性');
        check('得点入力済みで 知識・技能→主体性: 入力形式は score のまま・maxScore=80を保持(数値データと矛盾しない)', r.cat === '主体性' && r.max === 80 && r.effective === 'score', JSON.stringify(r));
        check('得点入力済みで 知識・技能→主体性: 観点変更でタブが5段階に自動で切り替わらない', r.tabAbc === false, JSON.stringify(r));

        // (4) フラグの無い既存項目(v1.49.0以前のデータ)でも、観点変更後の入力形式が観点に追随する
        await fresh();
        await page.evaluate(() => {
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([{ id: 7, subject: '国語', testType: '小テスト', name: '旧データ', category: '知識・技能', type: 'standard', maxScore: 50, date: '2026-06-01' }]));
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        await page.evaluate(() => { showView('records'); recShowSub('tests'); });
        r = await editCategory(7, '主体性');
        check('フラグ無しの既存項目 知識・技能→主体性: 5段階(maxScore=0)で保存され、入力画面もABCボタン', r.max === 0 && r.effective === 'abc5' && r.abcBtns === 5, JSON.stringify(r));

        // (5) フラグの無い既存項目(v1.49.0以前のデータ)で、得点(数値)が入力済み: 観点を 主体性 に変えても数値のまま(ロック)。
        //     戻して満点を直すと、その満点で割合が出る。(修正前: 主体性へ変えると「5段階」に化け、戻すと満点0になり割合が出なかった)
        await fresh();
        await page.evaluate(() => {
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([{ id: 8, subject: '国語', testType: '小テスト', name: '旧データ得点あり', category: '知識・技能', type: 'standard', maxScore: 15, date: '2026-06-01' }]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([{ id: 1, studentIndex: 0, testId: 8, score: 13, createdAt: new Date().toISOString() }]));
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        await page.evaluate(() => { showView('records'); recShowSub('tests'); });
        r = await editCategory(8, '主体性');
        check('旧データ(印なし)・得点入力済みで 知識・技能→主体性: 数値のまま(入力形式は score)・満点15を保持し、入力画面も得点欄', r.cat === '主体性' && r.max === 15 && r.effective === 'score' && r.hasNum === true && r.abcBtns === 0, JSON.stringify(r));
        check('  → 入力済みの得点(13)は数値のままで、割合が表示される(13/15→87%)', r.pct === '／15(87%)', JSON.stringify(r));
        r = await editCategory(8, '知識・技能', '20');
        check('旧データ(印なし)・得点入力済みで 主体性→知識・技能(満点を20に直す): 満点20で保存され、割合が出る(13/20→65%)', r.cat === '知識・技能' && r.max === 20 && r.effective === 'score' && r.pct === '／20(65%)', JSON.stringify(r));
        check('  → 入力欄の max 属性が満点(20)で、0にならない', r.maxAttr === '20', JSON.stringify(r));

        // (6) 逆向き: フラグの無い既存の 主体性(5段階)項目に、ABC(文字)の記録が入力済み: 観点を 知識・技能 に変えても5段階のまま
        await fresh();
        await page.evaluate(() => {
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([{ id: 9, subject: '国語', testType: '小テスト', name: '旧データABC', category: '主体性', type: 'standard', maxScore: 0, date: '2026-06-01' }]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([{ id: 1, studentIndex: 0, testId: 9, score: 'A', createdAt: new Date().toISOString() }]));
        });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        await page.evaluate(() => { showView('records'); recShowSub('tests'); });
        r = await editCategory(9, '知識・技能', '50');
        check('旧データ(印なし)・ABC入力済みで 主体性→知識・技能: 5段階のまま(maxScore=0)で、入力画面もABCボタン(文字の記録と矛盾しない)', r.cat === '知識・技能' && r.max === 0 && r.effective === 'abc5' && r.abcBtns === 5 && r.hasNum === false, JSON.stringify(r));
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        await page.evaluate((b) => {
            ['master', 'tests', 'scores'].forEach((k, i) => { if (b[i] === null) StorageManager.remove(KEYS[k]); else StorageManager.setImmediate(KEYS[k], b[i]); });
        }, backup);
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== category-edit-inputmode: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
