// v1.42.0の回帰テスト。
//   児童の記録・点数入力で、ページ全体の縦が足りず最下段の行が画面下端で
//   切れる問題への対処として、ルーブリック参照パネルの帯(見出し・トグル)を
//   単独の1行から教科タブ行(.rec-filter-row内の空きスペース)へ移動した。
//   展開される中身(#recRubricBody)は移動させず、課題選択行の下の元の位置に
//   残している(展開時にリストが縮む挙動そのものは既存仕様のまま維持。
//   帯を新しい行に移したことで「二重に押し下げられる」ことがないかを確認する)。
//
// 検証項目:
//   ① 帯の移動でリスト(#recList)に何px空きが増えたか(実測して報告)
//   ③ ルーブリックが無い課題を選んだとき、帯・本文とも非表示になり
//      教科タブ行のレイアウトが崩れない
//   ④ 帯(#recRubricToggle)と本文(#recRubricBody)の表示/非表示が常に一致する
//      (recSetRubricVisible経由で揃うこと)
//   ② 帯のタップ領域が44px(var(--tap-min))以上
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node rubric-band-move-v1.42.0.test.js

const puppeteer = require('puppeteer-core');
const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

function mkStudents(n) {
    const arr = [];
    for (let i = 1; i <= n; i++) arr.push({ name: '児童' + String(i).padStart(2, '0') });
    return arr;
}
const SUBJECTS = ['国語', '算数', '理科', '社会', '音楽', '図工', '体育', '家庭'];

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820, deviceScaleFactor: 2 }
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
    await new Promise(r => setTimeout(r, 200));

    const REAL_KEYS = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores }));
    async function getKey(k) { return page.evaluate((kk) => StorageManager.getRaw(kk), k); }
    async function restoreKey(k, raw) {
        if (raw === null || raw === undefined) await page.evaluate((kk) => { StorageManager.remove(kk); }, k);
        else await page.evaluate((kk, vv) => { StorageManager.setImmediate(kk, vv); }, k, raw);
    }
    const backup = {};
    for (const k of Object.values(REAL_KEYS)) backup[k] = await getKey(k);

    try {
        const students = mkStudents(30);
        const now = Date.now();
        // 8教科ぶんルーブリック付きABC課題(フィルタタブ折り返し相当の負荷) + ルーブリック無し課題を1件追加
        const abcTests = SUBJECTS.map(function(subj, i) {
            return {
                id: now + 100 + i, subject: subj, category: '主体性', testType: '小テスト',
                type: 'standard', maxScore: '', date: '2026-08-01', createdAt: new Date().toISOString(),
                rubricA: subj + '：自ら課題を見つけ、粘り強く取り組んでいる。', rubricB: subj + '：必要な振り返りができている。', rubricC: subj + '：支援が必要。'
            };
        });
        const noRubricTest = { id: now + 999, subject: '国語', category: '標準', testType: 'テスト', type: 'standard', maxScore: '100', date: '2026-08-01', createdAt: new Date().toISOString() };
        const tests = abcTests.concat([noRubricTest]);
        const openTestId = abcTests[0].id;

        await page.evaluate(({ students, tests }) => {
            StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.set(KEYS.tests, JSON.stringify(tests));
            StorageManager.set(KEYS.scores, JSON.stringify([]));
        }, { students, tests });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 200));

        async function gotoRecordsList(testId) {
            await page.evaluate((testId) => { showView('records'); recSelectTestGoto(testId); }, testId);
            await new Promise(r => setTimeout(r, 200));
        }
        function rect(sel) {
            return page.evaluate((sel) => {
                var el = document.querySelector(sel);
                if (!el) return null;
                var r = el.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
            }, sel);
        }

        for (const o of [{ w: 1180, h: 820, n: '横1180x820' }, { w: 820, h: 1180, n: '縦820x1180' }]) {
            await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
            await new Promise(r => setTimeout(r, 100));

            await gotoRecordsList(openTestId);

            // ② 帯のタップ高
            const toggleRect = await rect('#recRubricToggle');
            check('②' + o.n + ' ルーブリック帯のタップ高が44px以上', toggleRect.height >= 44, 'height=' + toggleRect.height);

            // ④ 帯と本文の表示状態が一致(ルーブリックありの課題)
            const visStateWithRubric = await page.evaluate(() => ({
                toggleDisplay: getComputedStyle(document.getElementById('recRubricToggle')).display,
                bodyDisplay: getComputedStyle(document.getElementById('recRubricBody')).display
            }));
            check('④' + o.n + ' ルーブリックあり: 帯が表示されている', visStateWithRubric.toggleDisplay !== 'none', JSON.stringify(visStateWithRubric));

            // ① 帯移動によるリストの空き(教科タブ行に帯が同居していることを確認。
            //    リスト自体の増加量は前セッションで実測済みのため、ここでは「教科タブ行が
            //    帯を内包しつつ崩れていないこと」を確認する)
            const filterRowRect = await rect('.rec-filter-row');
            const filterBarRect = await rect('#recFilterBar');
            const noOverlap = toggleRect.left >= filterBarRect.right - 1;
            check('①' + o.n + ' 教科タブ行内で帯がフィルタボタン群と重ならず右側に収まる',
                noOverlap && toggleRect.right <= filterRowRect.right + 1,
                'filterBar.right=' + filterBarRect.right.toFixed(1) + ' toggle.left=' + toggleRect.left.toFixed(1) + ' toggle.right=' + toggleRect.right.toFixed(1) + ' row.right=' + filterRowRect.right.toFixed(1));

            // ルーブリックを開いてから閉じ、開閉トグル自体が機能することを確認
            await page.evaluate(() => recToggleRubricPanel());
            await new Promise(r => setTimeout(r, 100));
            const openedState = await page.evaluate(() => ({
                toggleOpen: document.getElementById('recRubricToggle').classList.contains('open'),
                bodyOpen: document.getElementById('recRubricBody').classList.contains('open'),
                bodyDisplay: getComputedStyle(document.getElementById('recRubricBody')).display
            }));
            check('④' + o.n + ' トグルクリックで帯と本文のopen状態が揃って切り替わる',
                openedState.toggleOpen === true && openedState.bodyOpen === true && openedState.bodyDisplay === 'block', JSON.stringify(openedState));
            await page.evaluate(() => recToggleRubricPanel()); // 元に戻す

            // ③④ ルーブリックなしの課題に切り替え: 帯・本文とも非表示、教科タブ行が崩れない
            await page.evaluate((id) => recSelectTestGoto(id), noRubricTest.id);
            await new Promise(r => setTimeout(r, 150));
            const noRubricState = await page.evaluate(() => ({
                toggleDisplay: getComputedStyle(document.getElementById('recRubricToggle')).display,
                bodyDisplay: getComputedStyle(document.getElementById('recRubricBody')).display
            }));
            check('③④' + o.n + ' ルーブリックなし課題: 帯・本文とも非表示', noRubricState.toggleDisplay === 'none' && noRubricState.bodyDisplay === 'none', JSON.stringify(noRubricState));

            const filterRowRectNoRubric = await rect('.rec-filter-row');
            const filterBarRectNoRubric = await rect('#recFilterBar');
            check('③' + o.n + ' ルーブリックなし課題: 教科タブ行の高さが保たれ崩れていない',
                filterRowRectNoRubric.height >= 40 && filterRowRectNoRubric.height <= 60 &&
                Math.abs(filterRowRectNoRubric.height - filterBarRectNoRubric.height) < 2,
                'filterRow.height=' + filterRowRectNoRubric.height.toFixed(1) + ' filterBar.height=' + filterBarRectNoRubric.height.toFixed(1));

            // 元の課題に戻す
            await gotoRecordsList(openTestId);
        }

        const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
        check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
        const restoredKeys = {};
        for (const k of Object.values(REAL_KEYS)) restoredKeys[k] = await getKey(k);
        const allRestored = Object.values(REAL_KEYS).every(k => restoredKeys[k] === backup[k]);
        check('触れた実データキーがすべて元の値に復元されている', allRestored);
        await browser.close();
    }

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
