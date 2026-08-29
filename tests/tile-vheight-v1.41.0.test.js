// v1.41.0の回帰テスト。
//   実機(iPad Safari)で確認された「ボタン枠がタイル下端を突き抜ける」縦方向の
//   はみ出しに対し、.rec-row.abc-row / .sub-input-row のpadding・gap・
//   ボタン高・ヘッダー要素高を詰めて合計高をmin-height以内に収めた。
//   あわせて.sub-input-rowの「お直し完了」チェックボックスは、タップ領域を
//   ::before疑似要素で非対称に拡張し(下記CSS参照)、隣接する欠席ボタン/
//   氏名/○△ボタンのタップを奪わないようにした。
//
// 検証項目:
//   ① .rec-row.abc-row / .sub-input-row の実高がmin-height以内に収まる
//      (content < min-heightとなり、min-heightが実効フロアとして機能する)
//   ② ボタンのタップ高が44px(var(--tap-min))以上
//   ③ A/B+/B/B-/Cが折り返さず1行、並び順維持
//   ④ チェックボックスの拡張タップ領域・隣接要素(欠席ボタン/番号バッジ/
//      ○△ボタン)がそれぞれ意図した要素だけをクリックできる(実クリックで検証)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node tile-vheight-v1.41.0.test.js

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

    const REAL_KEYS = await page.evaluate(() => ({
        master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores,
        submissions_assignments: KEYS.submissions_assignments, submissions_data: KEYS.submissions_data
    }));
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
        const abcTests = SUBJECTS.map(function(subj, i) {
            return {
                id: now + 100 + i, subject: subj, category: '主体性', testType: '小テスト',
                type: 'standard', maxScore: '', date: '2026-08-01', createdAt: new Date().toISOString(),
                rubricA: subj + '：A', rubricB: subj + '：B', rubricC: subj + '：C'
            };
        });
        const openTestId = abcTests[0].id;
        const assignments = SUBJECTS.map(function(subj, i) {
            return { id: now + 200 + i, subject: subj, name: subj + '課題', date: '2026-08-01', createdAt: new Date().toISOString() };
        });
        const openAssignId = assignments[0].id;

        await page.evaluate(({ students, tests, assignments }) => {
            StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.set(KEYS.tests, JSON.stringify(tests));
            StorageManager.set(KEYS.scores, JSON.stringify([]));
            StorageManager.set(KEYS.submissions_assignments, JSON.stringify(assignments));
            StorageManager.set(KEYS.submissions_data, JSON.stringify([]));
        }, { students, tests: abcTests, assignments });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 200));

        async function gotoRecordsList(testId) {
            await page.evaluate((testId) => { showView('records'); recSelectTestGoto(testId); }, testId);
            await new Promise(r => setTimeout(r, 200));
        }
        async function gotoSubmissionsList(assignId) {
            await page.evaluate((assignId) => {
                showView('submissions');
                var sel = document.getElementById('subInputAssignSel');
                sel.value = String(assignId);
                sel.dispatchEvent(new Event('change'));
                document.getElementById('subViewListBtn').click();
            }, assignId);
            await new Promise(r => setTimeout(r, 200));
        }
        function rect(sel) {
            return page.evaluate((sel) => {
                var el = document.querySelector(sel);
                if (!el) return null;
                var r = el.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height,
                    cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
            }, sel);
        }

        for (const o of [{ w: 1180, h: 820, n: '横1180x820' }, { w: 820, h: 1180, n: '縦820x1180' }]) {
            await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
            await new Promise(r => setTimeout(r, 100));

            // --- 児童の記録(ABC) ---
            await gotoRecordsList(openTestId);
            // 実測メモ: #view-recordsのリストはdisplay:gridかつflex:1で、リスト側に
            // 余剰な縦スペースがあるとalign-content:normal(=stretch)が各行トラックを
            // min-heightより引き伸ばす(これ自体は無害。中身が縮んだことの確認にはならない
            // ため、行の「自然な内容量」をpadding/border/子要素の実測から直接積み上げて検証する)。
            const abc = await page.evaluate(() => {
                var row = document.querySelector('.rec-row.abc-row');
                var hd = row.querySelector('.rec-row-hd');
                var btnsWrap = row.querySelector('.rec-abc-btns');
                var btns = Array.from(row.querySelectorAll('.rec-abc-btn'));
                var cs = getComputedStyle(row);
                var contentHeight = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
                    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
                    + hd.getBoundingClientRect().height + parseFloat(cs.rowGap)
                    + btnsWrap.getBoundingClientRect().height;
                return {
                    contentHeight: contentHeight,
                    btnTexts: btns.map(function(b) { return b.textContent; }),
                    btnTops: btns.map(function(b) { return Math.round(b.getBoundingClientRect().top); }),
                    btnHeights: btns.map(function(b) { return b.getBoundingClientRect().height; })
                };
            });
            check('①' + o.n + ' .rec-row.abc-row の内容量(padding+border+hd+gap+btns)がmin-height(86px)以内',
                abc.contentHeight <= 86, 'contentHeight=' + abc.contentHeight.toFixed(1) + 'px');
            check('②' + o.n + ' .rec-abc-btn 全ボタンが44px以上',
                abc.btnHeights.every(function(h) { return h >= 44; }), JSON.stringify(abc.btnHeights));
            check('③' + o.n + ' A/B+/B/B-/Cが1行・順序維持',
                JSON.stringify(abc.btnTexts) === JSON.stringify(['A', 'B+', 'B', 'B-', 'C']) &&
                new Set(abc.btnTops).size === 1,
                JSON.stringify(abc.btnTexts) + ' tops=' + JSON.stringify(abc.btnTops));

            // ④ abc-rowの欠席ボタン・番号バッジが実クリックで機能する
            const absentBtnRect = await rect('#rec-row-0 .sub-absent-btn');
            await page.mouse.click(absentBtnRect.cx, absentBtnRect.cy);
            await new Promise(r => setTimeout(r, 100));
            const absentOn = await page.evaluate(() => document.querySelector('#rec-row-0 .sub-absent-btn').classList.contains('absent-on'));
            check('④' + o.n + ' rec-row: 欠席ボタンをクリックすると欠席状態になる', absentOn === true);
            // 元に戻す
            await page.mouse.click(absentBtnRect.cx, absentBtnRect.cy);
            await new Promise(r => setTimeout(r, 100));

            const abcBtnARect = await rect('#rec-row-0 .rec-abc-btn');
            await page.mouse.click(abcBtnARect.cx, abcBtnARect.cy);
            await new Promise(r => setTimeout(r, 100));
            const aSelected = await page.evaluate(() => document.querySelector('#rec-row-0 .rec-abc-btn').classList.contains('sel-a'));
            check('④' + o.n + ' rec-row: Aボタンをクリックすると選択状態になる', aSelected === true);

            // --- 提出物チェック ---
            await gotoSubmissionsList(openAssignId);
            const sub = await page.evaluate(() => {
                var row = document.querySelector('#subListWrap .sub-input-row');
                var hd = row.querySelector('.sub-row-hd');
                var btnsWrap = row.querySelector('.sub-status-btns');
                var cs = getComputedStyle(row);
                var contentHeight = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
                    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
                    + hd.getBoundingClientRect().height + parseFloat(cs.rowGap)
                    + btnsWrap.getBoundingClientRect().height;
                return { contentHeight: contentHeight };
            });
            const expectedMinH = o.w === 1180 ? 92 : 100;
            check('①' + o.n + ' .sub-input-row の内容量(padding+border+hd+gap+btns)がmin-height(' + expectedMinH + 'px)以内',
                sub.contentHeight <= expectedMinH, 'contentHeight=' + sub.contentHeight.toFixed(1) + 'px');

            const okBtnRect = await rect('#subListWrap .sub-input-row[data-idx="0"] .sub-status-btn[data-status="submitted"]');
            check('②' + o.n + ' ○ボタンが44px以上', okBtnRect.height >= 44, 'height=' + okBtnRect.height);

            // ④ 隣接要素のクリック判定(重点)
            const rowSel = '#subListWrap .sub-input-row[data-idx="0"]';
            const numRect = await rect(rowSel + ' .sub-row-num');
            const nameRect = await rect(rowSel + ' .sub-row-name');
            const subAbsentRect = await rect(rowSel + ' .sub-absent-btn');
            const doneRect = await rect(rowSel + ' .sub-row-done');
            const chkWrapRect = await rect(rowSel + ' .sub-correction-check-wrap');
            const subOkRect = await rect(rowSel + ' .sub-status-btn[data-status="submitted"]');
            const subResubRect = await rect(rowSel + ' .sub-status-btn[data-status="resubmit"]');

            // 4-a: 欠席ボタンの中心はチェックボックスの拡張ヒットゾーンに奪われていない
            const hitAtAbsentCenter = await page.evaluate((x, y) => {
                var el = document.elementFromPoint(x, y);
                return el ? (el.className || el.tagName) : null;
            }, subAbsentRect.cx, subAbsentRect.cy);
            check('④' + o.n + ' sub-input-row: 欠席ボタン中心のヒットテストが欠席ボタン自身',
                typeof hitAtAbsentCenter === 'string' && hitAtAbsentCenter.indexOf('sub-absent-btn') !== -1,
                'hit=' + hitAtAbsentCenter);

            // 4-b: 欠席ボタンを実クリックして欠席状態になる(チェックボックスに奪われていないことの実動作確認)
            await page.mouse.click(subAbsentRect.cx, subAbsentRect.cy);
            await new Promise(r => setTimeout(r, 150));
            const subAbsentOn = await page.evaluate((sel) => document.querySelector(sel).classList.contains('absent-on'), rowSel + ' .sub-absent-btn');
            check('④' + o.n + ' sub-input-row: 欠席ボタンをクリックすると欠席状態になる', subAbsentOn === true);
            await page.mouse.click(subAbsentRect.cx, subAbsentRect.cy);
            await new Promise(r => setTimeout(r, 150));

            // 4-c: 番号バッジをクリックすると遅刻トグルが動作する(拡張ゾーンの右隣接確認)
            await page.mouse.click(numRect.cx, numRect.cy);
            await new Promise(r => setTimeout(r, 150));
            const lateOn = await page.evaluate((sel) => document.querySelector(sel).classList.contains('late-on'), rowSel + ' .sub-row-num');
            check('④' + o.n + ' sub-input-row: 番号バッジをクリックすると遅刻状態になる', lateOn === true);
            await page.evaluate((sel) => document.querySelector(sel).classList.remove('late-on'), rowSel + ' .sub-row-num');

            // 4-d: チェックボックス自体(拡張ゾーン左端寄り、視覚サイズ外)をクリックするとcheckedがトグルされる
            const chkBefore = await page.evaluate((sel) => document.querySelector(sel).checked, rowSel + ' .sub-correction-check');
            const chkLeftEdgeX = chkWrapRect.left - 10; // 疑似要素の拡張域(left:-14px)内、チェックボックス本体の外
            const chkLeftEdgeY = chkWrapRect.cy;
            await page.mouse.click(chkLeftEdgeX, chkLeftEdgeY);
            await new Promise(r => setTimeout(r, 150));
            const chkAfter = await page.evaluate((sel) => document.querySelector(sel).checked, rowSel + ' .sub-correction-check');
            check('④' + o.n + ' sub-input-row: チェックボックス拡張ヒットゾーン(視覚サイズ外)クリックでcheckedがトグルされる',
                chkAfter !== chkBefore, 'before=' + chkBefore + ' after=' + chkAfter);
            // 元に戻す
            if (chkAfter !== chkBefore) {
                await page.mouse.click(chkLeftEdgeX, chkLeftEdgeY);
                await new Promise(r => setTimeout(r, 150));
            }

            // 4-e: ○△ボタンがチェックボックス拡張ゾーンに奪われず機能する
            await page.mouse.click(subOkRect.cx, subOkRect.cy);
            await new Promise(r => setTimeout(r, 150));
            const okSelected = await page.evaluate((sel) => document.querySelector(sel).classList.contains('sel-submitted'), rowSel + ' .sub-status-btn[data-status="submitted"]');
            check('④' + o.n + ' sub-input-row: ○ボタンをクリックすると選択状態になる', okSelected === true);
            await page.evaluate((sel) => { var r = document.querySelector(sel); r.className = 'sub-input-row'; }, rowSel);

            // 4-f: 氏名エリアをクリックしても何も反応しない(意図しないハンドラが無いことの確認)
            const nameHit = await page.evaluate((x, y) => {
                var el = document.elementFromPoint(x, y);
                return el ? (el.className || el.tagName) : null;
            }, nameRect.cx, nameRect.cy);
            check('④' + o.n + ' sub-input-row: 氏名中心のヒットテストが氏名自身(チェックボックスに奪われていない)',
                typeof nameHit === 'string' && nameHit.indexOf('sub-row-name') !== -1, 'hit=' + nameHit);
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
