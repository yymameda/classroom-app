// 段階4-4 機械検証: 検定カード(なわとび/水泳)で全技offになったら(stage===0)、
// recNwToggle(index.html:8426)がレコードを削除する(案A)ことの検証。
//
// 背景: 従来はstage=0でも上書き保存し続けていたため、「級の選択を解除」しても
// 監査診断のスコア件数が減らない実機不具合があった。recOnScoreBlurの削除パターン
// (splice→recSaveScores→showUndoToast)に倣い、recNwToggleにも同じ削除を追加した。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node kentei-nw-delete-on-zero.test.js

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

    try {
        const now = Date.now();
        const T = { nw: now + 1, sw: now + 2 };

        await page.evaluate(({ T }) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: [{ name: '検証用A' }, { name: '検証用B' }, { name: '検証用C' }],
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([
                { id: T.nw, subject: '体育', testType: '実技記録', category: '知識・技能', name: 'なわとびカード検証',
                  type: 'standard', maxScore: 9999, peUnit: 'なわとびカード', date: '2026-06-01', createdAt: new Date().toISOString() },
                { id: T.sw, subject: '体育', testType: '実技記録', category: '知識・技能', name: '泳力検定カード検証',
                  type: 'standard', maxScore: 9999, peUnit: '検定:swimming', date: '2026-06-01', createdAt: new Date().toISOString() }
            ]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([]));
        }, { T });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('input'); });
        await new Promise(r => setTimeout(r, 150));

        async function goto(testId) {
            await page.evaluate((id) => { window.recSelectTestGoto(id); }, testId);
            await new Promise(r => setTimeout(r, 150));
        }
        async function scoresFor(testId) {
            return page.evaluate((id) => StorageManager.get(KEYS.scores, []).filter(function(s) { return s.testId === id; }), testId);
        }
        async function toggle(idx, skillId) {
            await page.evaluate((i, s) => { window.recNwToggle(i, s); }, idx, skillId);
            await new Promise(r => setTimeout(r, 50));
        }

        // ================================================================
        // なわとびプリセット: 基本の作成→削除
        // ================================================================
        await goto(T.nw);
        await toggle(0, 'h1');
        let sc = await scoresFor(T.nw);
        check('なわとび: 技を1つ合格→レコードが作られる(1件)', sc.length === 1 && sc[0].studentIndex === 0, JSON.stringify(sc));

        await toggle(0, 'h1'); // 解除→全技off
        sc = await scoresFor(T.nw);
        check('なわとび: 唯一の技を解除して全技off→レコードが消える(0件)', sc.length === 0, JSON.stringify(sc));

        // ================================================================
        // 別の児童のレコードが影響を受けないこと
        // ================================================================
        await toggle(0, 'h1');
        await toggle(1, 'h1');
        await toggle(2, 'h1');
        sc = await scoresFor(T.nw);
        check('なわとび(前提): 3児童分のレコードが存在する', sc.length === 3, JSON.stringify(sc.map(s => s.studentIndex)));

        await toggle(1, 'h1'); // 児童1だけ解除
        sc = await scoresFor(T.nw);
        const idx0 = sc.find(s => s.studentIndex === 0);
        const idx1 = sc.find(s => s.studentIndex === 1);
        const idx2 = sc.find(s => s.studentIndex === 2);
        check('なわとび: 児童1のレコードだけ削除され、児童0・児童2は影響を受けない',
            sc.length === 2 && !!idx0 && !idx1 && !!idx2, JSON.stringify(sc));

        // 後片付け: 残り(児童0,2)も解除してクリーンな状態に戻す
        await toggle(0, 'h1');
        await toggle(2, 'h1');
        sc = await scoresFor(T.nw);
        check('なわとび(後片付け): 全児童分のレコードが消えている', sc.length === 0, JSON.stringify(sc));

        // ================================================================
        // 複数の技を合格→1つずつ解除→最後の1つで消える
        // ================================================================
        await toggle(0, 'h1');
        await toggle(0, 'h2');
        await toggle(0, 'h3');
        sc = await scoresFor(T.nw);
        check('なわとび: 3技合格でレコードが存在しstage=3', sc.length === 1 && sc[0].stage === 3, JSON.stringify(sc));

        await toggle(0, 'h1');
        sc = await scoresFor(T.nw);
        check('なわとび: 1つ解除(残り2技)してもレコードは残る(stage=2)', sc.length === 1 && sc[0].stage === 2, JSON.stringify(sc));

        await toggle(0, 'h2');
        sc = await scoresFor(T.nw);
        check('なわとび: 2つ目を解除(残り1技)してもレコードは残る(stage=1)', sc.length === 1 && sc[0].stage === 1, JSON.stringify(sc));

        await toggle(0, 'h3');
        sc = await scoresFor(T.nw);
        check('なわとび: 最後の1つを解除した時点でレコードが消える(0件)', sc.length === 0, JSON.stringify(sc));

        // ================================================================
        // 状態遷移: 削除後、再度タップすると新規レコードが作られる
        // ================================================================
        await toggle(0, 'h1');
        sc = await scoresFor(T.nw);
        check('状態遷移: 削除後に再タップすると新規レコードが作られる', sc.length === 1 && sc[0].stage === 1, JSON.stringify(sc));
        await toggle(0, 'h1'); // 後片付け
        sc = await scoresFor(T.nw);
        check('状態遷移(後片付け): クリーンな状態に戻っている', sc.length === 0, JSON.stringify(sc));

        // ================================================================
        // 水泳プリセットでも同じ挙動(なわとび・水泳で同一挙動)
        // ================================================================
        await goto(T.sw);
        await toggle(0, 'sh1');
        sc = await scoresFor(T.sw);
        check('水泳: 技を1つ合格→レコードが作られる(1件)', sc.length === 1 && sc[0].studentIndex === 0, JSON.stringify(sc));

        await toggle(0, 'sh1');
        sc = await scoresFor(T.sw);
        check('水泳: 唯一の技を解除して全技off→レコードが消える(0件)', sc.length === 0, JSON.stringify(sc));

        await toggle(0, 'sh1');
        await toggle(1, 'sh1');
        sc = await scoresFor(T.sw);
        check('水泳(前提): 2児童分のレコードが存在する', sc.length === 2, JSON.stringify(sc.map(s => s.studentIndex)));

        await toggle(0, 'sh1'); // 児童0だけ解除
        sc = await scoresFor(T.sw);
        const swIdx0 = sc.find(s => s.studentIndex === 0);
        const swIdx1 = sc.find(s => s.studentIndex === 1);
        check('水泳: 児童0のレコードだけ削除され、児童1は影響を受けない',
            sc.length === 1 && !swIdx0 && !!swIdx1, JSON.stringify(sc));
        await toggle(1, 'sh1'); // 後片付け
        sc = await scoresFor(T.sw);
        check('水泳(後片付け): 全児童分のレコードが消えている', sc.length === 0, JSON.stringify(sc));

        // ================================================================
        // undoトーストが表示され、実際に復元できること
        // (recCurrentTestIdは直前の水泳ブロックからT.swのままなので、必ずT.nwへ
        //  選択し直す。これを忘れると前段のtoggleがno-opになり、直前の水泳側
        //  cleanup操作が出した古いトーストを誤って読んでしまう)
        // ================================================================
        await goto(T.nw);
        await toggle(0, 'h1');
        await toggle(0, 'h1'); // 削除発生 → undoトースト表示
        await new Promise(r => setTimeout(r, 100));
        const toastState = await page.evaluate(() => {
            var t = document.getElementById('toast');
            var msgEl = document.getElementById('toastMsg');
            return { shown: t ? t.classList.contains('show') : false, msg: msgEl ? msgEl.textContent : null };
        });
        check('undoトースト: 削除時に「記録を削除しました」のトーストが表示される', toastState.shown === true && toastState.msg === '記録を削除しました', JSON.stringify(toastState));

        await page.evaluate(() => { document.getElementById('toastUndoBtn').click(); });
        await new Promise(r => setTimeout(r, 100));
        sc = await scoresFor(T.nw);
        check('undoトースト: 取り消しを押すと削除前のレコードが復元される', sc.length === 1 && sc[0].stage === 1, JSON.stringify(sc));
        await toggle(0, 'h1'); // 後片付け
        sc = await scoresFor(T.nw);
        check('undoトースト検証後(後片付け): クリーンな状態に戻っている', sc.length === 0, JSON.stringify(sc));

        // ================================================================
        // コンソールエラーの回帰確認
        // ================================================================
        const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
        check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
        const restored = {};
        for (const k of Object.values(REAL_KEYS)) restored[k] = await getKey(k);
        const allRestored = Object.values(REAL_KEYS).every(k => restored[k] === backup[k]);
        check('触れた実データキーがすべて元の値に復元されている', allRestored, JSON.stringify({ restored: Object.keys(REAL_KEYS) }));
        await browser.close();
    }

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
