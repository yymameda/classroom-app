// トースト(画面下の通知)が、その下にあるボタンへのタップを受けてしまわないこと。
//   (student-id-migration.test.js の「末尾に転入生を追加」が、負荷の高いときだけ失敗する原因だった: 名簿を変更すると「バックアップを取っておくと
//    安心です」のトーストが約2.5秒、画面下に出る。名簿が長くなって「保存」ボタンが画面の下端に来ると、トーストが保存ボタンに重なり、
//    タップがトーストに当たって保存されなかった。実機のiPadでも、保存ボタンを押した指がトーストに当たって何も起きない可能性があった)
//   - 保存ボタンの真上にトーストが重なっている状態で、保存ボタンをタップすると保存される(タップがトーストに邪魔されない)
//   - トーストの中の「元に戻す」ボタンは、これまでどおりタップできる
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node toast-passthrough.test.js

const puppeteer = require('puppeteer-core');
const ui = require('./helpers/roster-ui');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = ui.sleep;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const students = [0, 1, 2, 3].map(i => ({ studentId: 'stu_toast00' + i, name: '甲乙丙丁'[i], gender: i % 2 ? '女' : '男', height: 130 + i }));

    try {
        // ---------- 1. 保存ボタンの上にトーストが重なっていても、タップは保存ボタンに届く ----------
        await page.evaluate((s) => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); StorageManager.setImmediate('spa_master', JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1 }, students: s })); }, students);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
        await ui.openSettings(page);
        await ui.act(page, 'insert', 3);                       // 転入生の行を追加(最初の編集 → バックアップを促すトーストが出る)
        await ui.setName(page, 4, '戊');
        // 保存ボタンの中心がトーストの帯(画面の下端から約20〜80px)に入るよう、画面の高さを合わせる
        const saveY = await page.evaluate(() => { const b = document.getElementById('rosterSaveBtn'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return r.top + r.height / 2 + window.scrollY; });
        await page.setViewport({ width: 1180, height: Math.round(saveY + 47) });
        await page.evaluate(() => { window.scrollTo(0, 0); });
        await sleep(200);
        const geo = await page.evaluate(() => {
            const b = document.getElementById('rosterSaveBtn'), t = document.getElementById('toast');
            b.scrollIntoView({ block: 'nearest' });
            const sr = b.getBoundingClientRect(), tr = t.getBoundingClientRect();
            const cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2;
            const top = document.elementFromPoint(cx, cy);
            return { cx, cy, toastShown: t.classList.contains('show'), toastTop: tr.top, toastBottom: tr.bottom, toastLeft: tr.left, toastRight: tr.right, covered: cx >= tr.left && cx <= tr.right && cy >= tr.top && cy <= tr.bottom, hit: top ? (top.id || top.tagName) + (top.closest('#toast') ? '(toast)' : '') : null };
        });
        check('前提: トーストが表示中で、保存ボタンの中心に重なっている(見た目の位置)', geo.toastShown && geo.covered, JSON.stringify(geo));
        check('保存ボタンの中心をタップすると、タップの対象は保存ボタン(トーストではない)', geo.hit === 'rosterSaveBtn', String(geo.hit));
        await page.mouse.click(geo.cx, geo.cy);                // 見えている位置を実際にタップする
        await ui.waitReload(page);
        const saved = JSON.parse(await page.evaluate(() => StorageManager.getRaw('spa_master'))).students;
        check('トーストが重なっていても、保存ボタンをタップすると保存される(5名になり、転入生に児童IDが付く)', saved.length === 5 && saved[4].name === '戊' && /^stu_/.test(saved[4].studentId), JSON.stringify(saved.map(s => s.name)));

        // ---------- 2. トースト自体の設定 ----------
        await page.setViewport({ width: 1180, height: 820 });
        const css = await page.evaluate(() => ({ toast: getComputedStyle(document.getElementById('toast')).pointerEvents, undo: getComputedStyle(document.getElementById('toastUndoBtn')).pointerEvents }));
        check('トーストはタップを受けない(pointer-events: none)。中の「元に戻す」ボタンだけがタップできる(auto)', css.toast === 'none' && css.undo === 'auto', JSON.stringify(css));

        // ---------- 3. 「元に戻す」ボタンは、これまでどおり実際のタップで押せる ----------
        await page.evaluate(() => { window.__undone = 0; showUndoToast('テスト用の通知', function() { window.__undone++; }); });
        await sleep(500);
        const ub = await page.evaluate(() => { const r = document.getElementById('toastUndoBtn').getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, hit: top ? top.id : null }; });
        check('「元に戻す」ボタンの位置には、そのボタンが最前面にある(44px以上)', ub.hit === 'toastUndoBtn' && ub.h >= 40, JSON.stringify(ub));
        await page.mouse.click(ub.x, ub.y);
        await sleep(200);
        check('「元に戻す」ボタンを実際にタップすると、取り消しの処理が1回呼ばれ、トーストが消える', (await page.evaluate(() => window.__undone)) === 1 && !(await page.evaluate(() => document.getElementById('toast').classList.contains('show'))), '');
        // 通常のトースト(元に戻すなし)は、下の要素へのタップを通す
        await page.evaluate(() => { showToast('通常のトースト', 'info'); });
        await sleep(500);
        const under = await page.evaluate(() => { const r = document.getElementById('toast').getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top ? (top.closest('#toast') ? 'toast' : (top.id || top.tagName)) : null; });
        check('通常のトースト(元に戻すなし)の位置をタップしても、トーストではなくその下の要素に届く', under !== 'toast', String(under));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear(); Object.keys(b).forEach(k => { if (b[k] !== null) StorageManager.setImmediate(k, b[k]); }); }, realBackup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== toast-passthrough: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
