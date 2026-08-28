// v1.23.0 機械検証: 点数入力タブ(#rec-sub-input)の学期絞り込みを検証する。
//
//   recInputTermFilter                : 点数入力タブ専用の学期フィルタ状態。テスト一覧タブの
//                                        recCurrentTermFilterとは別管理。
//   recInputPassesTermFilter(item)    : window.grdItemTerm に委譲するだけの薄い判定。
//   recOnInputFilterChanged()         : 科目/観点/種別/学期のフィルタ操作ハンドラからのみ呼ぶ。
//                                        対象外になった選択中課題(recCurrentTestId)を解除しトーストで通知する。
//   recRelaxFiltersForTest(test)      : recAddTest保存後/recSelectTestGoto/recReturnToInputの
//                                        「課題を指定して飛んでくる経路」から呼ぶ。対象課題が
//                                        隠れる場合、選択は解除せずフィルタ側を(全解除で)譲る。
//
// recInputTermFilter/recCurrentTestId等はIIFE内部のクロージャ変数でwindowに露出していないため、
// 既存テストと同じ方針で、内部変数を直接覗かずDOM上の観測可能な効果だけで検証する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node rec-input-term-filter.test.js

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

    // termSystem: 3（3学期制）。既定境界: 2学期開始09-01 / 3学期開始01-01(翌年)。
    const MASTER = {
        students: [{ name: '検証太郎' }, { name: '検証花子' }],
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

    async function activeSub() {
        return page.evaluate(() => {
            var active = document.querySelector('#view-records .rec-sub.active');
            return active ? active.id : null;
        });
    }
    async function inputScreenState() {
        return page.evaluate(() => ({
            selectValue: document.getElementById('recInputTestSelect').value,
            termValue: document.getElementById('recInputTermSel').value,
            infoVisible: document.getElementById('recInputInfo').style.display !== 'none',
            bulkVisible: document.getElementById('recBulkWrap').style.display !== 'none'
        }));
    }
    async function visibleTestIds() {
        return page.evaluate(() => Array.from(document.querySelectorAll('#recInputTestSelect option'))
            .map(o => o.value).filter(v => v !== ''));
    }
    async function toastState() {
        return page.evaluate(() => ({
            text: (document.getElementById('toastMsg') || {}).textContent,
            className: (document.getElementById('toast') || {}).className
        }));
    }
    async function selectTerm(v) {
        await page.select('#recInputTermSel', v);
        await new Promise(r => setTimeout(r, 150));
    }

    try {
        // 1学期(日付から自動判定): 2026-06-01 は 09-01 より前 → term1
        const TEST_1 = { id: 930001, subject: '国語', testType: '小テスト', name: 'TF_課題1学期', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-01', createdAt: new Date().toISOString() };
        // 2学期(日付から自動判定): 2026-10-05 は 09-01以降・翌年01-01より前 → term2
        const TEST_2 = { id: 930002, subject: '算数', testType: '小テスト', name: 'TF_課題2学期', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-10-05', createdAt: new Date().toISOString() };
        // 3学期(日付から自動判定、termフィールドなし): 2027-02-10 は 2027-01-01以降 → term3
        const TEST_3 = { id: 930003, subject: '理科', testType: '小テスト', name: 'TF_課題3学期', category: '知識・技能', type: 'standard', maxScore: 100, date: '2027-02-10', createdAt: new Date().toISOString() };
        await seed([TEST_1, TEST_2, TEST_3], []);

        // ================================================================
        // Check 5: 初期表示で現在学期が選択されている
        // ================================================================
        const expectedCurrentTerm = await page.evaluate(() => window.grdGetCurrentTerm());
        const initialTermVal = await page.evaluate(() => document.getElementById('recInputTermSel').value);
        check('5. 初期表示の学期selectが現在学期(grdGetCurrentTerm)と一致する', initialTermVal === expectedCurrentTerm, JSON.stringify({ initialTermVal, expectedCurrentTerm }));

        // ================================================================
        // Check 1: 1学期を選ぶと1学期の課題だけが残る(2学期・3学期の課題が消える)
        // ================================================================
        await selectTerm('1');
        const idsTerm1 = await visibleTestIds();
        check('1. 1学期選択でTEST_1のみプルダウンに残る', idsTerm1.length === 1 && idsTerm1[0] === String(TEST_1.id), JSON.stringify(idsTerm1));

        // ================================================================
        // Check 3: term未設定・dateのみの課題が日付から正しい学期(3学期)に振り分けられる
        // ================================================================
        await selectTerm('3');
        const idsTerm3 = await visibleTestIds();
        check('3. term未設定でもdateから3学期と判定されTEST_3のみ残る', idsTerm3.length === 1 && idsTerm3[0] === String(TEST_3.id), JSON.stringify(idsTerm3));

        // ================================================================
        // Check 2: 「通年」を選ぶと全学期の課題が表示される
        // ================================================================
        await selectTerm('all');
        const idsAll = await visibleTestIds();
        const idsAllSorted = idsAll.slice().sort();
        const expectedAllSorted = [String(TEST_1.id), String(TEST_2.id), String(TEST_3.id)].sort();
        check('2. 通年選択で全学期の課題が表示される', JSON.stringify(idsAllSorted) === JSON.stringify(expectedAllSorted), JSON.stringify(idsAll));

        // ================================================================
        // Check 4: 2学期の課題を選択中に1学期へ切り替えると選択解除され、
        //          入力グリッドが旧課題を表示し続けない(既存不整合の修正確認)
        // ================================================================
        await selectTerm('2');
        const idsTerm2 = await visibleTestIds();
        check('前提: 2学期選択でTEST_2のみ残る', idsTerm2.length === 1 && idsTerm2[0] === String(TEST_2.id), JSON.stringify(idsTerm2));

        await page.select('#recInputTestSelect', String(TEST_2.id));
        await new Promise(r => setTimeout(r, 150));
        const beforeSwitch = await inputScreenState();
        check('前提: TEST_2選択で入力グリッドが表示される', beforeSwitch.bulkVisible === true && beforeSwitch.selectValue === String(TEST_2.id), JSON.stringify(beforeSwitch));

        await selectTerm('1');
        const afterSwitch = await inputScreenState();
        check('4a. 1学期へ切替後、プルダウンの選択が解除される(空)', afterSwitch.selectValue === '', JSON.stringify(afterSwitch));
        check('4a. 1学期へ切替後、入力グリッドが表示されず案内表示に戻る(旧課題TEST_2を表示し続けない)', afterSwitch.infoVisible === true && afterSwitch.bulkVisible === false, JSON.stringify(afterSwitch));

        const toastAfterSwitch = await toastState();
        check('4b. 選択解除時にトーストで通知される', (toastAfterSwitch.text || '').indexOf('選択を解除') !== -1, JSON.stringify(toastAfterSwitch));

        // ================================================================
        // Check 7: テスト一覧タブから「入力」ボタンで課題を指名ジャンプする場合は、
        //          学期フィルタが不一致でも選択は解除されず、フィルタ側が譲る(通年に解除)
        // ================================================================
        await selectTerm('2'); // 入力タブの学期フィルタを2学期のままにしておく
        await page.evaluate(() => { window.recShowSub('tests'); });
        await new Promise(r => setTimeout(r, 100));
        await page.evaluate((tid) => { window.recSelectTestGoto(tid); }, TEST_1.id); // 1学期の課題を指名ジャンプ
        await new Promise(r => setTimeout(r, 150));

        const gotoSub = await activeSub();
        const gotoState = await inputScreenState();
        check('7. テスト一覧から指名ジャンプすると入力タブに遷移する', gotoSub === 'rec-sub-input', String(gotoSub));
        check('7. 学期フィルタ不一致でも指名した課題が選択された状態で開く(選択解除されない)', gotoState.selectValue === String(TEST_1.id) && gotoState.bulkVisible === true, JSON.stringify(gotoState));
        check('7. 対象課題が隠れていた学期フィルタは通年に解除される(既存recAddTestの前例=解除方式に統一)', gotoState.termValue === 'all', JSON.stringify(gotoState));

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
