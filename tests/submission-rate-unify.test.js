// M2(v1.60.0): 提出率の数え方を、成績の数え方(grdSubmissionJudge → grdSubmissionCredit)に全画面で揃える。
//   お直し済みの再提出=1.0／お直し前の再提出=0.8／期限に遅れて提出=上限0.8／未提出=0。
//   提出率 = 評価点の合計 ÷ 対象件数。期限日に欠席かつ未提出は分母から除外(M6)・後日提出は「提出」扱いで遅れ係数を掛けない(M6)・
//   遅れ係数は提出物チェックの提出記録だけ(M8)。これらの既存方針は変えない。成績画面の値は変えない。
//   対象: 個人カルテ画面・カルテPDF(児童用/教員用)・提出物の一括PDF・面談用テキスト・ダッシュボード(児童別/クラス)。
//   以前は「(提出+再提出)÷課題数」(お直し済み・遅れを見ない)や「(提出+再提出×0.8)÷対象」(お直し済み・遅れを見ない)で、画面ごとに値が違った。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node submission-rate-unify.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
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
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
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
            put(K.assigns, d.assigns || []);
            put(K.subs, d.subs || []);
            put(K.att, d.att || {});
            put(K.weights, {});
            StorageManager.remove(K.thresholds);
            StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
    }
    async function installCaptures() {
        await page.evaluate(() => {
            window.__pdfPages = null; window.__clip = null;
            window.htmlPagesToPdf = function(pages) { window.__pdfPages = pages; return Promise.resolve(); };
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
        });
    }

    // ---- 題材: 国語の宿題6件(1学期・5月)。甲乙丙丁の4人 ----
    //   甲: 提出(1.0) / 再提出お直し前(0.8) / 再提出お直し済み(1.0) / 遅れて提出(0.8) / 未提出(0) / 宿題6は期限日に欠席で未提出(対象外)
    //       → 評価点 3.6 ÷ 対象5 = 72%      (以前の「(提出+再提出)÷対象」=(2+2)÷5=80%)
    //   乙: 宿題1・2を遅れて提出(0.8×2)・残り4件は期限内に提出 → 5.6÷6 = 93%  (以前=100%)
    //   丙: すべて未提出 → 0÷6 = 0%
    //   丁: 宿題6は期限日に欠席だが後日提出(遅れの印つき。遅れ係数は掛けず1.0)・残り5件は提出 → 6÷6 = 100%
    //   クラス: (3.6+5.6+0+6) ÷ (5+6+6+6=23) = 66%  (以前の「(提出+再提出×0.8)÷対象」=(14+1.6)÷23=68%)
    const A = (id, d) => ({ id, subject: '国語', name: '宿題' + (id - 100), date: d, term: '1', createdAt: '2026-05-01T00:00:00Z' });
    const assigns = [A(101, '2026-05-11'), A(102, '2026-05-12'), A(103, '2026-05-13'), A(104, '2026-05-14'), A(105, '2026-05-15'), A(106, '2026-05-18')];
    let rid = 0;
    const R = (i, a, status, extra) => Object.assign({ id: ++rid, studentIndex: i, assignmentId: a, status: status, correctionDone: status === 'submitted', createdAt: '2026-05-20T00:00:00Z' }, extra || {});
    const subs = [
        R(0, 101, 'submitted'), R(0, 102, 'resubmit', { correctionDone: false }), R(0, 103, 'resubmit', { correctionDone: true }), R(0, 104, 'submitted', { lateOnDue: true }),
        R(1, 101, 'submitted', { lateOnDue: true }), R(1, 102, 'submitted', { lateOnDue: true }), R(1, 103, 'submitted'), R(1, 104, 'submitted'), R(1, 105, 'submitted'), R(1, 106, 'submitted'),
        R(3, 101, 'submitted'), R(3, 102, 'submitted'), R(3, 103, 'submitted'), R(3, 104, 'submitted'), R(3, 105, 'submitted'), R(3, 106, 'submitted', { lateOnDue: true })
    ];
    const att = { '2026-05-18': { '0': '×', '3': '×' } };
    const names = ['甲', '乙', '丙', '丁'];
    const EXPECT = [72, 93, 0, 100];
    const EXPECT_CLASS = 66;
    const asPct = (arr) => arr.map(x => x + '%').join(',');

    try {
        await seed({ students: names.map(n => ({ name: n })), assigns, subs, att });
        await installCaptures();

        // ============ 0. 成績画面の値(変えない): 提出物の10点換算・観点別・評定 ============
        //   成績の数え方が基準。値は変更前のコードで確認した値(72%→7.2 / 93%→9.3 / 0 / 100%→10)。
        const grade = await page.evaluate(() => {
            const res = grdCalculate('国語', '1');
            const sub = res.map(r => { const it = r.attitude.items.find(x => x.itemKey === 'submission'); return it ? { s10: it.score10, detail: it.detail } : null; });
            const snap = res.map(r => [r.knowledge.abc, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum]);
            return { sub, snap: JSON.stringify(snap) };
        });
        check('成績画面: 提出物の10点換算は 甲7.2・乙9.3・丙0・丁10(評価点3.6/5・5.6/6・0/6・6/6)', JSON.stringify(grade.sub.map(x => x.s10)) === '[7.2,9.3,0,10]', JSON.stringify(grade.sub));
        // v1.61.0: 提出物の説明文は評価点ベース。以前は「3/5件（72%）」(評価点の合計3.6を切り捨てて表示)で、72%と合わないように見えた
        check('成績画面: 提出物の説明文は評価点ベース(評価点 3.6/5（72%）など)。評価点の合計を切り捨てない', JSON.stringify(grade.sub.map(x => x.detail)) === '["評価点 3.6/5（72%）","評価点 5.6/6（93%）","評価点 0/6（0%）","評価点 6/6（100%）"]', JSON.stringify(grade.sub.map(x => x.detail)));
        check('成績画面: 提出物の説明文の「評価点÷分母」の割合が、その横の%と一致する(以前は3/5=60%なのに72%と出ていた)', grade.sub.every(x => { const m = /^評価点 ([\d.]+)\/(\d+)（(\d+)%）$/.exec(x.detail); return m && Math.round(Number(m[1]) / Number(m[2]) * 100) === Number(m[3]); }), '');
        const GRADE_SNAP = '[["","",7.2,"B","",null],["","",9.3,"A","",null],["","",0,"C","",null],["","",10,"A","",null]]';
        check('成績画面: 観点別の平均・ABC・評定が変更前と完全に同じ', grade.snap === GRADE_SNAP, grade.snap);

        // ============ 1. 個人カルテ画面(概要のカード) ============
        const karte = [];
        for (let i = 0; i < 4; i++) {
            karte.push(await page.evaluate((i) => {
                showView('karte'); kvSetMode('view');
                const t = document.getElementById('karteTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
                selectKarteStudent(i);
                const c = document.getElementById('karteSummaryContent');
                return (c.querySelector('.ks-card.submission .ks-card-value') || {}).textContent;
            }, i));
        }
        check('個人カルテ画面: 提出率 甲72・乙93・丙0・丁100%(成績の数え方)', karte.join() === asPct(EXPECT), karte.join());

        // ============ 2. カルテPDF(児童用・教員用) ============
        const pdf = async (design, idx) => page.evaluate((design, idx) => {
            window.__pdfPages = null;
            showView('karte'); kvSetMode('output');
            const sel = document.getElementById('kvTermSel'); sel.value = 'all'; sel.dispatchEvent(new Event('change'));
            document.getElementById('kvSec_grades').checked = false;
            document.querySelectorAll('.kv-subj-chk').forEach(c => { c.checked = (c.value === '国語'); });
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(idx)); });
            const r = document.querySelector('input[name="kvDesign"][value="' + design + '"]'); if (r) r.checked = true;
            document.getElementById('kvPrintBtn').click();
            return (window.__pdfPages || [])[0] || '';
        }, design, idx);
        const rateOfChild = (html) => { const m = /提出率<\/div><div[^>]*>(\d+%|-)</.exec(html); return m ? m[1] : '?'; };
        const rateOfTeacher = (html) => { const m = /提出物（提出率 (\d+%|-)）/.exec(html); return m ? m[1] : '?'; };
        const pdfChild = [], pdfTeacher = [];
        for (let i = 0; i < 4; i++) { pdfChild.push(rateOfChild(await pdf('child', i))); pdfTeacher.push(rateOfTeacher(await pdf('teacher', i))); }
        check('カルテPDF(児童用): 提出率 甲72・乙93・丙0・丁100%', pdfChild.join() === asPct(EXPECT), pdfChild.join());
        check('カルテPDF(教員用): 提出物の見出しの提出率 甲72・乙93・丙0・丁100%', pdfTeacher.join() === asPct(EXPECT), pdfTeacher.join());
        const pdfHtml = await pdf('child', 0);
        check('カルテPDF: 課題数・提出済・再提出の件数の表示は今までどおり(課題数6件・提出済2件・再提出2件)', /課題数<\/div><div[^>]*>6<span/.test(pdfHtml) && /提出済<\/div><div[^>]*>2<span/.test(pdfHtml) && /再提出<\/div><div[^>]*>2<span/.test(pdfHtml), '');

        // ============ 3. 提出物チェックの一括PDF(提出物モード) ============
        const bulk = await page.evaluate(() => {
            window.__pdfPages = null;
            showView('submissions');
            const t = document.getElementById('subTermSel'); if (t) { t.value = 'all'; t.dispatchEvent(new Event('change')); }
            printAllKarte('submissions');
            return (window.__pdfPages || []).map(h => { const m = /提出率<\/div><div[^>]*>(\d+%|-)</.exec(h); return m ? m[1] : '?'; });
        });
        check('提出物の一括PDF: 提出率 甲72・乙93・丙0・丁100%', bulk.join() === asPct(EXPECT), bulk.join());

        // 一括PDFの全項目モード(画面のボタンからは呼ばれない旧経路。同じ計算に揃えてある)
        const bulkAll = await page.evaluate(() => {
            window.__pdfPages = null;
            printAllKarte();
            return (window.__pdfPages || []).map(h => { const m = /提出率<\/td><td[^>]*>(\d+%|-)</.exec(h); return m ? m[1] : '?'; });
        });
        check('一括PDFの全項目モード(旧経路): 提出率 甲72・乙93・丙0・丁100%(提出物モードと同じ計算)', bulkAll.join() === asPct(EXPECT), bulkAll.join());

        // ============ 4. 面談用テキスト ============
        await page.evaluate(() => {
            window.__clip = null; showView('karte'); kvSetMode('output');
            const sel = document.getElementById('kvTermSel'); sel.value = 'all'; sel.dispatchEvent(new Event('change'));
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = true; });
            document.getElementById('kvCopyTextBtn').click();
        });
        await sleep(150);
        const clip = await page.evaluate(() => window.__clip || '');
        const conf = names.map(n => { const m = new RegExp('氏名：' + n + '[\\s\\S]*?【提出物（(\\d+)%）】').exec(clip); return m ? m[1] + '%' : '?'; });
        check('面談用テキスト: 提出物の提出率 甲72・乙93・丙0・丁100%', conf.join() === asPct(EXPECT), conf.join());
        const confCounts = names.map(n => { const m = new RegExp('氏名：' + n + '[\\s\\S]*?提出済 (\\d+)件／再提出 (\\d+)件／未提出 (\\d+)件').exec(clip); return m ? m.slice(1, 4).join('/') : '?'; });
        check('面談用テキスト: 提出済・再提出・未提出の件数の表示は今までどおり(甲2/2/1・乙6/0/0・丙0/0/6・丁6/0/0)', confCounts.join() === '2/2/1,6/0/0,0/0/6,6/0/0', confCounts.join());

        // ============ 5. ダッシュボード(児童別・クラス) ============
        const dash = await page.evaluate(() => {
            showView('dashboard');
            const cls = (document.getElementById('statSubmission') || {}).textContent;
            const one = [];
            for (let i = 0; i < 4; i++) {
                selectDashStudent(i);
                const row = Array.from(document.querySelectorAll('#dashStudentKarte > .card > div')).find(r => /提出率/.test(r.textContent));
                one.push(row ? (/(\d+)%/.exec(row.textContent) || [])[1] + '%' : '?');
            }
            return { cls, one };
        });
        check('ダッシュボード(児童別): 提出率 甲72・乙93・丙0・丁100%', dash.one.join() === asPct(EXPECT), dash.one.join());
        check('ダッシュボード(クラス): 提出率 66%(評価点15.2÷対象23)', dash.cls === EXPECT_CLASS + '%', dash.cls);

        // ============ 6. すでに成績の数え方の画面(提出物統計)とも、クラス・児童別が一致する ============
        const stats = await page.evaluate(() => {
            showView('submissions');
            const t = document.getElementById('subTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
            document.querySelector('.sub-subnav-btn[data-sub="stats"]').click();
            const rows = Array.from(document.querySelectorAll('#subStudentStats .sub-student-row')).map(r => { const b = r.querySelector('.sub-stu-badges'); const p = b && b.querySelector('span:last-child'); return p ? parseInt(p.textContent, 10) + '%' : '?'; });
            const cards = {};
            document.querySelectorAll('#subStatsCards .sub-stat-card').forEach(c => { cards[(c.querySelector('.sub-stat-label') || {}).textContent] = (c.querySelector('.sub-stat-val') || {}).textContent; });
            return { rows, cls: cards['提出率'] };
        });
        check('提出物統計(元から成績の数え方): 児童別・クラスが、ダッシュボード・カルテと同じ数字(72/93/0/100・66%)', stats.rows.join() === asPct(EXPECT) && stats.cls === EXPECT_CLASS + '%', stats.rows.join() + ' / ' + stats.cls);

        // ============ 7. PDF個票の計算関数(calcSubmissionStats)は、成績の提出評価と同じ ============
        const calc = await page.evaluate((assigns, subs) => [0, 1, 2, 3].map(i => calcSubmissionStats(i, assigns, subs)), assigns, subs);
        check('カルテの提出状況の計算: 対象(分母)は 甲5・乙6・丙6・丁6(期限日欠席の未提出は対象外)、件数は今までどおり', JSON.stringify(calc.map(c => [c.counted, c.excused, c.ok, c.re, c.miss])) === '[[5,1,2,2,1],[6,0,6,0,0],[6,0,0,0,6],[6,0,6,0,0]]', JSON.stringify(calc.map(c => [c.counted, c.excused, c.ok, c.re, c.miss])));
        // 成績の提出評価の関数と同じ規則(お直し済み1.0・お直し前0.8・遅れ上限0.8・期限日欠席の後日提出は遅れなし)
        const cr = await page.evaluate(() => [grdSubmissionCredit({ status: 'resubmit', correctionDone: true }), grdSubmissionCredit({ status: 'resubmit', correctionDone: false }), grdSubmissionCredit({ status: 'submitted', lateOnDue: true }), grdSubmissionCredit({ status: 'resubmit', correctionDone: true, lateOnDue: true }), grdSubmissionCredit(null)]);
        check('成績の提出評価の規則(基準): お直し済み1.0・お直し前0.8・遅れ0.8・お直し済みでも遅れなら0.8・未提出0', JSON.stringify(cr) === '[1,0.8,0.8,0.8,0]', JSON.stringify(cr));

        // ============ 8. 課題が1件も対象にならない児童は「-」(0%にしない) ============
        //   全課題が期限日に欠席・未提出 = 対象0件
        const A2 = [A(201, '2026-05-11')];
        await seed({ students: [{ name: '甲' }, { name: '乙' }], assigns: A2, subs: [R(1, 201, 'submitted')], att: { '2026-05-11': { '0': '×' } } });
        await installCaptures();
        const none = await page.evaluate(() => {
            showView('karte'); kvSetMode('view');
            const t = document.getElementById('karteTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
            selectKarteStudent(0);
            const k = (document.querySelector('#karteSummaryContent .ks-card.submission .ks-card-value') || {}).textContent;
            showView('dashboard'); selectDashStudent(0);
            const row = Array.from(document.querySelectorAll('#dashStudentKarte > .card > div')).find(r => /提出率/.test(r.textContent));
            return { karte: k, dash: row ? row.textContent.replace(/\s+/g, ' ').trim() : '?', calc: calcSubmissionStats(0, [{ id: 201, subject: '国語', name: 'x', date: '2026-05-11' }], [], ).rate };
        });
        check('対象が0件(期限日に欠席で未提出だけ)の児童: カルテ画面は「-」・ダッシュボードは「—」・PDFの計算は「-」(0%にしない)', none.karte === '-' && /提出率\s*—/.test(none.dash) && none.calc === '-', JSON.stringify(none));

        // ============ 9. 読み取り専用: 出力・表示で提出記録・課題・出席簿を書き換えない ============
        await seed({ students: names.map(n => ({ name: n })), assigns, subs, att });
        await installCaptures();
        const before = await page.evaluate((K) => [StorageManager.getRaw(K.subs), StorageManager.getRaw(K.assigns), StorageManager.getRaw(K.att)], KN);
        await page.evaluate(() => { showView('karte'); kvSetMode('output'); document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = true; }); document.getElementById('kvCopyTextBtn').click(); showView('dashboard'); });
        await sleep(150);
        const after = await page.evaluate((K) => [StorageManager.getRaw(K.subs), StorageManager.getRaw(K.assigns), StorageManager.getRaw(K.att)], KN);
        check('面談テキストの生成・ダッシュボードの表示で、提出記録・課題・出席簿は1バイトも変わらない', JSON.stringify(before) === JSON.stringify(after), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== submission-rate-unify: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
