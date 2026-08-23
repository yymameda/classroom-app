// 取り消し基盤（v1.12.0）機械検証: 配線節
//
// index.html に定義された uiUndoable 系の関数・定数がすべて存在し、
// 例外なく呼び出せることを確認する。uiUndoable単体の動作保証・
// キャッシュ破棄の順序保証・保留書き込みの確定保証・各機能との実データ
// 往復は、この節では扱わない（別ファイル・別コミットで段階的に追加する）。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node undo.test.js

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
        if (msg.type() === 'error') {
            const loc = msg.location() || {};
            consoleErrors.push({ text: msg.text(), url: loc.url || '' });
        }
    });
    page.on('pageerror', err => consoleErrors.push({ text: 'PAGEERROR: ' + err.message, url: '' }));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    // ================================================================
    // 配線1: uiUndoable系6関数が定義されている
    // ================================================================
    const wiring = await page.evaluate(() => ({
        uiUndoable: typeof uiUndoable,
        uiRegisterCacheReset: typeof uiRegisterCacheReset,
        uiResetCaches: typeof uiResetCaches,
        uiRegisterPendingFlush: typeof uiRegisterPendingFlush,
        uiFlushPending: typeof uiFlushPending,
        showUndoToast: typeof showUndoToast
    }));
    const wiringOk = Object.keys(wiring).every(function(name) { return wiring[name] === 'function'; });
    check('uiUndoable/uiRegisterCacheReset/uiResetCaches/uiRegisterPendingFlush/uiFlushPending/showUndoToastの6関数が定義されている', wiringOk, JSON.stringify(wiring));

    // ================================================================
    // キャッシュ破棄・保留確定の登録数、取り消し可能時間の定数
    // ================================================================
    // UI_CACHE_RESETTERS の期待値は3件。内訳:
    //   1. rec（課題・点数管理）モジュールの _invalidate
    //   2. 机間巡視モジュールの _patrolDataCache = null
    //   3. grd（成績計算）モジュールの grdInvalidate
    // git log -S'uiRegisterCacheReset(grdInvalidate)' で確認したところ、
    // この3件は取り消し基盤を導入した最初のコミット（e3c6b5d, v1.12.0）から
    // 一貫して3件であり、後から1件減ったわけではない。
    // したがって、もしここが2に見えたら「rec」「grd」いずれかの登録が
    // 消えた退行を疑うべきで、逆に3以外の値（4以上）に増えていたら、
    // 新しいモジュールが取り消し対応した仕様変更と考えるのが妥当。
    const cacheResetterCount = await page.evaluate(() => UI_CACHE_RESETTERS.length);
    check('UI_CACHE_RESETTERS.length === 3（rec/机間巡視/grdの3件）', cacheResetterCount === 3, 'got=' + cacheResetterCount);

    const pendingFlusherCount = await page.evaluate(() => UI_PENDING_FLUSHERS.length);
    check('UI_PENDING_FLUSHERS.length === 1（提出物のsubFlushAutoSave）', pendingFlusherCount === 1, 'got=' + pendingFlusherCount);

    const undoMs = await page.evaluate(() => UI_UNDO_MS);
    check('UI_UNDO_MS === 8000', undoMs === 8000, 'got=' + undoMs);

    // ================================================================
    // uiResetCaches() / uiFlushPending() が例外なく実行できる
    // ================================================================
    const resetResult = await page.evaluate(() => {
        try { uiResetCaches(); return { threw: false }; }
        catch (e) { return { threw: true, message: e.message }; }
    });
    check('uiResetCaches() が例外なく実行できる', resetResult.threw === false, JSON.stringify(resetResult));

    const flushResult = await page.evaluate(() => {
        try { uiFlushPending(); return { threw: false }; }
        catch (e) { return { threw: true, message: e.message }; }
    });
    check('uiFlushPending() が例外なく実行できる', flushResult.threw === false, JSON.stringify(flushResult));

    // ================================================================
    // コンソールエラーなし
    // ================================================================
    const realErrors = consoleErrors.filter(e => e.url.indexOf('favicon') === -1);
    check('コンソールエラーなし（favicon 404除く）', realErrors.length === 0, JSON.stringify(realErrors));

    await browser.close();

    console.log('---');
    const failed = results.filter(r => !r.pass);
    console.log('TOTAL ' + results.length + ' / PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
    if (failed.length) {
        console.log('FAILED:');
        failed.forEach(r => console.log('  - ' + r.name + (r.detail ? ' :: ' + r.detail : '')));
        process.exit(1);
    }
})();
