// 成績画面以外の async のボタン処理が失敗したとき、トーストで知らせる(v1.60.2。成績画面は v1.60.1 で対応済み)。
//   以前は、async の処理の失敗は Unhandled rejection としてコンソールに出るだけで、画面には何も出なかった
//   (バックアップの保存・復元・座席表のPDF・カルテ出力などのPDFの共通処理・PDFの「名前を伏せて作り直す」ボタン)。
//   方式は成績画面と同じ: ボタンの処理を包み、失敗したら「⚠️ 「ボタン名」に失敗しました: 原因」を出す。PDFの共通処理(htmlPagesToPdf)は中で包む。
//   本番のボタンをクリックし、途中の処理を例外にして確かめる。処理が成功するときの動きは変えない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node async-button-failure-notice.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; }
    const toasts = () => page.evaluate(() => (window.__toasts || []).join(' | '));
    async function reset() { await page.evaluate(() => { window.__toasts = []; }); }

    try {
        await page.evaluate((K) => {
            StorageManager.setImmediate(K.master, JSON.stringify({ version: 2, students: [{ name: '甲' }, { name: '乙' }], classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3 } }));
            StorageManager.setImmediate(K.tests, '[]'); StorageManager.setImmediate(K.scores, '[]');
        }, KN);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => {
            window.__toasts = [];
            window.__origShowToast = window.showToast;
            window.showToast = function(m) { window.__toasts.push(String(m)); return window.__origShowToast.apply(this, arguments); };
            window.__orig = { buildBackupObject: window.buildBackupObject, htmlPagesToPdf: window.htmlPagesToPdf, pdfPresentResult: window.pdfPresentResult, pdfRenderPages: window.pdfRenderPages };
        });
        const restore = () => page.evaluate(() => { Object.keys(window.__orig).forEach(k => { window[k] = window.__orig[k]; }); });

        // ============ 1. バックアップの保存(💾 → 📥 全データを保存): 途中で例外 ============
        await reset();
        await page.evaluate(() => { window.buildBackupObject = function() { throw new Error('テスト用の失敗'); }; document.querySelector('button[onclick="exportBackup(false)"]').click(); });
        await sleep(400);
        let t = await toasts();
        check('バックアップの保存が失敗したら、トーストで「「…」に失敗しました: 原因」と知らせる', /「[^」]*バックアップ[^」]*」に失敗しました: テスト用の失敗/.test(t), t);
        await restore();

        // ============ 2. バックアップの復元(📤 バックアップから復元): ファイルの読み取りで例外 ============
        await reset();
        await page.evaluate(() => {
            const fi = document.getElementById('restoreFile');
            Object.defineProperty(fi, 'files', { configurable: true, value: [{ name: 'テスト.json', text: function() { return Promise.reject(new Error('テスト用の失敗')); } }] });
            document.querySelector('button[onclick="importBackup()"]').click();
        });
        await sleep(400);
        t = await toasts();
        check('バックアップの復元が失敗したら、トーストで「「…」に失敗しました: 原因」と知らせる', /「[^」]*バックアップ[^」]*」に失敗しました: テスト用の失敗/.test(t), t);

        // ============ 3. 座席表のPDF出力(座席画面の📄 PDF出力): PDFの共通処理が例外 ============
        await reset();
        await page.evaluate(() => { window.htmlPagesToPdf = function() { return Promise.reject(new Error('テスト用の失敗')); }; document.getElementById('seatPrintBtn').click(); });
        await sleep(400);
        t = await toasts();
        check('座席表のPDF出力が失敗したら、トーストで「「…」に失敗しました: 原因」と知らせる', /「[^」]*座席表[^」]*」に失敗しました: テスト用の失敗/.test(t), t);
        await restore();

        // ============ 4. PDFの共通処理(カルテ出力など、待たずに呼ぶ経路): 結果ダイアログを出す処理が例外 ============
        const kvClick = () => page.evaluate(() => {
            showView('karte'); kvSetMode('output');
            document.getElementById('kvSec_grades').checked = true;
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === '0'); });
            document.getElementById('kvPrintBtn').click();
        });
        await reset();
        await page.evaluate(() => { window.pdfPresentResult = function() { return Promise.reject(new Error('テスト用の失敗')); }; });
        await kvClick();
        const notified = await waitFor(() => (window.__toasts || []).some(m => /PDF/.test(m) && /失敗/.test(m)), 60000);
        t = await toasts();
        check('カルテ出力(PDF)の仕上げの処理が失敗したら、トーストで「PDFの作成に失敗しました: 原因」と知らせる(待たずに呼ぶ経路も含めて、共通処理の中で)', notified && /PDFの作成に失敗しました: テスト用の失敗/.test(t), t);
        check('その失敗で、ボタンが押せないまま残らず、作りかけの表示(隠しコンテナ)も残らない', await page.evaluate(() => !document.getElementById('kvPrintBtn').disabled && !document.querySelector('body > div[style*="left:-9999px"]')), '');
        await restore();

        // ============ 5. 成功するときは今までどおり: 結果ダイアログまで出る。そこから「名前を伏せて作り直す」が失敗したら通知し、ダイアログは残る ============
        await reset();
        await kvClick();
        const reached = await waitFor(() => !!document.getElementById('pdfResultOverlay'), 90000);
        check('(対照)処理が成功するときは、今までどおり結果ダイアログ(「PDFができました」)まで出る。失敗のトーストは出ない', reached && !(await toasts()).match(/失敗/), await toasts());
        await reset();
        await page.evaluate(() => { window.pdfRenderPages = function() { return Promise.reject(new Error('テスト用の失敗')); }; document.getElementById('pdfResMaskBtn').click(); });
        await sleep(600);
        t = await toasts();
        const overlayShown = await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); return !!o && o.style.display !== 'none'; });
        check('「名前を伏せて作り直す」が失敗したら、トーストで知らせる', /氏名を伏せたPDFの作成に失敗しました: テスト用の失敗/.test(t), t);
        check('その失敗のあとも、結果ダイアログは消えたまま(真っ白)にならず、そのまま操作できる', overlayShown, '');
        await restore();
        await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });

        // ============ 6. キャッチされない例外(画面に何も出ない失敗)が、これらの操作で出ていない ============
        check('ここまでの操作で、コンソールに「キャッチされない例外」は出ていない(失敗はすべてトーストに変わっている)', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== async-button-failure-notice: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
