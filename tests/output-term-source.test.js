// 出力の学期の出所を「ボタンがある画面の学期セレクタ」に統一し、すべての出力に対象学期を印字する(v1.60.2)。
//   iPad 実機(v1.60.1)で、面談用レーダーPDFのボタンは成績処理画面ではなく個人カルテ(出力)の画面にあり、PDFのどこにも学期が書かれていなかった。
//   以前は、レーダーPDFの評定・カード・提出物・机間巡視が「成績処理画面の学期」で計算されていた(出力画面の学期の選択が効かない)。
//   今は: 個人カルテ(出力)の画面のボタン(レーダーPDF・カルテPDF・面談テキスト)=出力画面の学期(kvTermSel)／
//         成績処理画面のボタン(同僚用テンプレート・算出根拠Excel・成績CSV)=成績処理画面の学期(grdTermSel)。
//   印字する学期: レーダーPDF(1ページ目・2ページ目とも)・カルテPDF(児童用は通年も)・面談テキスト・算出根拠Excel(表題・ファイル名)・成績CSV(ファイル名)。
//   本番のボタンのクリック → html2canvas・jsPDF → 結果ダイアログまで通す(htmlPagesToPdf は差し替えない。html2canvas は中身を控える見張りだけ)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node output-term-source.test.js

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
            put(K.tests, d.tests || []);
            put(K.scores, d.scores || []);
            put(K.assigns, d.assigns || []);
            put(K.subs, d.subs || []);
            put(K.att, {}); put(K.weights, {}); put(K.patrol, d.patrol || []);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => {
            window.__rendered = []; window.__renderedHtml = [];
            window.__origH2C = window.html2canvas;
            window.html2canvas = function(el, opts) { window.__rendered.push((el.innerText || '').replace(/\s+/g, ' ')); window.__renderedHtml.push(el.outerHTML); return window.__origH2C(el, opts); };
            // SheetJS の代役(シートの中身とファイル名を記録するだけ)
            const col = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
            window.XLSX = { utils: { encode_col: col, encode_cell: (a) => col(a.c) + (a.r + 1), book_new: () => ({ names: [], sheets: {} }), book_append_sheet: (wb, ws, name) => { wb.names.push(name); wb.sheets[name] = ws; window.__wb = wb; }, aoa_to_sheet: (aoa) => ({ __aoa: aoa }) }, write: () => new Uint8Array(1) };
            window.__shared = null; window.__csv = null;
            window.universalShare = function(blob, name) { window.__shared = name; return blob.text().then(function(t) { window.__csv = t; }); };
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
        });
    }
    async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; }
    async function setGradeTerm(term) { await page.evaluate((term) => { showView('grades'); const s = document.getElementById('grdTermSel'); s.value = term; s.dispatchEvent(new Event('change')); }, term); await sleep(250); }
    async function setOutputTerm(term) { await page.evaluate((term) => { showView('karte'); kvSetMode('output'); const s = document.getElementById('kvTermSel'); s.value = term; s.dispatchEvent(new Event('change')); }, term); await sleep(150); }
    async function pdfRun(clickFn, ...args) {
        await page.evaluate(() => { window.__rendered = []; window.__renderedHtml = []; const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });
        await page.evaluate(clickFn, ...args);
        const ok = await waitFor(() => !!document.getElementById('pdfResultOverlay'), 90000);
        const out = await page.evaluate(() => ({ text: window.__rendered.slice(), html: window.__renderedHtml.slice() }));
        await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });
        return Object.assign({ ok }, out);
    }
    const clickRadar = () => { document.getElementById('grdExtRadarPdfBtn').click(); };
    const rowOf = (html) => { const m = /<td[^>]*>国語<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td>/.exec(html || ''); return m ? m.slice(1, 5).join(',') : '?'; };
    const avgOf = (t) => { const m = /テスト平均 ([\d.]+)点\(換算\)/.exec(t || ''); return m ? m[1] : '-'; };

    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score }, extra || {});
    // 題材: 国語の小テスト(1学期=甲8点・2学期=甲4点)・体育のなわとび(検定。1学期・2学期に1件ずつ)・国語の宿題(1学期=提出・2学期=未提出)
    const tests = [
        T({ id: 1, name: '漢字一学期', term: '1' }), T({ id: 2, name: '漢字二学期', term: '2', date: '2026-09-10' }),
        T({ id: 3, subject: '体育', name: 'なわとび一学期', testType: '実技記録', maxScore: 9999, peUnit: 'なわとびカード', term: '1' }),
        T({ id: 4, subject: '体育', name: 'なわとび二学期', testType: '実技記録', maxScore: 9999, peUnit: 'なわとびカード', term: '2', date: '2026-09-12' })
    ];
    const scores = [S(1, 0, 8), S(2, 0, 4), S(1, 1, 6), S(2, 1, 6), S(3, 0, 3, { stage: 3 }), S(4, 0, 5, { stage: 5 })];
    const assigns = [{ id: 101, subject: '国語', name: '一学期の宿題', date: '2026-05-11', term: '1', createdAt: '2026-05-01T00:00:00Z' }, { id: 102, subject: '国語', name: '二学期の宿題', date: '2026-09-11', term: '2', createdAt: '2026-09-01T00:00:00Z' }];
    // 机間巡視(甲): 1学期=○1件・2学期=△1件
    const patrol = [{ id: 1, subject: '国語', studentIndex: 0, date: '2026-05-12', evals: { '発言': '○' } }, { id: 2, subject: '国語', studentIndex: 0, date: '2026-09-12', evals: { '発言': '△' } }];
    const subs = [{ id: 1, studentIndex: 0, assignmentId: 101, status: 'submitted', correctionDone: true, createdAt: '2026-05-12T00:00:00Z' }];

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores, assigns, subs, patrol });

        // ============ 0. 成績画面の値(変えない): 国語の観点別・評定・提出物 ============
        const gradeSnap = () => page.evaluate(() => ['1', '2', 'all'].map(t => JSON.stringify(grdCalculate('国語', t).map(r => [r.knowledge.avg, r.knowledge.abc, r.attitude.avg, r.attitude.abc, r.hyoutei]))));
        const G0 = await gradeSnap();
        const GRADES = ['[[8,"A",10,"A",3],[6,"B",0,"C",""]]', '[[4,"C",0,"C",1],[6,"B",0,"C",""]]', '[[6,"B",5,"B",2],[6,"B",0,"C",""]]'];
        check('成績画面: 国語の観点別・評定・提出物が、1学期・2学期・通年とも変更前と完全に同じ', JSON.stringify(G0) === JSON.stringify(GRADES), JSON.stringify(G0));

        // ============ 1. 面談用レーダーPDF: 学期は出力画面(kvTermSel)から。成績処理画面の学期は別にして、引きずられないことを確認 ============
        //   1学期: 甲の国語 知=A(8点)・テスト平均80点・提出率100%・なわとびの行1件
        await setGradeTerm('2');
        await setOutputTerm('1');
        const r1 = await pdfRun(clickRadar);
        check('レーダーPDF(出力画面=1学期): 本番のボタンから結果ダイアログまで到達し、コンソールエラー0件', r1.ok && consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 2)));
        check('レーダーPDF(出力画面=1学期): 1ページ目の表(観点別)は1学期の値(知A)。成績処理画面が2学期でも引きずられない', rowOf(r1.html[0]) === 'A,A,A,3', rowOf(r1.html[0]));
        check('レーダーPDF(出力画面=1学期): 教科カードのテスト平均は80点・提出率は100%(1/1)・検定の行は1学期の1件だけ', avgOf(r1.text[1]) === '80' && /提出率 100%\(1\/1\)/.test(r1.text[1]) && (r1.text[1].match(/なわとび：/g) || []).length === 1, avgOf(r1.text[1]) + ' / ' + (r1.text[1].match(/提出率[^ ]*/) || [''])[0]);
        check('レーダーPDF(出力画面=1学期): 1ページ目の「提出物・学習に臨む姿勢」の提出率(100%)・机間巡視(○1／△0)も1学期', /提出物：提出率 100%/.test(r1.text[0]) && /学習に臨む姿勢：○1／△0（○率 100%）/.test(r1.text[0]), (r1.text[0].match(/学習に臨む姿勢：[^ ]*/) || [''])[0]);
        check('レーダーPDF(1学期): 1ページ目にも2ページ目にも「対象学期：1学期」が印字される', /対象学期：1学期/.test(r1.text[0]) && /対象学期：1学期/.test(r1.text[1]), '');

        // ============ 2. 出力画面=2学期 ============
        await setGradeTerm('1');
        await setOutputTerm('2');
        const r2 = await pdfRun(clickRadar);
        check('レーダーPDF(出力画面=2学期): 表は2学期の値(知C)・カードの平均40点・提出率0%(0/1)・検定の行は2学期の1件・「対象学期：2学期」', rowOf(r2.html[0]) === 'C,C,C,1' && avgOf(r2.text[1]) === '40' && /提出率 0%\(0\/1\)/.test(r2.text[1]) && (r2.text[1].match(/なわとび：/g) || []).length === 1 && /対象学期：2学期/.test(r2.text[0]) && /対象学期：2学期/.test(r2.text[1]) && /学習に臨む姿勢：○0／△1（○率 0%）/.test(r2.text[0]), rowOf(r2.html[0]) + ' / ' + avgOf(r2.text[1]));

        // ============ 3. 出力画面=通年 ============
        const ra = await pdfRun(async () => { showView('karte'); kvSetMode('output'); const s = document.getElementById('kvTermSel'); s.value = 'all'; s.dispatchEvent(new Event('change')); document.getElementById('grdExtRadarPdfBtn').click(); });
        check('レーダーPDF(出力画面=通年): 表は通年の値(知B)・平均60点・提出率50%(1/2)・検定の行は2件・「対象学期：通年」', rowOf(ra.html[0]) === 'B,B,B,2' && avgOf(ra.text[1]) === '60' && /提出率 50%\(1\/2\)/.test(ra.text[1]) && (ra.text[1].match(/なわとび：/g) || []).length === 2 && /対象学期：通年/.test(ra.text[0]) && /対象学期：通年/.test(ra.text[1]) && /学習に臨む姿勢：○1／△1（○率 50%）/.test(ra.text[0]), rowOf(ra.html[0]) + ' / ' + avgOf(ra.text[1]));
        check('レーダーPDF: 漢字は学期に関係なく累計であることが、2ページ目の注記に書かれる', /漢字は学期に関係なく、これまでの累計/.test(ra.text[1]), '');

        // ============ 4. カルテPDF: 児童用は「通年」も印字(以前は学期を絞ったときだけ)・教員用は今までどおり対象期間 ============
        const kv = (design, term) => pdfRun(async (design, term) => {
            showView('karte'); kvSetMode('output');
            const s = document.getElementById('kvTermSel'); s.value = term; s.dispatchEvent(new Event('change'));
            document.getElementById('kvSec_grades').checked = true;
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === '0'); });
            const r = document.querySelector('input[name="kvDesign"][value="' + design + '"]'); if (r) r.checked = true;
            document.getElementById('kvPrintBtn').click();
        }, design, term);
        const kc1 = await kv('child', '1'), kca = await kv('child', 'all');
        check('カルテPDF(児童用): 1学期のとき「１学期のきろくです」・通年のとき「通年」が表紙に印字される(以前は通年のとき何も出なかった)', /１学期のきろくです/.test(kc1.text[0]) && /通年（１年間）のきろくです/.test(kca.text[0]), (kc1.text[0] || '').slice(0, 60) + ' | ' + (kca.text[0] || '').slice(0, 60));
        const kt1 = await kv('teacher', '2'), kta = await kv('teacher', 'all');
        check('カルテPDF(教員用): 対象期間が印字される(２学期・通年)', /対象期間：２学期/.test(kt1.text[0]) && /対象期間：通年/.test(kta.text[0]), '');

        // ============ 5. 面談用テキスト: 対象学期の行 ============
        const conf = async (term) => { await setOutputTerm(term); await page.evaluate(() => { window.__clip = null; document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === '0'); }); document.getElementById('kvCopyTextBtn').click(); }); await sleep(250); return page.evaluate(() => window.__clip || ''); };
        const c1 = await conf('1'), ca = await conf('all');
        check('面談用テキスト: 「対象学期：1学期」「対象学期：通年」の行が入る', /対象学期：1学期/.test(c1) && /対象学期：通年/.test(ca), (c1.split('\n').find(l => /対象学期/.test(l)) || '(なし)') + ' | ' + (ca.split('\n').find(l => /対象学期/.test(l)) || '(なし)'));

        // ============ 6. 成績処理画面のボタン: 学期は成績処理画面(grdTermSel)から。算出根拠Excel・成績CSVに学期を印字 ============
        await setOutputTerm('2');   // 出力画面は別の学期にしておく: 成績処理画面のボタンは引きずられない
        await setGradeTerm('1');
        await page.evaluate(() => { window.__wb = null; window.__shared = null; document.getElementById('grdGradeSubj').value = '国語'; document.getElementById('grdExcelBtn').click(); });
        await sleep(500);
        const basis = await page.evaluate(() => ({ name: window.__shared, s1: window.__wb && window.__wb.sheets['評定一覧'] ? window.__wb.sheets['評定一覧'].__aoa.slice(0, 3).map(r => r.join('|')) : null, s4: window.__wb && window.__wb.sheets['根拠_主体性'] ? window.__wb.sheets['根拠_主体性'].__aoa.slice(-3).map(r => r.join('|')) : null }));
        check('算出根拠Excel(成績処理=1学期): ファイル名に「1学期」・「評定一覧」の表題に対象学期が入る(出力画面が2学期でも引きずられない)', /国語_成績根拠_1学期_/.test(basis.name || '') && basis.s1 && /1学期/.test(basis.s1[0]), JSON.stringify(basis.name) + ' ' + JSON.stringify(basis.s1 && basis.s1[0]));
        check('算出根拠Excel: 根拠シートの末尾にも「【対象学期】1学期」が入る', basis.s4 && basis.s4.some(r => /【対象学期】\|1学期/.test(r)), JSON.stringify(basis.s4));
        const csv = await page.evaluate(async () => { window.__shared = null; window.__csv = null; document.getElementById('grdCSVBtn').click(); await new Promise(r => setTimeout(r, 400)); return { name: window.__shared, head: (window.__csv || '').replace(/^﻿/, '').split('\n')[0] }; });
        check('成績CSV(成績処理=1学期): ファイル名に「1学期」が入る。列は今までどおり', /国語_成績_1学期_/.test(csv.name || '') && /^No\.,氏名,評定,合計/.test(csv.head), JSON.stringify(csv.name));
        const tpl = await page.evaluate(async () => { window.__wb = null; document.getElementById('grdTemplateBtn').click(); await new Promise(r => setTimeout(r, 500)); return window.__wb && window.__wb.sheets['国語'] ? window.__wb.sheets['国語'].A1.v : null; });
        check('同僚用テンプレート(成績処理=1学期): 題名は「（1学期）」(出力画面の学期に引きずられない)', tpl === '国語　成績計算（同僚用）（1学期）', String(tpl));

        // ============ 7. 成績画面の値は、出力の前後で変わっていない ============
        const G1 = await gradeSnap();
        check('成績画面: 観点別・評定は、これらの出力を作った後も完全に同じ', JSON.stringify(G1) === JSON.stringify(GRADES), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== output-term-source: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
