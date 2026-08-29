// v1.40.0の回帰テスト。
//   実機で確認された「ボタン枠がタイル下端を突き抜けるはみ出し」への対処として、
//   .rec-abc-btn / .sub-status-btn に min-width の床を設け、無制限に縮まない
//   ようにした（flex-wrapは採用しない。A/B+/B/B-/Cの並び順が変わると
//   入力ミスに直結するため、1行のまま維持する）。
//
// 検証は次の2点のみ（はみ出し量の検証はChromeでは再現できないため対象外。
// 実機確認はユーザーが行う）:
//   ① ボタンが折り返さず1行で並んでいること
//   ④ ボタンの高さが44px(var(--tap-min))以上であること
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node tile-btns-oneline.test.js

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
        const tests = SUBJECTS.map((s, i) => ({
            id: now + i, subject: s, category: '主体性', testType: '小テスト', type: 'standard',
            maxScore: '', date: '2026-08-01', createdAt: new Date().toISOString()
        }));
        const assignments = SUBJECTS.map((s, i) => ({ id: now + 100 + i, subject: s, name: s + '課題', date: '2026-08-01', createdAt: new Date().toISOString() }));

        await page.evaluate(({ students, tests, assignments }) => {
            StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.set(KEYS.tests, JSON.stringify(tests));
            StorageManager.set(KEYS.scores, JSON.stringify([]));
            StorageManager.set(KEYS.submissions_assignments, JSON.stringify(assignments));
            StorageManager.set(KEYS.submissions_data, JSON.stringify([]));
        }, { students, tests, assignments });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 200));

        async function checkA(label) {
            await page.evaluate((tid) => { showView('records'); recSelectTestGoto(tid); }, tests[0].id);
            await new Promise(r => setTimeout(r, 200));
            const data = await page.evaluate(() => {
                var row = document.querySelector('#recList .rec-row.abc-row');
                if (!row) return { found: false };
                var btns = Array.from(row.querySelectorAll('.rec-abc-btn'));
                var tops = btns.map(function(b) { return Math.round(b.getBoundingClientRect().top); });
                var order = btns.map(function(b) { return b.textContent.trim(); });
                return {
                    found: true, count: btns.length,
                    oneLine: new Set(tops).size === 1,
                    order: order,
                    minHeight: Math.min.apply(null, btns.map(function(b) { return b.getBoundingClientRect().height; }))
                };
            });
            check('①' + label + ': A/B+/B/B-/Cが折り返さず1行で並ぶ', data.found && data.count === 5 && data.oneLine, JSON.stringify(data));
            check(label + ': A/B+/B/B-/Cの並び順が保たれている', data.found && data.order.join(',') === 'A,B+,B,B-,C', JSON.stringify(data.order));
            check('④' + label + ': A〜Cボタンの高さが44px以上', data.found && data.minHeight >= 44, 'minHeight=' + data.minHeight);
        }

        async function checkB(label) {
            await page.evaluate((assignId) => {
                showView('submissions');
                var sel = document.getElementById('subInputAssignSel');
                sel.value = String(assignId);
                sel.dispatchEvent(new Event('change'));
                document.getElementById('subViewListBtn').click();
            }, assignments[0].id);
            await new Promise(r => setTimeout(r, 200));
            const data = await page.evaluate(() => {
                var row = document.querySelector('#subListWrap .sub-input-row');
                if (!row) return { found: false };
                var btns = Array.from(row.querySelectorAll('.sub-status-btn'));
                var tops = btns.map(function(b) { return Math.round(b.getBoundingClientRect().top); });
                return {
                    found: true, count: btns.length,
                    oneLine: new Set(tops).size === 1,
                    minHeight: Math.min.apply(null, btns.map(function(b) { return b.getBoundingClientRect().height; })),
                    allOkHeight: document.getElementById('subAllOkBtn').getBoundingClientRect().height
                };
            });
            check('①' + label + ': ○△が折り返さず1行で並ぶ', data.found && data.count === 2 && data.oneLine, JSON.stringify(data));
            check('④' + label + ': ○△ボタンの高さが44px以上', data.found && data.minHeight >= 44, 'minHeight=' + data.minHeight);
            check('④' + label + ': 全員○ボタンの高さが44px以上', data.found && data.allOkHeight >= 44, 'height=' + data.allOkHeight);
        }

        for (const o of [{ w: 1180, h: 820, n: '横1180x820' }, { w: 820, h: 1180, n: '縦820x1180' }]) {
            await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
            await new Promise(r => setTimeout(r, 100));
            await checkA(o.n);
            await checkB(o.n);
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
