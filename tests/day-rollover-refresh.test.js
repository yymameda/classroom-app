// 日付が変わったあとの再描画(v1.60.2)。アプリを開いたまま日付が変わって画面に戻ったとき(visibilitychange)、
//   INIT の日付更新の処理が、忘れ物の画面なら fgtShowSub('input')、提出物の画面なら subRenderDiary() を呼ぶ。
//   どちらも別モジュール(IIFE)の中の関数で window に公開されておらず、ReferenceError になっていた(復旧バーが出る可能性)。
//   また `fgtDate = new Date()` は、忘れ物モジュールの中の fgtDate ではなく、別の(誤った)グローバル変数に代入していた
//   → 日付が変わっても、忘れ物の画面の日付が今日に更新されなかった。
//   直し: fgtShowSub・subRenderDiary を window に公開し、忘れ物の日付を今日に戻す関数(fgtGoToday)を公開して使う。
//   このテストは本番の経路(visibilitychange)を通し、日付の変更は Date の差し替えで再現する。
//   あわせて、HTML の on* 属性(onclick など)から呼ばれる関数が、すべて window から呼べることを確かめる(同種の未公開参照の再発防止)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node day-rollover-refresh.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

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
    const KN = await page.evaluate(() => ({ master: KEYS.master }));
    const backup = await page.evaluate((K) => StorageManager.getRaw(K.master), KN);

    try {
        await page.evaluate((K) => {
            StorageManager.setImmediate(K.master, JSON.stringify({ version: 2, students: [{ name: '甲' }, { name: '乙' }], classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3 } }));
        }, KN);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);

        // 日付を n 日進めて、画面に戻ったこと(visibilitychange)を通知する。Date の差し替えだけで再現する
        async function rollover(view, days) {
            const before = pageErrors.length;
            await page.evaluate((view, days) => {
                showView(view);
                if (!window.__RealDate) window.__RealDate = Date;
                const RD = window.__RealDate;
                const shift = days * 86400000;
                window.Date = class extends RD {
                    constructor(...a) { if (a.length) super(...a); else super(RD.now() + shift); }
                    static now() { return RD.now() + shift; }
                };
                const bar = document.getElementById('recoveryBar'); if (bar) bar.style.display = 'none';
                // 出たトーストをすべて控える(あとから別のトーストで上書きされても分かるように)
                window.__toastsSeen = [];
                if (!window.__origShowToast) { window.__origShowToast = window.showToast; window.showToast = function(m) { window.__toastsSeen.push(String(m)); return window.__origShowToast.apply(this, arguments); }; }
                document.dispatchEvent(new Event('visibilitychange'));
            }, view, days);
            await sleep(400);
            return page.evaluate((before) => ({
                recovery: (document.getElementById('recoveryBar') || {}).style ? document.getElementById('recoveryBar').style.display : '',
                toast: (window.__toastsSeen || []).join(' | '),
                fgtLabel: (document.getElementById('fgtDateLabel') || {}).textContent || '',
                active: (document.querySelector('.view.active') || {}).id
            }), before).then(r => Object.assign(r, { errors: pageErrors.slice(before) }));
        }
        const todayLabel = await page.evaluate(() => { showView('forgotten'); return document.getElementById('fgtDateLabel').textContent; });

        // ============ 1. 忘れ物の画面 ============
        const f = await rollover('forgotten', 2);
        check('忘れ物の画面で日付が変わって戻っても、エラーにならない(復旧バーも出ない)', f.errors.length === 0 && f.recovery !== 'block' && f.active === 'view-forgotten', JSON.stringify({ errors: f.errors.slice(0, 2), recovery: f.recovery }));
        check('忘れ物の画面で日付が変わって戻ると、「日付が更新されました」と知らせ、画面の日付も今日(2日後)に更新される', /日付が更新されました/.test(f.toast) && (/\d+月\d+日/.exec(f.fgtLabel) || [''])[0] !== (/\d+月\d+日/.exec(todayLabel) || [''])[0] && f.fgtLabel.length > 0, f.toast + ' / ' + todayLabel + ' → ' + f.fgtLabel);

        // ============ 2. 提出物の画面 ============
        const s = await rollover('submissions', 3);
        check('提出物の画面で日付が変わって戻っても、エラーにならない(復旧バーも出ない)', s.errors.length === 0 && s.recovery !== 'block' && s.active === 'view-submissions' && /日付が更新されました/.test(s.toast), JSON.stringify({ errors: s.errors.slice(0, 2), recovery: s.recovery, toast: s.toast }));

        // ============ 3. 出席簿の画面(元から動いていた。壊れていないことの確認) ============
        const a = await rollover('attendance', 4);
        check('出席簿の画面も、日付が変わって戻ってもエラーにならない(今までどおり)', a.errors.length === 0 && a.recovery !== 'block' && /日付が更新されました/.test(a.toast), JSON.stringify({ errors: a.errors.slice(0, 2), toast: a.toast }));
        check('公開された関数: fgtShowSub・subRenderDiary・fgtGoToday が window から呼べる', await page.evaluate(() => typeof window.fgtShowSub === 'function' && typeof window.subRenderDiary === 'function' && typeof window.fgtGoToday === 'function'), '');
        // 再描画が失敗したときは、復旧バーではなくトーストで知らせる(失敗を黙って握りつぶさない)
        await page.evaluate(() => { window.__origFgtShowSub = window.fgtShowSub; window.fgtShowSub = function() { throw new Error('テスト用の失敗'); }; });
        const ff = await rollover('forgotten', 5);
        check('忘れ物の再描画が失敗したときは、トーストで「失敗しました: 原因」と知らせる(復旧バーは出ない)', /忘れ物の画面の日付の更新に失敗しました: テスト用の失敗/.test(ff.toast) && ff.recovery !== 'block', ff.toast);
        await page.evaluate(() => { window.fgtShowSub = window.__origFgtShowSub; window.__origSubRenderDiary = window.subRenderDiary; window.subRenderDiary = function() { throw new Error('テスト用の失敗'); }; });
        const sf = await rollover('submissions', 6);
        check('提出物の再描画が失敗したときも、トーストで「失敗しました: 原因」と知らせる(復旧バーは出ない)', /提出物の画面の更新に失敗しました: テスト用の失敗/.test(sf.toast) && sf.recovery !== 'block', sf.toast);
        await page.evaluate(() => { window.subRenderDiary = window.__origSubRenderDiary; if (window.__RealDate) window.Date = window.__RealDate; });

        // ============ 4. HTML の on* 属性から呼ばれる関数は、すべて window から呼べる(同種の未公開参照の再発防止) ============
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
        const attrs = [...html.matchAll(/\bon(?:click|change|input|keydown|keyup|keypress|blur|focus|submit|dblclick|touchstart|touchend|mousedown|mouseup|pointerdown|contextmenu|toggle)\s*=\s*\\?(["'])(.*?)\\?\1/g)].map(m => m[2]);
        const SKIP = new Set(['if', 'return', 'function', 'this', 'event', 'document', 'window', 'Math', 'parseInt', 'parseFloat', 'String', 'Number', 'JSON', 'setTimeout', 'alert', 'confirm', 'prompt', 'encodeURIComponent', 'stopPropagation', 'preventDefault', 'getElementById', 'querySelector', 'querySelectorAll', 'stopImmediatePropagation', 'closest', 'click', 'focus', 'blur', 'select', 'remove', 'add', 'toggle', 'contains', 'setAttribute', 'getAttribute', 'removeAttribute', 'test', 'replace', 'indexOf', 'push', 'join', 'split', 'slice', 'toString', 'trim', 'Boolean', 'Array', 'Object', 'Date', 'isNaN', 'open', 'close', 'stop', 'call', 'apply', 'bind', '_jsEscapeKey']);
        const names = new Set();
        attrs.forEach(b => { for (const m of b.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!SKIP.has(m[1])) names.add(m[1]); });
        const missing = await page.evaluate((names) => names.filter(n => { try { return eval('typeof ' + n) === 'undefined'; } catch (e) { return true; } }), [...names]);
        check('HTML の on* 属性(' + attrs.length + '件)から呼ばれる関数(' + names.size + '種類)は、すべて window から呼べる', attrs.length > 150 && names.size > 100 && missing.length === 0, JSON.stringify(missing));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b, K) => { if (window.__RealDate) window.Date = window.__RealDate; if (b === null) StorageManager.remove(K.master); else StorageManager.setImmediate(K.master, b); }, backup, KN).catch(() => {});
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== day-rollover-refresh: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
