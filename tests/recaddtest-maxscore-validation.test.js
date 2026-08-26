// 段階9-1 機械検証: recAddTest の満点未入力バリデーションを検証する。
//
//   if (!isABC && !isPE && !isMatome && !isAttitude && (!maxScore || maxScore <= 0)) {
//       showToast('満点を入力してください', 'warning');
//       return;
//   }
//
// これは「満点を入れ忘れた得点型テストが作られること」を防ぐ最後の砦。ここが壊れると
// maxScore=0の得点型テストができ、grdCalculateのscoreTo10(sr.score, test.maxScore || 100)
// フォールバックで100点満点として誤計算される危険がある。isABC/isPE/isMatome/isAttitude
// の4条件はどれも直接比較(isABCTest経由含む)で、isABCTestの条件は段階8・8-2で2回増えている。
// 今後も条件が増えるたびに影響を受けるため、このファイル単体でガードを再検証できるようにする。
//
// 実装コード(index.html)は本テストの追加にあたり一切変更していない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node recaddtest-maxscore-validation.test.js

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

        async function fillTestForm(fields) {
            await page.evaluate((f) => {
                if ('subject' in f) document.getElementById('recTestSubject').value = f.subject;
                if ('testType' in f) { document.getElementById('recTestType').value = f.testType; window.recOnTestTypeChange(); }
                if ('name' in f) document.getElementById('recTestName').value = f.name;
                if ('category' in f) { document.getElementById('recTestCategory').value = f.category; window.recOnCategoryChange(); }
                if ('date' in f) document.getElementById('recTestDate').value = f.date;
                if ('maxScore' in f) document.getElementById('recTestMaxScore').value = f.maxScore;
            }, fields);
        }
        async function findTestByName(name) {
            return page.evaluate((n) => {
                var tests = StorageManager.get(KEYS.tests, []);
                return tests.find(function(t) { return t.name === n; }) || null;
            }, name);
        }
        async function toastState() {
            return page.evaluate(() => {
                var t = document.getElementById('toast');
                var msgEl = document.getElementById('toastMsg');
                return { shown: t ? t.classList.contains('show') : false, msg: msgEl ? msgEl.textContent : null };
            });
        }
        async function clearToast() {
            // 直前のトーストの「表示中」状態が次のケースの判定に紛れ込まないよう、
            // 明示的に隠してから次のケースを実行する。
            await page.evaluate(() => {
                var t = document.getElementById('toast');
                if (t) t.classList.remove('show');
            });
        }

        // ================================================================
        // 保存拒否ケース(A/B/C): 得点型テストで満点が未入力・0・負の値
        // ================================================================
        const rejectCases = [
            { label: 'A. 満点未入力', name: 'MSV91_未入力', maxScore: '' },
            { label: 'B. 満点=0',   name: 'MSV91_ゼロ',   maxScore: '0' },
            { label: 'C. 満点=-5',  name: 'MSV91_負値',   maxScore: '-5' }
        ];
        for (const c of rejectCases) {
            await clearToast();
            await fillTestForm({ subject: '国語', testType: '小テスト', name: c.name, category: '知識・技能', date: '2026-06-01', maxScore: c.maxScore });
            await page.evaluate(() => { window.recAddTest(); });
            await new Promise(r => setTimeout(r, 150));
            const created = await findTestByName(c.name);
            check(c.label + ': 保存されない', created === null, JSON.stringify(created));
            const ts = await toastState();
            check(c.label + ': 「満点を入力してください」の警告トーストが出る', ts.shown === true && ts.msg === '満点を入力してください', JSON.stringify(ts));
        }

        // ================================================================
        // 保存許可ケース(D): 得点型テストで満点に正の値
        // ================================================================
        await clearToast();
        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'MSV91_正常', category: '知識・技能', date: '2026-06-01', maxScore: '100' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdD = await findTestByName('小テ_MSV91_正常'); // 小テスト自動プレフィックス
        check('D. 満点=100: 保存される(maxScore=100)', createdD && createdD.maxScore === 100, JSON.stringify(createdD));

        // ================================================================
        // 保存許可ケース(E〜K): isABC/isPE/isMatome/isAttitudeの除外が効いている
        // (=バリデーションが過剰に効いていないこと)ことの確認
        // ================================================================
        await clearToast();
        await fillTestForm({ subject: '国語', testType: '小テスト', name: 'MSV91_主体性', category: '主体性', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdE = await findTestByName('小テ_MSV91_主体性'); // 小テスト自動プレフィックス
        check('E. category=主体性(isABC)+満点未入力: 保存される(maxScore=0)', createdE && createdE.maxScore === 0, JSON.stringify(createdE));

        await clearToast();
        await fillTestForm({ subject: '国語', testType: 'ルーブリック', name: 'MSV91_ルーブリック', category: '知識・技能', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdF = await findTestByName('ル【知技】MSV91_ルーブリック');
        check('F. testType=ルーブリック+満点未入力: 保存される(maxScore=0)', createdF && createdF.maxScore === 0, JSON.stringify(createdF));

        await clearToast();
        await fillTestForm({ subject: '国語', testType: '記述問題', name: 'MSV91_記述問題', category: '知識・技能', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdG = await findTestByName('記述_MSV91_記述問題');
        check('G. testType=記述問題+満点未入力: 保存される(maxScore=0)', createdG && createdG.maxScore === 0, JSON.stringify(createdG));

        await clearToast();
        await fillTestForm({ subject: '国語', testType: '作文', name: 'MSV91_作文', category: '知識・技能', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdH = await findTestByName('作文_MSV91_作文');
        check('H. testType=作文+満点未入力: 保存される(maxScore=0)', createdH && createdH.maxScore === 0, JSON.stringify(createdH));

        await clearToast();
        await fillTestForm({ subject: '体育', testType: '実技記録', name: 'MSV91_実技記録', category: '知識・技能', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdI = await findTestByName('実技_MSV91_実技記録');
        check('I. testType=実技記録+満点未入力: 保存される(maxScore=9999)', createdI && createdI.maxScore === 9999, JSON.stringify(createdI));

        await clearToast();
        await fillTestForm({ subject: '国語', testType: '授業態度', name: 'MSV91_授業態度', category: '主体性', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdJ = await findTestByName('態度_MSV91_授業態度');
        check('J. testType=授業態度+満点未入力: 保存される(maxScore=10)', createdJ && createdJ.maxScore === 10, JSON.stringify(createdJ));

        await clearToast();
        await fillTestForm({ subject: '算数', testType: 'まとめテスト', name: 'MSV91_まとめ', category: '', date: '2026-06-01', maxScore: '' });
        await page.evaluate(() => { window.recAddTest(); });
        await new Promise(r => setTimeout(r, 150));
        const createdK = await findTestByName('まテ_MSV91_まとめ');
        check('K. testType=まとめテスト+満点未入力: 保存される(設問配点の合計、既定10問×5点=50)', createdK && createdK.maxScore === 50, JSON.stringify(createdK));

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
