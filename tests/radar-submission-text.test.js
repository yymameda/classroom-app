// 面談用レーダーPDFの「提出率 60%(3/6)」の切り捨て表示を、成績処理と同じ評価点ベースの表記に直す(v1.61.1)。
//   以前は、評価点の合計(3.6)を切り捨てて「3/6」と出していたので、割合(60%)と合わないように見えた(1ページ目の「提出物：提出率 60%（3/6件）」と、教科カードの「提出率 60%(3/6)」)。
//   今は成績処理(v1.61.0)と同じ「評価点 3.6/6（60%）」。文字は成績処理の項目の説明文(grdCalculate の提出物の項目の detail)と同じ関数で作る。
//   成績の数字(10点換算・観点別・評定・提出率の%)は変えない。カルテPDFの提出率(%だけの表示)は変えない。
//   本番のボタン(#grdExtRadarPdfBtn)→ html2canvas・jsPDF → 結果ダイアログまで通す(htmlPagesToPdf は差し替えない)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node radar-submission-text.test.js

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
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, []); put(K.scores, []); put(K.assigns, d.assigns); put(K.subs, d.subs);
            put(K.att, {}); put(K.weights, {}); put(K.patrol, []);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => {
            window.__rendered = []; window.__renderedHtml = [];
            window.__origH2C = window.html2canvas;
            window.html2canvas = function(el, opts) { window.__rendered.push((el.innerText || '').replace(/\s+/g, ' ')); window.__renderedHtml.push(el.outerHTML); return window.__origH2C(el, opts); };
        });
    }
    async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; }
    async function pdfRun(clickFn, ...args) {
        await page.evaluate(() => { window.__rendered = []; window.__renderedHtml = []; const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });
        await page.evaluate(clickFn, ...args);
        const ok = await waitFor(() => !!document.getElementById('pdfResultOverlay'), 90000);
        const out = await page.evaluate(() => ({ text: window.__rendered.slice() }));
        await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });
        return Object.assign({ ok }, out);
    }
    const radar = (term) => pdfRun((term) => { showView('karte'); kvSetMode('output'); const s = document.getElementById('kvTermSel'); s.value = term; s.dispatchEvent(new Event('change')); document.getElementById('grdExtRadarPdfBtn').click(); }, term);
    const kartePdf = (design, term, idx) => pdfRun((design, term, idx) => {
        showView('karte'); kvSetMode('output');
        const s = document.getElementById('kvTermSel'); s.value = term; s.dispatchEvent(new Event('change'));
        document.getElementById('kvSec_grades').checked = false;
        document.querySelectorAll('.kv-subj-chk').forEach(c => { c.checked = (c.value === '国語'); });
        document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(idx)); });
        const r = document.querySelector('input[name="kvDesign"][value="' + design + '"]'); if (r) r.checked = true;
        document.getElementById('kvPrintBtn').click();
    }, design, term, idx);

    // 題材: 国語の宿題6件(甲: 提出1.0・お直し前0.8・お直し済1.0・遅れて提出0.8・未提出・記録なし → 評価点3.6/6＝60%)と、算数の宿題2件(甲: 2件とも提出 → 2/2＝100%)
    const A = (id, subject, name, date) => ({ id, subject, name, date, term: '1', createdAt: '2026-05-01T00:00:00Z' });
    const assigns = [A(101, '国語', '宿題1', '2026-05-11'), A(102, '国語', '宿題2', '2026-05-12'), A(103, '国語', '宿題3', '2026-05-13'), A(104, '国語', '宿題4', '2026-05-14'), A(105, '国語', '宿題5', '2026-05-15'), A(106, '国語', '宿題6', '2026-05-16'), A(201, '算数', '計算1', '2026-05-11'), A(202, '算数', '計算2', '2026-05-12')];
    let rid = 0;
    const R = (i, a, status, extra) => Object.assign({ id: ++rid, studentIndex: i, assignmentId: a, status, correctionDone: status === 'submitted', createdAt: '2026-05-20T00:00:00Z' }, extra || {});
    const subs = [
        R(0, 101, 'submitted'), R(0, 102, 'resubmit', { correctionDone: false }), R(0, 103, 'resubmit', { correctionDone: true }), R(0, 104, 'submitted', { lateOnDue: true }), R(0, 105, 'missing'),
        R(0, 201, 'submitted'), R(0, 202, 'submitted'),
        R(1, 101, 'submitted'), R(1, 102, 'submitted'), R(1, 103, 'submitted'), R(1, 104, 'submitted'), R(1, 105, 'submitted'), R(1, 106, 'submitted'),   // 乙: 国語 6/6＝100%(整数)
        R(2, 101, 'submitted'), R(2, 102, 'submitted'), R(2, 103, 'submitted'), R(2, 104, 'submitted')   // 丙: 国語 4/6＝66.67%(四捨五入で67%。切り捨てなら66%)
    ];
    const pageOf = (r, i, kind) => { const re = new RegExp((i + 1) + '\\s*' + ['甲', '乙', '丙'][i] + '\\s*さん\\s*' + (kind === 'card' ? '教科別のくわしい記録' : '学習のようす')); const k = r.text.findIndex(t => re.test(t)); return k < 0 ? '' : r.text[k]; };

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], assigns, subs });

        // ============ 0. 成績の数字(変えない): 提出物の10点換算・提出率(%) ============
        const grade = await page.evaluate(() => ['国語', '算数'].map(s => grdCalculate(s, '1').map(r => { const it = r.attitude.items.find(x => x.itemKey === 'submission'); return [it.score10, it.detail]; })));
        check('成績処理: 提出物の10点換算は 国語(甲6・乙10)・算数(甲10)。説明文は「評価点 3.6/6（60%）」(v1.61.0)', JSON.stringify(grade[0].map(x => x[0])) === '[6,10,6.7]' && grade[0][0][1] === '評価点 3.6/6（60%）' && grade[0][1][1] === '評価点 6/6（100%）' && grade[1][0][0] === 10 && grade[1][0][1] === '評価点 2/2（100%）', JSON.stringify(grade));

        // ============ 1. レーダーPDF(1学期) ============
        const r1 = await radar('1');
        check('レーダーPDF: 本番のボタンから結果ダイアログまで到達し、コンソールエラー0件', r1.ok && consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 2)));
        const p1 = pageOf(r1, 0, 'main'), c1 = pageOf(r1, 0, 'card');
        check('レーダーPDF 1ページ目(甲): 「提出物：評価点 5.6/8（70%）」(国語3.6/6＋算数2/2の合計。以前は「提出率 70%（5/8件）」で5.6を切り捨てていた)', /提出物：評価点 5\.6\/8（70%）/.test(p1), (/提出物：[^　]*/.exec(p1) || ['(なし)'])[0]);
        check('レーダーPDF 1ページ目: 「N/M件」の表記は出ない。コメントは提出率70%の段階のまま(おおむね提出できています)', !/\d+\/\d+件/.test(p1) && /おおむね提出できています/.test(p1), (/提出物：.{0,60}/.exec(p1) || ['(なし)'])[0]);
        check('レーダーPDF 教科カード(甲): 国語は「提出物：評価点 3.6/6（60%）」・算数は「提出物：評価点 2/2（100%）」。以前の「提出率 60%(3/6)」は出ない', /国語[^算]*提出物：評価点 3\.6\/6（60%）/.test(c1) && /算数[^国]*提出物：評価点 2\/2（100%）/.test(c1) && !/提出率 \d+%\(\d+\/\d+\)/.test(c1), (c1.match(/提出物：評価点 [^ ]*/g) || []).join(' | ') + ' // ' + (c1.match(/提出率[^ ]*/g) || []).join(' | '));
        const c1b = pageOf(r1, 1, 'card');
        check('レーダーPDF 教科カード(乙): 整数の評価点は「評価点 6/6（100%）」(小数点を付けない)', /提出物：評価点 6\/6（100%）/.test(c1b), (c1b.match(/提出物：評価点 [^ ]*/g) || []).join(' | '));
        const c1c = pageOf(r1, 2, 'card');
        check('レーダーPDF 教科カード(丙): 4/6は「評価点 4/6（67%）」(割合は四捨五入。切り捨ての66%にならない)。1ページ目(国語4/6＋算数0/2)は「評価点 4/8（50%）」', /国語[^算]*提出物：評価点 4\/6（67%）/.test(c1c) && /提出物：評価点 4\/8（50%）/.test(pageOf(r1, 2, 'main')), (c1c.match(/提出物：評価点 [^ ]*/g) || []).join(' | '));
        // 成績処理と同じ関数の文字: カードの文字が grdCalculate の提出物の項目の説明文と一致する
        const cardTexts = (c1.match(/提出物：(評価点 [\d.]+\/\d+（\d+%）)/g) || []).map(s => s.replace('提出物：', ''));
        check('カードの評価点の文字は、成績処理(grdCalculate)の提出物の項目の説明文と一致する(国語・算数)', JSON.stringify(cardTexts) === JSON.stringify([grade[0][0][1], grade[1][0][1]]), JSON.stringify(cardTexts));

        // ============ 2. カルテPDF(児童用・教員用)の提出率は、% だけの表示のまま(変えない) ============
        const kt = await kartePdf('teacher', '1', 0), kc = await kartePdf('child', '1', 0);
        check('カルテPDF(教員用・児童用): 提出率は 60% の表示のまま(「評価点」の文字や件数の切り捨て表示は出ない)', /提出物（提出率 60%）/.test(kt.text[0]) && /提出率 ?60%/.test(kc.text[0]) && !/評価点/.test(kt.text[0] + kc.text[0]), (/提出物（提出率[^）]*）/.exec(kt.text[0]) || ['(なし)'])[0]);

        // ============ 3. 成績の数字は、出力のあとも変わらない ============
        const grade2 = await page.evaluate(() => ['国語', '算数'].map(s => grdCalculate(s, '1').map(r => { const it = r.attitude.items.find(x => x.itemKey === 'submission'); return [it.score10, it.detail]; })));
        check('成績処理: 提出物の10点換算・説明文は、レーダーPDFを出したあとも同じ', JSON.stringify(grade2) === JSON.stringify(grade), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== radar-submission-text: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
