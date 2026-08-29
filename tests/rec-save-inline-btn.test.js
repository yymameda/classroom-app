// v1.39.0の回帰テスト(課題2: 児童の記録「まとめて保存」の.rec-progress帯統合)。
//   独立commitで戻せる変更のため、このテストも単独ファイルにして
//   コミットと一緒に切り離せるようにしてある(戻す場合はこのファイルも一緒に戻す)。
//   .rec-save-inline-btn が .rec-progress 帯に収まり、高さ44px(var(--tap-min))
//   以上を維持していること、旧.rec-save-barが残っていないことを確認する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node rec-save-inline-btn.test.js

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
        const tests = SUBJECTS.map((s, i) => ({
            id: now + i, subject: s, category: '主体性', testType: '小テスト', type: 'standard',
            maxScore: '', date: '2026-08-01', createdAt: new Date().toISOString()
        }));

        await page.evaluate(({ students, tests }) => {
            StorageManager.set(KEYS.master, JSON.stringify({ students: students, classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.set(KEYS.tests, JSON.stringify(tests));
            StorageManager.set(KEYS.scores, JSON.stringify([]));
        }, { students, tests });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 200));

        async function checkSaveBtn(label) {
            await page.evaluate((testId) => {
                showView('records');
                recSelectTestGoto(testId);
            }, tests[0].id);
            await new Promise(r => setTimeout(r, 200));

            const data = await page.evaluate(() => {
                var btn = document.querySelector('.rec-save-inline-btn');
                var prog = document.querySelector('.rec-progress');
                var oldBarGone = !document.querySelector('.rec-save-bar');
                if (!btn || !prog) return { found: false, oldBarGone: oldBarGone };
                var br = btn.getBoundingClientRect();
                var pr = prog.getBoundingClientRect();
                return {
                    found: true, height: br.height,
                    fitsInsideProgressRow: br.right <= pr.right + 1 && br.left >= pr.left - 1,
                    oldBarGone: oldBarGone
                };
            });
            check('④' + label + ': まとめて保存ボタンが.rec-progress帯に統合され高さ44px以上',
                data.found && data.height >= 44, JSON.stringify(data));
            check(label + ': まとめて保存ボタンが帯の横幅からはみ出していない',
                data.found && data.fitsInsideProgressRow, JSON.stringify(data));
            check(label + ': 旧.rec-save-bar要素が残っていない(DOM移動の確認)', data.oldBarGone);
        }

        for (const o of [{ w: 1180, h: 820, n: '横1180x820' }, { w: 820, h: 1180, n: '縦820x1180' }]) {
            await page.setViewport({ width: o.w, height: o.h, deviceScaleFactor: 2 });
            await new Promise(r => setTimeout(r, 100));
            await checkSaveBtn(o.n);
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
