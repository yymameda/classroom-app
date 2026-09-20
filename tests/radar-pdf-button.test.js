// 面談用レーダーPDFのボタン(📄 面談用レーダーPDF（全員連続）)が、本番の経路で PDF の生成まで到達すること(v1.60.1)。
//   不具合: 体育の検定(なわとび・泳力)の記録がある児童がいると、教科カードの検定の行を作る grdExtKenteiLabel が
//   kenteiStageToLabel を呼んで ReferenceError(その関数は検定カードのモジュールの中だけで定義され、window に公開されていなかった)。
//   ボタンの処理は async で、例外は Unhandled rejection としてコンソールに出るだけだったので、画面には何も起きなかった(v1.8.76〜。v1.59.1 でも同じ)。
//   直し: kenteiStageToLabel を window に公開／成績画面のボタンの処理が例外で止まったら、トーストで「失敗しました」と知らせる。
//   このテストは htmlPagesToPdf・universalShare などを差し替えず、実際のボタンのクリックから、html2canvas・jsPDF・結果ダイアログまで通す。
//   (以前の radar-card-term.test.js は htmlPagesToPdf を差し替え、検定の記録も無い題材だったので、この不具合を見つけられなかった)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node radar-pdf-button.test.js

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
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => { pageErrors.push(err.message); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []);
            put(K.scores, d.scores || []);
            put(K.assigns, []); put(K.subs, []); put(K.att, {}); put(K.weights, {});
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
    }
    // 成績処理で学期を選ぶ → 実際のボタンをクリックする。差し替えるのは「記録用の見張り」だけ(html2canvas に渡された中身を控えて、元の関数をそのまま呼ぶ)
    async function clickRadar(term) {
        await page.evaluate((term) => {
            window.__rendered = [];
            if (!window.__origH2C) window.__origH2C = window.html2canvas;
            window.html2canvas = function(el, opts) { window.__rendered.push((el.innerText || '').replace(/\s+/g, ' ')); return window.__origH2C(el, opts); };
            const old = document.getElementById('pdfResultOverlay'); if (old) old.remove();
            showView('grades');
            const s = document.getElementById('grdTermSel'); s.value = term; s.dispatchEvent(new Event('change'));
        }, term);
        await sleep(300);
        await page.evaluate(() => { document.getElementById('grdExtRadarPdfBtn').click(); });
    }
    async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(300); } return false; }
    const toastText = () => page.evaluate(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show') ? (document.getElementById('toastMsg') || {}).textContent : ''; });

    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score }, extra || {});
    // 題材: 2名。国語の小テスト・体育のなわとび(検定カード。記録あり)・体育の水泳(検定カード。段階つき)
    const tests = [
        T({ id: 1, name: '漢字テスト' }),
        T({ id: 2, subject: '体育', name: 'なわとび', testType: '実技記録', maxScore: 9999, peUnit: 'なわとびカード', term: '1' }),
        T({ id: 3, subject: '体育', name: '水泳', testType: '実技記録', maxScore: 9999, peUnit: '検定:swimming', term: '1' })
    ];
    const scores = [S(1, 0, 8), S(1, 1, 6), S(2, 0, 3, { stage: 3 }), S(2, 1, 5, { stage: 5 }), S(3, 0, 2, { stage: 2 })];

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores });

        // ============ 0. 公開された関数と、成績画面の値(変えない) ============
        const pub = await page.evaluate(() => {
            const cfg = kenteiGetConfig(recGetTests().find(t => t.id === 2));
            return { fn: typeof window.kenteiStageToLabel, label: (typeof window.kenteiStageToLabel === 'function' && cfg) ? window.kenteiStageToLabel(cfg, 3) : null, cfg: !!cfg };
        });
        check('検定カードの級のラベルを返す関数が、成績画面のモジュールからも呼べる(window に公開されている)', pub.fn === 'function' && pub.cfg && typeof pub.label === 'string' && pub.label.length > 0, JSON.stringify(pub));
        const gradesBefore = await page.evaluate(() => ['1', 'all'].map(t => JSON.stringify(['国語', '体育'].map(s => grdCalculate(s, t).map(r => [r.knowledge.avg, r.knowledge.abc, r.hyoutei])))));

        // ============ 1. 本番のボタンをクリック → PDF の結果ダイアログまで到達する(検定の記録がある題材) ============
        await clickRadar('1');
        const reached = await waitFor(() => !!document.getElementById('pdfResultOverlay'), 90000);
        const overlay = await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); return o ? o.textContent.replace(/\s+/g, ' ').slice(0, 120) : ''; });
        check('面談用レーダーPDFのボタンを押すと、PDFの結果ダイアログ(「PDFができました」)まで到達する', reached && /PDFができました/.test(overlay), overlay || '(ダイアログなし)');
        check('コンソールのエラーが0件・キャッチされない例外が0件(ReferenceError なし)', consoleErrors.length === 0 && pageErrors.length === 0, JSON.stringify(consoleErrors.concat(pageErrors).slice(0, 3)));
        const rendered = await page.evaluate(() => window.__rendered.join('\n'));
        check('PDFの中身: 教科カードに、検定の行(「なわとび：…」「泳力：…」)と国語のカードが入っている', /なわとび：/.test(rendered) && /泳力：/.test(rendered) && /国語/.test(rendered), rendered.slice(0, 200));
        const gradesAfter = await page.evaluate(() => ['1', 'all'].map(t => JSON.stringify(['国語', '体育'].map(s => grdCalculate(s, t).map(r => [r.knowledge.avg, r.knowledge.abc, r.hyoutei])))));
        check('成績画面の評定・観点別の値は、PDFを作る前後で完全に同じ', JSON.stringify(gradesBefore) === JSON.stringify(gradesAfter), '');
        await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });

        // ============ 2. ボタンの処理が失敗したら、トーストで知らせる(何も出ないまま終わらない) ============
        //   処理の中で例外を起こす: 課題一覧を返す関数を、例外を投げるものに差し替える
        await page.evaluate(() => { window.__origRecGetTests = window.recGetTests; window.recGetTests = function() { throw new Error('テスト用の失敗'); }; });
        await clickRadar('1');
        const notified = await waitFor(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show') && /失敗/.test((document.getElementById('toastMsg') || {}).textContent || ''); }, 20000);
        const msg = await toastText();
        check('処理が失敗したとき、トーストで「面談用レーダーPDF…に失敗しました: 原因」と知らせる(何も出ないまま終わらない)', notified && /面談用レーダーPDF/.test(msg) && /失敗しました/.test(msg) && /テスト用の失敗/.test(msg), msg);
        check('失敗したときは、PDFの結果ダイアログは出ない', await page.evaluate(() => !document.getElementById('pdfResultOverlay')), '');
        await page.evaluate(() => { window.recGetTests = window.__origRecGetTests; });
        // 失敗のトースト後も、同じボタンをもう一度押せて、今度は最後まで通る
        await sleep(300);
        await clickRadar('1');
        const again = await waitFor(() => !!document.getElementById('pdfResultOverlay'), 90000);
        check('失敗のあとも、同じボタンをもう一度押すと(原因が直っていれば)最後まで通る', again, '');
        await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });

        // ============ 3. 同じ仕組みを使う他のボタン(CSV)は、今までどおり動く ============
        const csv = await page.evaluate(async () => {
            window.__csv = null;
            window.universalShare = function(blob, name) { return blob.text().then(function(t) { window.__csv = t; }); };
            showView('grades');
            const g = document.getElementById('grdGradeSubj'); g.value = '国語';
            document.getElementById('grdCSVBtn').click();
            await new Promise(r => setTimeout(r, 400));
            return (window.__csv || '').replace(/^﻿/, '').split('\n')[0];
        });
        check('成績画面の「CSV」ボタンは今までどおり動く(見出し行が出る)', /^No\.,氏名,評定/.test(csv), csv);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== radar-pdf-button: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
