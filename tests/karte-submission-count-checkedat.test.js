// v1.64.0: 提出率を「件数ベース」に／提出物チェックのチェック日時(checkedAt)をカルテに表示する。
//   【1】提出率 = 提出した件数 ÷ 対象件数(全画面: カルテ画面・カルテPDF 児童用/教員用・一括PDF・面談テキスト・ダッシュボード・提出物統計)。
//        遅れて提出・お直し前の再提出も1件(先生の方針)。分母は v1.50.0 のまま(期限日に欠席かつ未提出は除外・後日提出は提出扱い)。
//        0.8倍(お直し前・遅れ上限)は成績の評価点だけ(成績処理・提出物統計の「評価点（10点換算）」は変えない)。
//        遅れて提出の課題には、カルテの課題ごとの記録とPDFの課題一覧に小さく「遅れて提出」。
//   【2】○提出/△再提出を付けた時刻を checkedAt(ISO)に保存する。同じ状態のまま保存し直しても時刻は変わらない・
//        状態が変わったら今の時刻・チェックを外したら消える。過去の記録(checkedAt なし)に時刻を作らない(表示は「―」)。
//        バックアップの書き出し・復元で保持される。
//   【3】v1.64.1(先生の要望の訂正): カルテ・PDFの各課題に出す日付は「課題の日」(assignment.date の M/D。date なしは「―」)。
//        遅れて提出で checkedAt があるときだけ、後ろに小さく「→M/D提出」(checkedAt の日付)。checkedAt が無ければ添えない。PDFの列見出しは「課題の日」。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node karte-submission-count-checkedat.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 表示の期待値(端末の時刻で M/D HH:mm)。Chrome と node は同じ端末の時刻帯で動く
const md = (iso) => { const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate(); }; // checkedAt の日付(端末の時刻)
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

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
            put(K.tests, []); put(K.scores, []);
            put(K.assigns, d.assigns); put(K.subs, d.subs); put(K.att, d.att || {});
            put(K.weights, {});
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        await page.evaluate(() => { window.__pdfPages = null; window.htmlPagesToPdf = function(pages) { window.__pdfPages = pages; return Promise.resolve(); }; try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {} });
    }
    const getSubs = () => page.evaluate((k) => JSON.parse(StorageManager.getRaw(k) || '[]'), KN.subs);
    const recOf = (subs, i, a) => subs.find(r => r.studentIndex === i && r.assignmentId === a) || null;

    // ---- 題材: 国語の宿題4件(1学期・5月)。甲乙丙の3人 ----
    //   甲: 4件すべて提出。うち宿題2・宿題4は「遅れて提出」、宿題3はお直し済みの再提出
    //       → カルテ 4/4=100%  (成績の評価点は 1+0.8+1+0.8=3.6/4=90% のまま)
    //       課題の日: 5/11〜5/14。checkedAt は宿題1・宿題2だけ(宿題3・宿題4は過去の記録)→ 遅れて提出の宿題2だけ「→M/D提出」が付く・宿題4(遅れ・checkedAt なし)には付かない
    //   乙: 宿題1=お直し前の再提出・宿題2=未提出・宿題3=期限日欠席で未提出(対象外)・宿題4=期限日欠席の後日提出(遅れの印があっても遅れにしない)
    //       → カルテ 2/3=67%   (成績 0.8+0+1=1.8/3=60% のまま)
    //   丙: 記録なし → 0%
    const A = (id, d) => ({ id, subject: '国語', name: '宿題' + (id - 100), date: d, term: '1', createdAt: '2026-05-01T00:00:00Z' });
    const assigns = [A(101, '2026-05-11'), A(102, '2026-05-12'), A(103, '2026-05-13'), A(104, '2026-05-14')];
    const C1 = '2026-05-11T00:05:00.000Z', C2 = '2026-05-13T07:42:00.000Z', CB = '2026-05-11T03:09:00.000Z';
    let rid = 0;
    const R = (i, a, status, extra) => Object.assign({ id: ++rid, studentIndex: i, assignmentId: a, status: status, correctionDone: status === 'submitted', createdAt: '2026-05-20T00:00:00Z' }, extra || {});
    const subs = [
        R(0, 101, 'submitted', { checkedAt: C1 }), R(0, 102, 'submitted', { lateOnDue: true, checkedAt: C2 }), R(0, 103, 'resubmit', { correctionDone: true }), R(0, 104, 'submitted', { lateOnDue: true }),
        R(1, 101, 'resubmit', { correctionDone: false, checkedAt: CB }), R(1, 104, 'submitted', { lateOnDue: true })
    ];
    const att = { '2026-05-13': { '1': '×' }, '2026-05-14': { '1': '×' } };
    const names = ['甲', '乙', '丙'];
    const students = names.map((n, i) => ({ name: n, studentId: 'stu_0000000' + (i + 1) }));

    try {
        await seed({ students, assigns, subs, att });

        // ============ 0. 成績(変えない) ============
        //   値は変更前のコードで確認した値。提出物の10点換算 甲9・乙6・丙0
        const grade = await page.evaluate(() => {
            const res = grdCalculate('国語', '1');
            const sub = res.map(r => { const it = r.attitude.items.find(x => x.itemKey === 'submission'); return it ? [it.score10, it.detail] : null; });
            const snap = res.map(r => [r.knowledge.abc, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum]);
            return { sub: JSON.stringify(sub), snap: JSON.stringify(snap) };
        });
        check('成績: 提出物の10点換算・説明文は従来どおり(甲 評価点3.6/4=9・乙 1.8/3=6・丙 0/4=0)', grade.sub === '[[9,"評価点 3.6/4（90%）"],[6,"評価点 1.8/3（60%）"],[0,"評価点 0/4（0%）"]]', grade.sub);
        check('成績: 観点別の平均・ABC・評定が従来どおり', grade.snap === '[["","",9,"A","",null],["","",6,"B","",null],["","",0,"C","",null]]', grade.snap);

        // ============ 1. カルテ画面の提出率(件数ベース) ============
        const karteView = (i) => page.evaluate((i) => {
            showView('karte'); kvSetMode('view');
            const t = document.getElementById('karteTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
            selectKarteStudent(i);
            const c = document.getElementById('karteSummaryContent');
            const rows = Array.from(c.querySelectorAll('.ks-sub-all .ks-missing-row')).map(r => ({
                name: (r.querySelector('.ks-missing-name') || {}).textContent,
                late: !!r.querySelector('.ks-late-tag') ? r.querySelector('.ks-late-tag').textContent : '',
                chk: (r.querySelector('.ks-sub-date') || {}).textContent,
                lateAt: (r.querySelector('.ks-sub-late-at') || {}).textContent || '',
                status: (r.querySelector('.ks-missing-status') || {}).textContent
            }));
            // 未提出・遅れの一覧(折りたたみの外)
            const lists = Array.from(c.querySelectorAll('.ks-hub-section[data-ks="submissions"] .ks-missing-row')).filter(r => !r.closest('.ks-sub-all')).map(r => (r.querySelector('.ks-missing-name') || {}).textContent + ':' + (r.querySelector('.ks-sub-date') || {}).textContent + ':' + (r.querySelector('.ks-missing-status') || {}).textContent);
            const summary = (c.querySelector('.ks-sub-all > summary') || {}).textContent || '';
            return { rate: (c.querySelector('.ks-card.submission .ks-card-value') || {}).textContent, rows, lists, summary, hasList: !!c.querySelector('.ks-sub-all') };
        }, i);
        const kv = [];
        for (let i = 0; i < 3; i++) kv.push(await karteView(i));
        check('カルテ画面: 提出率は件数ベース 甲100%(全提出・うち遅れ2件)・乙67%(2/3)・丙0%', kv.map(k => k.rate).join() === '100%,67%,0%', kv.map(k => k.rate).join());

        // ============ 2. カルテ画面の課題ごとの記録(遅れて提出・課題の日) ============
        check('カルテ画面: 「課題ごとの記録」があり、対象学期の4課題が並ぶ', kv[0].hasList && kv[0].rows.map(r => r.name).join() === '宿題1,宿題2,宿題3,宿題4', JSON.stringify(kv[0].rows.map(r => r.name)));
        check('カルテ画面(甲): 「遅れて提出」は宿題2・宿題4だけ', kv[0].rows.map(r => r.late).join('|') === '|遅れて提出||遅れて提出', JSON.stringify(kv[0].rows.map(r => r.late)));
        check('カルテ画面(乙): 期限日欠席の後日提出(宿題4)には「遅れて提出」を付けない', kv[1].rows.every(r => !r.late), JSON.stringify(kv[1].rows));
        check('カルテ画面(甲): 各課題に課題の日(M/D)。遅れて提出＋checkedAt ありの宿題2だけ「→M/D提出」(checkedAt の日)', kv[0].rows.map(r => r.chk).join('|') === ['5/11', '5/12→' + md(C2) + '提出', '5/13', '5/14'].join('|'), JSON.stringify(kv[0].rows.map(r => r.chk)));
        check('カルテ画面(甲): 遅れて提出でも checkedAt の無い宿題4には「→M/D提出」を付けない・遅れていない宿題1(checkedAt あり)にも付けない', kv[0].rows.map(r => r.lateAt).join('|') === ['', '→' + md(C2) + '提出', '', ''].join('|'), JSON.stringify(kv[0].rows.map(r => r.lateAt)));
        check('カルテ画面(乙): 再提出・未提出・欠席（対象外）・後日提出もすべて課題の日(5/11〜5/14)・「→提出」なし', kv[1].rows.map(r => r.chk + ':' + r.status).join('|') === ['5/11:再提出', '5/12:未提出', '5/13:欠席（対象外）', '5/14:提出済'].join('|'), JSON.stringify(kv[1].rows));
        check('カルテ画面: 見出しは「課題の日つき」(チェック日時の表記は無い)', /課題の日つき/.test(kv[0].summary) && !/チェック日時/.test(kv[0].summary), kv[0].summary);
        check('カルテ画面(甲): 遅れの一覧にも課題の日(宿題2は「→M/D提出」つき・宿題4は日付だけ)', JSON.stringify(kv[0].lists) === JSON.stringify(['宿題3:5/13:再提出', '宿題2:5/12→' + md(C2) + '提出:提出遅れ', '宿題4:5/14:提出遅れ']), JSON.stringify(kv[0].lists));
        check('カルテ画面(乙): 未提出の一覧にも課題の日', JSON.stringify(kv[1].lists) === JSON.stringify(['宿題1:5/11:再提出', '宿題2:5/12:未提出']), JSON.stringify(kv[1].lists));
        check('カルテ画面(丙): 記録が無くても、各課題に課題の日(5/11〜5/14)が出る', kv[2].rows.map(r => r.chk).join('|') === '5/11|5/12|5/13|5/14', JSON.stringify(kv[2].rows));

        // ============ 3. カルテPDF(児童用・教員用)・一括PDF ============
        const pdf = (design, idx) => page.evaluate((design, idx) => {
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
        const rateOf = (html) => { const m = /提出率<\/div><div[^>]*>(\d+%|-)</.exec(html); return m ? m[1] : '?'; };
        const rowsOf = (html) => page.evaluate((html) => {
            const d = document.createElement('div'); d.innerHTML = html;
            const tb = Array.from(d.querySelectorAll('table')).find(t => /課題名/.test(t.textContent));
            if (!tb) return null;
            return Array.from(tb.querySelectorAll('tr')).slice(1).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()));
        }, html);
        const child = [], teacher = [];
        for (let i = 0; i < 3; i++) { child.push(await pdf('child', i)); teacher.push(await pdf('teacher', i)); }
        check('カルテPDF(児童用): 提出率 甲100%・乙67%・丙0%', child.map(rateOf).join() === '100%,67%,0%', child.map(rateOf).join());
        check('カルテPDF(教員用): 提出率 甲100%・乙67%・丙0%(見出しも)', teacher.map(rateOf).join() === '100%,67%,0%' && teacher.map(h => (/提出物（提出率 (\d+%)）/.exec(h) || [])[1]).join() === '100%,67%,0%', teacher.map(rateOf).join());
        const cRows = await rowsOf(child[0]);
        check('カルテPDF(児童用・甲): 列見出しは「課題の日」(「チェック日時」は無い)・各課題に M/D・宿題2だけ「→M/D提出」', /課題の日/.test(child[0]) && !/チェック日時/.test(child[0]) && cRows && cRows.map(r => r[3]).join('|') === ['5/11', '5/12→' + md(C2) + '提出', '5/13', '5/14'].join('|'), JSON.stringify(cRows));
        check('カルテPDF(児童用・甲): 状況の欄に「遅れて提出」は宿題2・宿題4だけ', cRows && cRows.map(r => /遅れて提出/.test(r[2]) ? 1 : 0).join('') === '0101', JSON.stringify(cRows && cRows.map(r => r[2])));
        const bRows = await rowsOf(child[1]);
        check('カルテPDF(児童用・乙): 期限日欠席の後日提出に「遅れて提出」を付けない・全課題に課題の日・「→提出」なし', bRows && !bRows.some(r => /遅れて提出/.test(r[2])) && bRows.map(r => r[3]).join('|') === '5/11|5/12|5/13|5/14', JSON.stringify(bRows));
        const tRows = await rowsOf(teacher[0]);
        check('カルテPDF(教員用・甲): 同じ課題一覧(遅れて提出・課題の日・→M/D提出)', tRows && tRows.map(r => r[3]).join('|') === ['5/11', '5/12→' + md(C2) + '提出', '5/13', '5/14'].join('|') && tRows.map(r => /遅れて提出/.test(r[2]) ? 1 : 0).join('') === '0101', JSON.stringify(tRows));
        const bulk = await page.evaluate(() => {
            window.__pdfPages = null; showView('submissions');
            const t = document.getElementById('subTermSel'); if (t) { t.value = 'all'; t.dispatchEvent(new Event('change')); }
            printAllKarte('submissions');
            return window.__pdfPages || [];
        });
        check('提出物の一括PDF(カルテ): 提出率 甲100%・乙67%・丙0%', bulk.map(rateOf).join() === '100%,67%,0%', bulk.map(rateOf).join());
        const calc = await page.evaluate((assigns, subs) => [0, 1, 2].map(i => { const s = calcSubmissionStats(i, assigns, subs); return [s.counted, s.excused, s.ok, s.re, s.miss, s.rate]; }), assigns, subs);
        check('カルテの計算(calcSubmissionStats): 分母・件数は従来どおり、率だけ件数ベース', JSON.stringify(calc) === '[[4,0,3,1,0,"100%"],[3,1,1,1,1,"67%"],[4,0,0,0,4,"0%"]]', JSON.stringify(calc));

        // ============ 4. カルテ以外の画面も件数ベース(v1.64.0 先生の方針)。評価点は成績・10点換算だけ ============
        const dash = await page.evaluate(() => {
            showView('dashboard');
            const one = [];
            for (let i = 0; i < 3; i++) {
                selectDashStudent(i);
                const row = Array.from(document.querySelectorAll('#dashStudentKarte > .card > div')).find(r => /提出率/.test(r.textContent));
                one.push(row ? (/(\d+)%/.exec(row.textContent) || [])[1] + '%' : '?');
            }
            return one;
        });
        check('ダッシュボード(児童別): 提出率は件数ベース 甲100・乙67・丙0%(v1.64.0 先生の方針: 全画面で件数)', dash.join() === '100%,67%,0%', dash.join());
        await page.evaluate(() => {
            window.__clip = null; showView('karte'); kvSetMode('output');
            const sel = document.getElementById('kvTermSel'); sel.value = 'all'; sel.dispatchEvent(new Event('change'));
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = true; });
            document.getElementById('kvCopyTextBtn').click();
        });
        await sleep(150);
        const clip = await page.evaluate(() => window.__clip || '');
        const conf = names.map(n => { const m = new RegExp('氏名：' + n + '[\\s\\S]*?【提出物（(\\d+)%）】').exec(clip); return m ? m[1] + '%' : '?'; });
        check('面談用テキスト: 提出率は件数ベース 甲100・乙67・丙0%', conf.join() === '100%,67%,0%', conf.join());
        const stats = await page.evaluate(() => {
            showView('submissions');
            const t = document.getElementById('subTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
            document.querySelector('.sub-subnav-btn[data-sub="stats"]').click();
            const rows = Array.from(document.querySelectorAll('#subStudentStats .sub-student-row'));
            return { pct: rows.map(r => { const b = r.querySelector('.sub-stu-badges'); const p = b && b.querySelector('span:last-child'); return p ? parseInt(p.textContent, 10) + '%' : '?'; }), s10: rows.map(r => (r.querySelector('.sub-stu-score') || {}).textContent) };
        });
        check('提出物統計(児童別): 提出率（件数）は 甲100・乙67・丙0%、評価点（10点換算）は成績と同じ 9.0・6.0・0.0 のまま', stats.pct.join() === '100%,67%,0%' && stats.s10.join() === '9.0,6.0,0.0', JSON.stringify(stats));

        // ============ 5. 入力タブ(実際のタップ)で checkedAt を記録する ============
        //   宿題5(期限は先の日付=遅れにならない)。乙には過去の記録(checkedAt なし)を置く
        const A5 = A(105, '2099-12-31');
        await seed({ students, assigns: assigns.concat([A5]), subs: subs.concat([R(1, 105, 'submitted')]), att });
        await page.evaluate(() => {
            showView('submissions');
            document.querySelector('.sub-subnav-btn[data-sub="input"]').click();
            const sel = document.getElementById('subInputAssignSel'); sel.value = '105'; sel.dispatchEvent(new Event('change'));
            document.getElementById('subViewListBtn').click();
        });
        await sleep(200);
        const btn = (i, st) => '#subListWrap .sub-input-row[data-idx="' + i + '"] .sub-status-btn[data-status="' + st + '"]';
        const t0 = new Date().toISOString();
        await page.click(btn(2, 'submitted'));
        await sleep(1100); // 自動保存(800ms)
        const t1 = new Date().toISOString();
        let s1 = await getSubs();
        const c丙1 = (recOf(s1, 2, 105) || {}).checkedAt;
        check('入力タブ: ○をタップすると checkedAt(ISO文字列)をその時刻で記録する', ISO_RE.test(c丙1 || '') && c丙1 >= t0 && c丙1 <= t1, c丙1 + ' in [' + t0 + ', ' + t1 + ']');
        check('入力タブ: 過去の記録(乙・checkedAt なし)は保存し直しても時刻を作らない', recOf(s1, 1, 105) && !('checkedAt' in recOf(s1, 1, 105)), JSON.stringify(recOf(s1, 1, 105)));
        await page.click(btn(0, 'submitted'));
        await sleep(1100);
        let s2 = await getSubs();
        check('入力タブ: ほかの児童のタップで保存し直しても、丙の checkedAt は変わらない', (recOf(s2, 2, 105) || {}).checkedAt === c丙1, (recOf(s2, 2, 105) || {}).checkedAt + ' vs ' + c丙1);
        check('入力タブ: 甲にも新しく checkedAt が付く', ISO_RE.test((recOf(s2, 0, 105) || {}).checkedAt || ''), JSON.stringify(recOf(s2, 0, 105)));
        check('入力タブ: 過去の記録(乙)は2回目の保存でも checkedAt なし', !('checkedAt' in (recOf(s2, 1, 105) || {})), JSON.stringify(recOf(s2, 1, 105)));
        // 同じ状態を押し直す・遅れの印を付け外しする → 変わらない
        await page.click(btn(2, 'submitted'));
        await page.click('#subListWrap .sub-input-row[data-idx="2"] .sub-row-num');
        await sleep(1100);
        let s3 = await getSubs();
        check('入力タブ: 同じ○を押し直す・遅れの印を付けても checkedAt は変わらない', (recOf(s3, 2, 105) || {}).checkedAt === c丙1 && (recOf(s3, 2, 105) || {}).lateOnDue === true, JSON.stringify(recOf(s3, 2, 105)));
        // ○→△ に変える → 新しい時刻
        await page.click(btn(2, 'resubmit'));
        await sleep(1100);
        let s4 = await getSubs();
        const c丙2 = (recOf(s4, 2, 105) || {}).checkedAt;
        check('入力タブ: ○→△に変えると checkedAt はその時刻に更新される', (recOf(s4, 2, 105) || {}).status === 'resubmit' && ISO_RE.test(c丙2 || '') && c丙2 > c丙1, c丙1 + ' → ' + c丙2);
        // お直し完了のチェック → 変わらない
        await page.click('#subListWrap .sub-input-row[data-idx="2"] .sub-correction-check');
        await sleep(1100);
        let s5 = await getSubs();
        check('入力タブ: お直し完了のチェックでは checkedAt は変わらない', (recOf(s5, 2, 105) || {}).correctionDone === true && (recOf(s5, 2, 105) || {}).checkedAt === c丙2, JSON.stringify(recOf(s5, 2, 105)));
        // 番号の長押しでチェックを外す → 記録ごと消える(checkedAt も残らない)
        const nb = await page.$('#subListWrap .sub-input-row[data-idx="2"] .sub-row-num');
        const bx = await nb.boundingBox();
        await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2);
        await page.mouse.down(); await sleep(750); await page.mouse.up();
        await sleep(1100);
        let s6 = await getSubs();
        check('入力タブ: 長押しでチェックを外すと記録が消え、checkedAt も残らない', !recOf(s6, 2, 105), JSON.stringify(recOf(s6, 2, 105)));
        // 欠席だけの記録には付けない
        await page.click('#subListWrap .sub-input-row[data-idx="2"] .sub-absent-btn');
        await sleep(1100);
        let s7 = await getSubs();
        check('入力タブ: 欠席だけの記録(未提出)には checkedAt を付けない', recOf(s7, 2, 105) && recOf(s7, 2, 105).absent === true && !('checkedAt' in recOf(s7, 2, 105)), JSON.stringify(recOf(s7, 2, 105)));
        // 欠席→○(後日提出) は新しい時刻
        await page.click(btn(2, 'submitted'));
        await sleep(1100);
        let s8 = await getSubs();
        check('入力タブ: 欠席のあと○にすると、その時刻の checkedAt が付く', (recOf(s8, 2, 105) || {}).status === 'submitted' && ISO_RE.test((recOf(s8, 2, 105) || {}).checkedAt || ''), JSON.stringify(recOf(s8, 2, 105)));

        // カルテに反映(実際に入力した時刻が出る)
        const kv5 = await karteView(2);
        const row5 = kv5.rows.find(r => r.name === '宿題5');
        check('カルテ画面: 入力タブで○を付けた課題も、出るのは課題の日(12/31)。遅れていないので「→提出」なし', row5 && row5.chk === '12/31' && row5.lateAt === '', JSON.stringify(row5));

        // ============ 6. 入力（個人）タブでも同じ ============
        await page.evaluate(() => {
            showView('submissions');
            const t = document.getElementById('subTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change')); // 題材は1学期(今日は2学期)
            document.querySelector('.sub-subnav-btn[data-sub="person"]').click();
        });
        await page.waitForSelector('#subPsnGrid .sub-psn-stu');
        await page.click('#subPsnGrid .sub-psn-stu[data-idx="2"]');
        await page.waitForSelector('#subPsnDetail .sub-psn-sec');
        const p0 = new Date().toISOString();
        await page.click('#subPsnDetail [data-psnact="re"][data-aid="101"]');
        await sleep(100);
        let p1 = await getSubs();
        const cp1 = (recOf(p1, 2, 101) || {}).checkedAt;
        check('入力（個人）: △再提出で checkedAt を記録する', (recOf(p1, 2, 101) || {}).status === 'resubmit' && ISO_RE.test(cp1 || '') && cp1 >= p0, JSON.stringify(recOf(p1, 2, 101)));
        await sleep(20);
        await page.click('#subPsnDetail [data-psnact="corr"][data-aid="101"]');
        await sleep(100);
        let p2 = await getSubs();
        check('入力（個人）: お直し完了では checkedAt は変わらない', (recOf(p2, 2, 101) || {}).correctionDone === true && (recOf(p2, 2, 101) || {}).checkedAt === cp1, JSON.stringify(recOf(p2, 2, 101)));
        await page.evaluate(() => { const c = document.getElementById('subPsnDoneChk'); if (c && !c.checked) c.click(); });
        await sleep(100);
        await page.click('#subPsnDetail [data-psnact="tgllate"][data-aid="101"]');
        await sleep(100);
        let p3 = await getSubs();
        check('入力（個人）: 遅れの付け外しでは checkedAt は変わらない', (recOf(p3, 2, 101) || {}).checkedAt === cp1, JSON.stringify(recOf(p3, 2, 101)));
        await page.click('#subPsnDetail [data-psnact="clear"][data-aid="101"]');
        await sleep(100);
        let p4 = await getSubs();
        check('入力（個人）: 未提出に戻すと記録が消え、checkedAt も残らない', !recOf(p4, 2, 101), JSON.stringify(recOf(p4, 2, 101)));

        // ============ 7. バックアップの書き出し・復元で checkedAt を保持 ============
        const bk = await page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
        const inBk = JSON.parse(bk.data[KN.subs] || '[]');
        const live = await getSubs();
        check('バックアップの書き出し: 提出記録の checkedAt がそのまま入る', JSON.stringify(inBk.map(r => [r.studentIndex, r.assignmentId, r.checkedAt || null])) === JSON.stringify(live.map(r => [r.studentIndex, r.assignmentId, r.checkedAt || null])) && inBk.some(r => r.checkedAt === C1), '');
        await page.evaluate((k) => { const a = JSON.parse(StorageManager.getRaw(k)); a.forEach(r => { delete r.checkedAt; }); StorageManager.setImmediate(k, JSON.stringify(a)); }, KN.subs);
        const rr = await page.evaluate((b) => { const r = window.brRestoreFromBackup(b); return { ok: r.ok }; }, bk);
        const restored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]'), KN.subs);
        check('バックアップの復元: checkedAt が戻る(書き出したときと同じ)', rr.ok && JSON.stringify(restored.map(r => [r.studentIndex, r.assignmentId, r.checkedAt || null])) === JSON.stringify(live.map(r => [r.studentIndex, r.assignmentId, r.checkedAt || null])), JSON.stringify(rr));
        const integ = await page.evaluate(() => window.spaIntegrityCheck());
        check('復元後の整合性検査: 問題なし(checkedAt は検査の対象外で、警告にならない)', integ.ok === true, JSON.stringify(integ.issues));

        // ============ 8. 課題の日が無い課題は「―」(v1.64.1)。遅れて提出＋checkedAt なら「―→M/D提出」 ============
        const CN = '2026-05-21T02:00:00.000Z';
        const noDate = [{ id: 301, subject: '国語', name: '日付なし1', term: '1' }, { id: 302, subject: '国語', name: '日付なし2', term: '1' }];
        await seed({ students, assigns: noDate, subs: [R(0, 301, 'submitted'), R(0, 302, 'submitted', { lateOnDue: true, checkedAt: CN })] });
        const kn = await karteView(0);
        check('カルテ画面: date の無い課題は「―」・遅れて提出＋checkedAt ありは「―→M/D提出」', kn.rows.map(r => r.chk).join('|') === ['―', '―→' + md(CN) + '提出'].join('|'), JSON.stringify(kn.rows));
        const pn = await rowsOf(await pdf('child', 0));
        check('カルテPDF(児童用): date の無い課題は「―」・遅れて提出＋checkedAt ありは「―→M/D提出」', pn && pn.map(r => r[3]).join('|') === ['―', '―→' + md(CN) + '提出'].join('|'), JSON.stringify(pn));
        const sNo = await getSubs();
        check('表示だけの変更: 表示のあとも提出記録は書き換わらない(date を足さない・checkedAt はそのまま)', sNo.length === 2 && !('checkedAt' in recOf(sNo, 0, 301)) && recOf(sNo, 0, 302).checkedAt === CN, JSON.stringify(sNo));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== karte-submission-count-checkedat: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
