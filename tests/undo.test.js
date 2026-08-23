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
    // uiUndoable単体（合成キー・実StorageManager・実トーストDOM）
    // ================================================================
    // ここから先は実データ（KEYS.* / ATT_KEY / spa_* 等）に一切触れず、
    // "__uiUndoTest_" prefix の合成キーのみで uiUndoable 本体の動作を検証する。
    // 取り消しボタンは undoHandler を直接呼ばず、実際に #toastUndoBtn を
    // クリックして発火させる。トーストは .toast.show でCSSトランジション
    // (0.3s, index.html:345)が入るため、commit後は350ms待ってからクリックする
    // （待たないとボタンがまだトランジション中で画面外にあり、Puppeteerの
    // クリックが「Node is either not clickable」で失敗することを実機で確認済み）。

    async function setKey(k, v) { await page.evaluate((kk, vv) => { StorageManager.setImmediate(kk, vv); }, k, v); }
    async function removeKey(k) { await page.evaluate((kk) => { StorageManager.remove(kk); }, k); }
    async function getKey(k) { return page.evaluate((kk) => StorageManager.getRaw(kk), k); }
    async function startUndo(msg, keys) { await page.evaluate((m, ks) => { window.__undoCommit = uiUndoable(m, ks); }, msg, keys); }
    async function commitUndo() {
        await page.evaluate(() => { window.__undoCommit(); });
        await new Promise(r => setTimeout(r, 350)); // toastのCSSトランジション完了待ち
    }
    async function clickUndoBtn() {
        await page.click('#toastUndoBtn');
        await new Promise(r => setTimeout(r, 100));
    }
    async function toastClass() { return page.evaluate(() => document.getElementById('toast').className); }

    // --- 1. 通常の取り消しで変更前の値に戻る ---
    {
        const K1 = '__uiUndoTest_k1';
        await setKey(K1, '[1,2,3]');
        await startUndo('undo-test-1', [K1]);
        await setKey(K1, '[]');
        await commitUndo();
        await clickUndoBtn();
        const v1 = await getKey(K1);
        const cls1 = await toastClass();
        check('通常の取り消しで変更前の値に戻る', v1 === '[1,2,3]' && /success/.test(cls1), 'v1=' + v1 + ' cls=' + cls1);
        await removeKey(K1);
    }

    // --- 2. 複数キーをまとめて戻す ---
    {
        const KA = '__uiUndoTest_a', KB = '__uiUndoTest_b', KC = '__uiUndoTest_c';
        await setKey(KA, '{"x":1}');
        await setKey(KB, '{"y":2}');
        await setKey(KC, '{"z":3}');
        await startUndo('undo-test-2', [KA, KB, KC]);
        await removeKey(KA);
        await setKey(KB, '{}');
        await setKey(KC, '{}');
        await commitUndo();
        await clickUndoBtn();
        const [va, vb, vc] = [await getKey(KA), await getKey(KB), await getKey(KC)];
        check('複数キーをまとめて戻す', va === '{"x":1}' && vb === '{"y":2}' && vc === '{"z":3}', JSON.stringify({ va, vb, vc }));
        await removeKey(KA); await removeKey(KB); await removeKey(KC);
    }

    // --- 3. 元々存在しなかったキーは復元時に削除される ---
    {
        const K2 = '__uiUndoTest_k2';
        await removeKey(K2); // 未存在を保証
        await startUndo('undo-test-3', [K2]);
        await setKey(K2, '{"新規":true}');
        await commitUndo();
        await clickUndoBtn();
        const v2 = await getKey(K2);
        check('元々存在しなかったキーは復元時に削除される', v2 === null, 'v2=' + v2);
        await removeKey(K2);
    }

    // --- 4. 取り消し可能時間中に別の変更が入ったら書き戻さない（競合検出） ---
    {
        const K4 = '__uiUndoTest_k4';
        await setKey(K4, '[1,2,3]');
        await startUndo('undo-test-4', [K4]);
        await setKey(K4, '[]');
        await commitUndo();
        await setKey(K4, '[9]'); // 取り消し可能時間中の割り込み変更
        await clickUndoBtn();
        const v4 = await getKey(K4);
        const cls4 = await toastClass();
        check('取り消し可能時間中に別の変更が入ったら書き戻さない（競合検出）', v4 === '[9]' && /warning/.test(cls4), 'v4=' + v4 + ' cls=' + cls4);
        await removeKey(K4);
    }

    // --- 5. 複数キーのうち1つでも競合したら全体を中止する（all-or-nothing） ---
    {
        const K5A = '__uiUndoTest_5a', K5B = '__uiUndoTest_5b';
        await setKey(K5A, '1');
        await setKey(K5B, '2');
        await startUndo('undo-test-5', [K5A, K5B]);
        await setKey(K5A, '0');
        await setKey(K5B, '0');
        await commitUndo();
        await setKey(K5B, '99'); // Bだけ割り込み
        await clickUndoBtn();
        const [v5a, v5b] = [await getKey(K5A), await getKey(K5B)];
        check('複数キーのうち1つでも競合したら全体を中止する（all-or-nothing）', v5a === '0' && v5b === '99', JSON.stringify({ v5a, v5b }));
        await removeKey(K5A); await removeKey(K5B);
    }

    // --- 6. スナップショット・確定・取り消しの3回とも保留書き込みが流れる ---
    // 実StorageManageの内部実装を変えずに観測するため、window.flushSaveQueue を
    // このケースの間だけ呼び出し回数を数えるラッパーに差し替え、直後に元へ戻す。
    {
        const K6 = '__uiUndoTest_k6';
        await setKey(K6, 'A');
        const afterSnapshot = await page.evaluate((k) => {
            const orig = window.flushSaveQueue;
            window.__flushCount6 = 0;
            window.__flushOrig6 = orig;
            window.flushSaveQueue = function() { window.__flushCount6++; return orig.apply(this, arguments); };
            window.__undoCommit = uiUndoable('undo-test-6', [k]);
            return window.__flushCount6;
        }, K6);
        await setKey(K6, 'B');
        const afterCommit = await page.evaluate(() => { window.__undoCommit(); return window.__flushCount6; });
        await new Promise(r => setTimeout(r, 350));
        await clickUndoBtn();
        const final6 = await page.evaluate((k) => ({ count: window.__flushCount6, val: StorageManager.getRaw(k) }), K6);
        await page.evaluate(() => { window.flushSaveQueue = window.__flushOrig6; delete window.__flushCount6; delete window.__flushOrig6; });
        check('スナップショット・確定・取り消しの3回とも保留書き込みが流れる',
            afterSnapshot === 1 && afterCommit === 2 && final6.count === 3 && final6.val === 'A',
            JSON.stringify({ afterSnapshot, afterCommit, final6 }));
        await removeKey(K6);
    }

    // --- 7. 遅延書き込み中でも正しく取り消せる ---
    // StorageManager.get/getRaw は _cacheLoaded===true の間は _cache を読むため、
    // set()（debounce書き込み）でも_cacheは即時更新されて「遅延中の古い値」を
    // 観測できない。index.htmlのコメント（uiUndoable直前）が言う「IndexedDB
    // 読込前（Phase A）はgetRawがlocalStorageを直接読む」状態を、
    // StorageManager._cacheLoaded を一時的にfalseへ操作して再現する。
    // 実StorageManagerの構造・挙動は変えず、既存の公開プロパティを操作するのみ。
    // _cacheLoaded の操作は Phase A（IndexedDB読込前）を再現するための内部
    // プロパティ依存であり、ここが落ちた場合は退行ではなく StorageManager の
    // 構造変更をまず疑うこと。
    {
        const K7 = '__uiUndoTest_k7';
        await setKey(K7, '[1,2]');
        const originalCacheLoaded = await page.evaluate(() => StorageManager._cacheLoaded);
        await page.evaluate(() => { StorageManager._cacheLoaded = false; });
        await startUndo('undo-test-7', [K7]); // before = getRaw (Phase A) = localStorage直読み = '[1,2]'
        await page.evaluate((k) => { StorageManager.set(k, '[]'); }, K7); // debounce書き込み。まだlocalStorageは'[1,2]'
        const rawBeforeFlush = await page.evaluate((k) => localStorage.getItem(k), K7);
        await commitUndo(); // commit()内でflushSaveQueue()が先に走り、debounce分を反映してからcommittedを読む
        const rawAfterCommit = await getKey(K7); // Phase AなのでこれもlocalStorage直読み
        await clickUndoBtn();
        const v7 = await getKey(K7);
        await page.evaluate((orig) => { StorageManager._cacheLoaded = orig; }, originalCacheLoaded);
        check('遅延書き込み中でも正しく取り消せる',
            rawBeforeFlush === '[1,2]' && rawAfterCommit === '[]' && v7 === '[1,2]',
            JSON.stringify({ rawBeforeFlush, rawAfterCommit, v7 }));
        await removeKey(K7);
    }

    // ================================================================
    // キャッシュ破棄の保証
    // ================================================================
    // UI_CACHE_RESETTERS / UI_PENDING_FLUSHERS には unregister が無いため、
    // テスト用に登録した関数はケースごとに Array.prototype.length を
    // 元の件数へ切り詰めて後始末する（関数はpage.evaluateの引数として
    // Node側へシリアライズできないため、配列長を戻す方式を取る）。
    // 一部のケースはキャッシュ破棄関数からわざと例外を投げるため、
    // console.error('uiResetCaches:', e) が実機で発生する。これは
    // uiResetCaches の例外耐性そのものを検証する意図的な発火であり、
    // マーカー文字列 __uiUndoTest_intentional_throw__ で末尾の
    // 「コンソールエラーなし」チェックから除外する。

    // --- 8. 復元時に登録済みの破棄関数がすべて呼ばれる ---
    {
        const K = '__uiUndoTest_cache1';
        await setKey(K, '1');
        const baseLen = await page.evaluate(() => {
            const n = UI_CACHE_RESETTERS.length;
            window.__order8 = [];
            uiRegisterCacheReset(function() { window.__order8.push('a'); });
            uiRegisterCacheReset(function() { window.__order8.push('b'); });
            return n;
        });
        await startUndo('undo-cache-1', [K]);
        await setKey(K, '2');
        await commitUndo();
        await clickUndoBtn();
        const order8 = await page.evaluate(() => window.__order8);
        check('復元時に登録済みの破棄関数がすべて呼ばれる', JSON.stringify(order8) === JSON.stringify(['a', 'b']), JSON.stringify(order8));
        await page.evaluate((n) => { UI_CACHE_RESETTERS.length = n; delete window.__order8; }, baseLen);
        await removeKey(K);
    }

    // --- 9. 競合で中止したときは破棄関数が呼ばれない ---
    {
        const K = '__uiUndoTest_cache2';
        await setKey(K, '1');
        const baseLen = await page.evaluate(() => {
            const n = UI_CACHE_RESETTERS.length;
            window.__called9 = 0;
            uiRegisterCacheReset(function() { window.__called9++; });
            return n;
        });
        await startUndo('undo-cache-2', [K]);
        await setKey(K, '2');
        await commitUndo();
        await setKey(K, '3'); // 取り消し可能時間中の割り込みで競合させる
        await clickUndoBtn();
        const called9 = await page.evaluate(() => window.__called9);
        check('競合で中止したときは破棄関数が呼ばれない', called9 === 0, 'called9=' + called9);
        await page.evaluate((n) => { UI_CACHE_RESETTERS.length = n; delete window.__called9; }, baseLen);
        await removeKey(K);
    }

    // --- 10. 破棄関数が例外を投げても後続が止まらない ---
    {
        const K = '__uiUndoTest_cache3';
        await setKey(K, '1');
        const baseLen = await page.evaluate(() => {
            const n = UI_CACHE_RESETTERS.length;
            window.__order10 = [];
            uiRegisterCacheReset(function() { throw new Error('__uiUndoTest_intentional_throw__'); });
            uiRegisterCacheReset(function() { window.__order10.push('後続'); });
            return n;
        });
        await startUndo('undo-cache-3', [K]);
        await setKey(K, '2');
        await commitUndo();
        await clickUndoBtn();
        const order10 = await page.evaluate(() => window.__order10);
        check('破棄関数が例外を投げても後続が止まらない', JSON.stringify(order10) === JSON.stringify(['後続']), JSON.stringify(order10));
        await page.evaluate((n) => { UI_CACHE_RESETTERS.length = n; delete window.__order10; }, baseLen);
        await removeKey(K);
    }

    // --- 11. 再描画関数はキャッシュ破棄より後に呼ばれる（順序保証） ---
    {
        const K = '__uiUndoTest_cache4';
        await setKey(K, '1');
        const baseLen = await page.evaluate((k) => {
            const n = UI_CACHE_RESETTERS.length;
            window.__order11 = [];
            uiRegisterCacheReset(function() { window.__order11.push('cache'); });
            window.__undoCommit = uiUndoable('undo-cache-4', [k], function() { window.__order11.push('render'); });
            return n;
        }, K);
        await setKey(K, '2');
        await commitUndo();
        await clickUndoBtn();
        const order11 = await page.evaluate(() => window.__order11);
        check('再描画関数はキャッシュ破棄より後に呼ばれる（順序保証）', JSON.stringify(order11) === JSON.stringify(['cache', 'render']), JSON.stringify(order11));
        await page.evaluate((n) => { UI_CACHE_RESETTERS.length = n; delete window.__order11; }, baseLen);
        await removeKey(K);
    }

    // --- 12. 再描画関数を省略しても落ちない ---
    {
        const K = '__uiUndoTest_cache5';
        await setKey(K, '1');
        await startUndo('undo-cache-5', [K]); // afterRestore省略
        await setKey(K, '2');
        await commitUndo();
        await clickUndoBtn();
        const v12 = await getKey(K);
        check('再描画関数を省略しても落ちない', v12 === '1', 'v12=' + v12);
        await removeKey(K);
    }

    // ================================================================
    // 保留書き込みの確定
    // ================================================================

    // --- 13. 保留中の入力が確定され、それが競合として検出される ---
    {
        const K = '__uiUndoTest_pend1';
        await setKey(K, 'A');
        await startUndo('undo-pending-1', [K]);
        await setKey(K, 'B'); // 一括操作の保存
        await commitUndo(); // committed = 'B'
        const baseLen = await page.evaluate((k) => {
            const n = UI_PENDING_FLUSHERS.length;
            uiRegisterPendingFlush(function() { StorageManager.setImmediate(k, 'B+手入力'); });
            return n;
        }, K);
        await clickUndoBtn();
        const v13 = await getKey(K);
        const cls13 = await toastClass();
        check('保留中の入力が確定され、それが競合として検出される', v13 === 'B+手入力' && /warning/.test(cls13), 'v13=' + v13 + ' cls=' + cls13);
        await page.evaluate((n) => { UI_PENDING_FLUSHERS.length = n; }, baseLen);
        await removeKey(K);
    }

    // --- 14. 保留が無ければ通常どおり書き戻せる ---
    {
        const K = '__uiUndoTest_pend2';
        await setKey(K, 'A');
        await startUndo('undo-pending-2', [K]);
        await setKey(K, 'B');
        await commitUndo();
        await clickUndoBtn(); // テスト用の保留フックは登録しない
        const v14 = await getKey(K);
        check('保留が無ければ通常どおり書き戻せる', v14 === 'A', 'v14=' + v14);
        await removeKey(K);
    }

    // --- 15. 確定フックの例外で取り消し全体が落ちない ---
    {
        const K = '__uiUndoTest_pend3';
        await setKey(K, 'A');
        await startUndo('undo-pending-3', [K]);
        await setKey(K, 'B');
        await commitUndo();
        const baseLen = await page.evaluate(() => {
            const n = UI_PENDING_FLUSHERS.length;
            uiRegisterPendingFlush(function() { throw new Error('__uiUndoTest_intentional_throw__'); });
            return n;
        });
        await clickUndoBtn();
        const v15 = await getKey(K);
        check('確定フックの例外で取り消し全体が落ちない', v15 === 'A', 'v15=' + v15);
        await page.evaluate((n) => { UI_PENDING_FLUSHERS.length = n; }, baseLen);
        await removeKey(K);
    }

    // --- 16. 確定フックは競合判定より前に走る（順序保証） ---
    {
        const K = '__uiUndoTest_pend4';
        await setKey(K, 'A');
        await page.evaluate((k) => {
            window.__order16 = [];
            window.__undoCommit = uiUndoable('undo-pending-4', [k], function() { window.__order16.push('render'); });
        }, K);
        await setKey(K, 'B');
        await commitUndo();
        const baseLen = await page.evaluate(() => {
            const n = UI_PENDING_FLUSHERS.length;
            uiRegisterPendingFlush(function() { window.__order16.push('flush'); });
            return n;
        });
        await clickUndoBtn();
        const order16 = await page.evaluate(() => window.__order16);
        const v16 = await getKey(K);
        check('確定フックは競合判定より前に走る（順序保証）', JSON.stringify(order16) === JSON.stringify(['flush', 'render']) && v16 === 'A', JSON.stringify({ order16, v16 }));
        await page.evaluate((n) => { UI_PENDING_FLUSHERS.length = n; delete window.__order16; }, baseLen);
        await removeKey(K);
    }

    // --- 17. セクション終了時、UI_CACHE_RESETTERS/UI_PENDING_FLUSHERSが元の件数(3/1)に戻っている ---
    {
        const finalCacheLen = await page.evaluate(() => UI_CACHE_RESETTERS.length);
        const finalPendingLen = await page.evaluate(() => UI_PENDING_FLUSHERS.length);
        check('セクション終了時にUI_CACHE_RESETTERS=3・UI_PENDING_FLUSHERS=1に戻っている',
            finalCacheLen === 3 && finalPendingLen === 1, JSON.stringify({ finalCacheLen, finalPendingLen }));
    }

    // ================================================================
    // コンソールエラーなし
    // ================================================================
    const realErrors = consoleErrors.filter(e =>
        e.url.indexOf('favicon') === -1 &&
        e.text.indexOf('__uiUndoTest_intentional_throw__') === -1
    );
    check('コンソールエラーなし（favicon 404除く、意図的な例外投入を除く）', realErrors.length === 0, JSON.stringify(realErrors));

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
