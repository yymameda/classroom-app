// 児童の記録(点数入力/ABC・ルーブリック行)と提出物チェック(リスト表示)で、
// 最下段の児童が見切れる不具合の回帰テスト(v1.38.0)。
//
// 修正内容:
//   - #view-records / #view-submissions をflex列にし、ヘッダー・サブナビ・
//     フィルタ・進捗行を固定、リスト(#recList / #subListWrap)だけが内側で
//     スクロールする構造に変更。
//   - #subListWrap の max-height: calc(100vh - 200px) を廃止し、
//     flex:1; min-height:0 による高さ連鎖に置き換え。
//   - 副作用防止のため .rec-test-mgmt / .patrol-container に
//     flex:1; min-height:0; (patrol-containerはoverflow-y:autoも) を追加。
//
// 検証項目(A)(B)共通:
//   1. 最終行のbottomがスクロールコンテナの可視領域内に収まる
//   2. リストを最下部までスクロールしても、ヘッダー・切替ボタン行・フィルタ・
//      進捗行の位置(rect)が一切動かない
//   3. (A)の保存ボタンが常に見える
//   4. 外側.viewのscrollHeight === clientHeight(外側がスクロールしない)
//   5. 退行確認: 児童の記録(課題管理/統計/机間巡視)、提出物チェック(入力(個人)/
//      統計/修養日誌/課題管理)、忘れ物チェック、成績処理統合が表示できる
//
// 実運用に近い負荷(教科複数でフィルタタブが折り返す・ルーブリック参照パネル展開)、
// 縦横両向きで検証する(最小データでは42px/45px程度の超過に留まり不十分だったため)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node list-scroll-cutoff.test.js

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

        // 複数教科の主体性(ABC)課題。フィルタタブ折り返しを狙って8教科分作る。
        const abcTests = SUBJECTS.map(function(subj, i) {
            return {
                id: now + 100 + i, subject: subj, category: '主体性', testType: '小テスト',
                type: 'standard', maxScore: '', date: '2026-08-01', createdAt: new Date().toISOString(),
                rubricA: subj + '：自ら課題を見つけ、粘り強く取り組んでいる。振り返りも具体的に書けている。',
                rubricB: subj + '：与えられた課題に取り組み、必要な振り返りができている。',
                rubricC: subj + '：取り組みが不十分。支援が必要。'
            };
        });
        const openTestId = abcTests[0].id;

        // 複数教科の提出課題。同じくフィルタタブ折り返しを狙う。
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

        // ------------------------------------------------------------
        // ヘルパー
        // ------------------------------------------------------------
        async function gotoRecordsList(testId, openRubric) {
            await page.evaluate(({ testId, openRubric }) => {
                showView('records');
                recSelectTestGoto(testId);
                if (openRubric) recToggleRubricPanel();
            }, { testId, openRubric });
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
        function rectsOf(sels) {
            return page.evaluate((sels) => sels.map(function(sel) {
                var el = document.querySelector(sel);
                if (!el) return null;
                var r = el.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
            }), sels);
        }
        async function scrollListToBottom(listSel) {
            await page.evaluate((sel) => { var el = document.querySelector(sel); if (el) el.scrollTop = el.scrollHeight; }, listSel);
            await new Promise(r => setTimeout(r, 150));
        }
        function sameRect(a, b) {
            if (!a || !b) return false;
            return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5
                && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.right - b.right) < 0.5;
        }

        async function verifyScreen(label, opts) {
            // opts: { outerSel, listSel, rowSel, fixedSels, saveBtnSel }
            const rowCount = await page.evaluate((listSel, rowSel) => {
                var l = document.querySelector(listSel);
                return l ? l.querySelectorAll(rowSel).length : 0;
            }, opts.listSel, opts.rowSel);
            check(label + ': 児童30人ぶんの行が描画されている', rowCount === 30, '行数=' + rowCount);

            const fixedBefore = await rectsOf(opts.fixedSels);
            const outerBefore = await page.evaluate((sel) => {
                var el = document.querySelector(sel);
                return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
            }, opts.outerSel);

            await scrollListToBottom(opts.listSel);

            const after = await page.evaluate((listSel, rowSel, outerSel, saveBtnSel) => {
                var list = document.querySelector(listSel);
                var rows = list ? list.querySelectorAll(rowSel) : [];
                var last = rows.length ? rows[rows.length - 1] : null;
                var listRect = list ? list.getBoundingClientRect() : null;
                var lastRect = last ? last.getBoundingClientRect() : null;
                var outer = document.querySelector(outerSel);
                var saveRect = null;
                if (saveBtnSel) {
                    var sb = document.querySelector(saveBtnSel);
                    if (sb) saveRect = sb.getBoundingClientRect();
                }
                return {
                    innerHeight: window.innerHeight,
                    listRect: listRect ? { top: listRect.top, bottom: listRect.bottom } : null,
                    lastRect: lastRect ? { top: lastRect.top, bottom: lastRect.bottom } : null,
                    outerScrollHeight: outer ? outer.scrollHeight : null,
                    outerClientHeight: outer ? outer.clientHeight : null,
                    saveRect: saveRect ? { top: saveRect.top, bottom: saveRect.bottom } : null
                };
            }, opts.listSel, opts.rowSel, opts.outerSel, opts.saveBtnSel || null);

            const fixedAfter = await rectsOf(opts.fixedSels);

            // 1. 最終行がスクロールコンテナの可視領域(自身のrect)内に収まる
            const lastFits = after.lastRect && after.listRect && after.lastRect.bottom <= after.listRect.bottom + 1;
            check(label + ' [1] 最終行bottomがリストコンテナの可視領域内', lastFits,
                'last.bottom=' + (after.lastRect && after.lastRect.bottom.toFixed(1)) + ' list.bottom=' + (after.listRect && after.listRect.bottom.toFixed(1)));

            // 2. 固定要素の位置が最下部スクロール後も一切動かない
            let allFixedSame = true;
            const diffs = [];
            for (let i = 0; i < opts.fixedSels.length; i++) {
                const same = sameRect(fixedBefore[i], fixedAfter[i]);
                if (!same) { allFixedSame = false; diffs.push(opts.fixedSels[i]); }
            }
            check(label + ' [2] リスト最下部スクロール後も固定要素(ヘッダー/切替/フィルタ/進捗)が動かない', allFixedSame, diffs.join(','));

            // 3. (A)保存ボタンが常に見える(viewport内)
            if (opts.saveBtnSel) {
                const visible = after.saveRect && after.saveRect.top >= 0 && after.saveRect.bottom <= after.innerHeight + 1;
                check(label + ' [3] 保存ボタンが常に画面内に見える', visible,
                    after.saveRect ? JSON.stringify(after.saveRect) : 'not found');
            }

            // 4. 外側.viewはスクロールしない(scrollHeight===clientHeight)
            const outerNoScroll = after.outerScrollHeight !== null && after.outerScrollHeight === after.outerClientHeight;
            check(label + ' [4] 外側.viewのscrollHeight===clientHeight(外側がスクロールしない)', outerNoScroll,
                'scrollHeight=' + after.outerScrollHeight + ' clientHeight=' + after.outerClientHeight);

            // 参考: スクロール前の外側scrollHeightも記録(常に不変であるべき)
            check(label + ' [4b] リストスクロール前後で外側.viewの高さが変化しない', outerBefore
                && outerBefore.scrollHeight === after.outerScrollHeight && outerBefore.clientHeight === after.outerClientHeight,
                JSON.stringify(outerBefore) + ' -> scrollHeight=' + after.outerScrollHeight);
        }

        // ------------------------------------------------------------
        // (A)(B) を横向き・縦向きそれぞれで検証
        // ------------------------------------------------------------
        const orientations = [
            { name: '横1180x820', w: 1180, h: 820 },
            { name: '縦820x1180', w: 820, h: 1180 }
        ];

        for (const o of orientations) {
            await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
            await new Promise(r => setTimeout(r, 150));

            // (A) 児童の記録: ルーブリック参照パネルを開いた状態で検証
            await gotoRecordsList(openTestId, true);
            await verifyScreen('(A)' + o.name, {
                outerSel: '#view-records',
                listSel: '#recList',
                rowSel: '.rec-row',
                fixedSels: ['.rec-subnav', '#recFilterBar', '.rec-test-selector', '#recRubricPanel', '.rec-progress'],
                saveBtnSel: '.rec-save-bar'
            });

            // (B) 提出物チェック: リスト表示
            await gotoSubmissionsList(openAssignId);
            await verifyScreen('(B)' + o.name, {
                outerSel: '#view-submissions',
                listSel: '#subListWrap',
                rowSel: '.sub-input-row',
                fixedSels: ['.view-header', '.sub-subnav', '#subFilterBar', '.sub-input-top', '#subProgressWrap']
            });
        }

        // 横向きに戻す
        await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
        await new Promise(r => setTimeout(r, 150));

        // ------------------------------------------------------------
        // 5. 退行確認: 触れていない/受け皿を追加したタブが表示できること
        // ------------------------------------------------------------
        async function visibleAndTall(sel) {
            return page.evaluate((sel) => {
                var el = document.querySelector(sel);
                if (!el) return { found: false };
                var cs = getComputedStyle(el);
                var r = el.getBoundingClientRect();
                return { found: true, display: cs.display, height: r.height, overflowY: cs.overflowY };
            }, sel);
        }

        // 児童の記録: 課題管理・統計・机間巡視
        await page.evaluate(() => { showView('records'); recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 150));
        const recTests = await visibleAndTall('#recTestMgmt');
        check('[5] 児童の記録・課題管理タブが表示される(受け皿.rec-test-mgmt)', recTests.found && recTests.height > 0, JSON.stringify(recTests));

        await page.evaluate(() => { recShowSub('stats'); });
        await new Promise(r => setTimeout(r, 150));
        const recStats = await visibleAndTall('#recStatsMgmt');
        check('[5] 児童の記録・統計タブが表示される(受け皿.rec-test-mgmt)', recStats.found && recStats.height > 0, JSON.stringify(recStats));

        await page.evaluate(() => { recShowSub('patrol'); });
        await new Promise(r => setTimeout(r, 150));
        const recPatrol = await visibleAndTall('.patrol-container');
        check('[5] 児童の記録・机間巡視タブが表示される(受け皿.patrol-container, overflow-y:auto)',
            recPatrol.found && recPatrol.height > 0 && recPatrol.overflowY === 'auto', JSON.stringify(recPatrol));

        // 提出物チェック: 入力(個人)・統計・修養日誌・課題管理
        for (const sub of [
            { name: '入力(個人)', key: 'person', sel: '#subPsnSubjSel' },
            { name: '統計', key: 'stats', sel: '#subStatsAssignSel' },
            { name: '修養日誌', key: 'diary', sel: '#sub-sub-diary' },
            { name: '課題管理', key: 'assign', sel: '#sub-sub-assign' }
        ]) {
            await page.evaluate((key) => {
                showView('submissions');
                var btn = document.querySelector('#view-submissions .sub-subnav-btn[data-sub="' + key + '"]');
                if (btn) btn.click();
            }, sub.key);
            await new Promise(r => setTimeout(r, 150));
            const st = await visibleAndTall(sub.sel);
            check('[5] 提出物チェック・' + sub.name + 'タブが表示される', st.found, JSON.stringify(st));
        }

        // 忘れ物チェック
        await page.evaluate(() => { showView('forgotten'); });
        await new Promise(r => setTimeout(r, 150));
        const fgt = await visibleAndTall('#view-forgotten');
        check('[5] 忘れ物チェック画面が表示される', fgt.found && fgt.display !== 'none', JSON.stringify(fgt));

        // 成績処理統合
        await page.evaluate(() => { showView('grades'); });
        await new Promise(r => setTimeout(r, 150));
        const grd = await visibleAndTall('#view-grades');
        check('[5] 成績処理統合画面が表示される', grd.found && grd.display !== 'none', JSON.stringify(grd));

        // ------------------------------------------------------------
        // コンソールエラーの回帰確認
        // ------------------------------------------------------------
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
