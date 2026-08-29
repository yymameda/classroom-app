// v1.39.0の回帰テスト(課題1: 提出物チェック・タイルの○△はみ出し対策)。
//   .sub-input-row / .sub-row-hd / .sub-status-btns のpadding/gapを詰め、
//   水平方向のオーバーフローが起きないことを確認する。
//   あわせて「全員○」ボタンの高さが44px(var(--tap-min))以上であることを確認する。
//
// 制約: このテストはChrome(puppeteer)で実行しており、Chromeのflexboxは
//   子要素を機械的に完全フィットさせるため、水平オーバーフロー(scrollWidth>
//   clientWidth)は変更前後どちらでも実質0になる(実機iPad Safariで報告された
//   はみ出しはChromeでは再現しない)。そのため①のテストは「Chrome上で新たな
//   オーバーフローが発生していないこと」の回帰検知に限定し、実機確認の代替には
//   ならない。あわせてタイルのcontent-box幅を記録する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node sub-tile-fit.test.js

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
        master: KEYS.master, submissions_assignments: KEYS.submissions_assignments, submissions_data: KEYS.submissions_data
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
        const assignments = SUBJECTS.map((s, i) => ({ id: now + i, subject: s, name: s + '課題', date: '2026-08-01', createdAt: new Date().toISOString() }));

        await page.evaluate(({ students, assignments }) => {
            StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.set(KEYS.submissions_assignments, JSON.stringify(assignments));
            StorageManager.set(KEYS.submissions_data, JSON.stringify([]));
        }, { students, assignments });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 200));

        async function checkTile(label) {
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
                var hd = row.querySelector('.sub-row-hd');
                var btnsWrap = row.querySelector('.sub-status-btns');
                var allOkBtn = document.getElementById('subAllOkBtn');
                return {
                    hdOverflow: hd.scrollWidth - hd.clientWidth,
                    btnsOverflow: btnsWrap.scrollWidth - btnsWrap.clientWidth,
                    hdContentBoxWidth: hd.getBoundingClientRect().width,
                    btnsContentBoxWidth: btnsWrap.getBoundingClientRect().width,
                    allOkBtnHeight: allOkBtn.getBoundingClientRect().height
                };
            });
            check('①' + label + ': .sub-row-hd に水平オーバーフローが無い(Chrome実測)',
                data.hdOverflow <= 1, 'overflow=' + data.hdOverflow + 'px content-box幅=' + data.hdContentBoxWidth.toFixed(1) + 'px');
            check('①' + label + ': .sub-status-btns(○△)に水平オーバーフローが無い(Chrome実測)',
                data.btnsOverflow <= 1, 'overflow=' + data.btnsOverflow + 'px content-box幅=' + data.btnsContentBoxWidth.toFixed(1) + 'px');
            check('④' + label + ': 全員○ボタンの高さが44px以上', data.allOkBtnHeight >= 44, 'height=' + data.allOkBtnHeight);
        }

        for (const o of [{ w: 1180, h: 820, n: '横1180x820' }, { w: 820, h: 1180, n: '縦820x1180' }]) {
            await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
            await new Promise(r => setTimeout(r, 100));
            await checkTile(o.n);
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
