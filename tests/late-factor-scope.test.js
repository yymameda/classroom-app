// 遅れ係数(0.8倍)の適用範囲(v1.56.0・DATA_FLOW_AUDIT.md 3章 M8 / 25章)。
//   先生の決定: 0.8倍は「提出物チェックで入力した提出記録」にだけ適用する。
//   児童の記録で入力した課題(作文・まとめテスト・単元テスト・主体性・授業課題・振り返り・実技記録など全種別)の
//   「遅」の印(record.lateSubmit)は、表示・記録としては残すが、成績の計算には使わない。
//   判定は成績計算の共通関数(grdItemScore10)に一元化され、成績処理・ダッシュボード・個人カルテのPDF・面談テキスト・CSVで一致する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node late-factor-scope.test.js

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
            window.__pdfPages = null; window.__csv = null; window.__csvName = null; window.__clip = null;
            window.htmlPagesToPdf = function(pages) { window.__pdfPages = pages; return Promise.resolve(); };
            window.universalShare = function(blob, name) { window.__csvName = name; return blob.text().then(function(t) { window.__csv = t; }); };
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
        });
    }
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId: testId, score: score }, extra || {});
    // 成績処理統合の中の、1課題の換算(10点)を児童ごとに取り出す(課題名の一部で探す)
    const itemS10 = (subject, namePart) => page.evaluate((s, n) => grdCalculate(s, 'all').map(r => {
        const all = [].concat(r.knowledge.items, r.thinking.items, r.attitude.items).filter(x => x.name.indexOf(n) === 0);
        return all.map(x => x.score10);
    }), subject, namePart);

    try {
        // ============ 1. 種別ごとに、遅れの印つきの記録が、印なしと同じ値になる(0.8倍されない) ============
        //   甲(0)=遅れの印つき・乙(1)=印なし。同じ点数を入れる。
        const specs = [
            { key: '小テスト(知識)', t: { testType: '小テスト', category: '知識・技能', maxScore: 10 }, score: 8, exp: 8 },
            { key: '作文(思考)', t: { testType: '作文', category: '思考・判断・表現', maxScore: 5 }, score: 3, exp: 6 },
            { key: '授業課題(知識)', t: { testType: '授業課題', category: '知識・技能', maxScore: 10 }, score: 7, exp: 7 },
            { key: '単元テスト(知識)', t: { testType: '単元テスト', category: '知識・技能', maxScore: 20 }, score: 15, exp: 7.5 },
            { key: '記述問題(思考)', t: { testType: '記述問題', category: '思考・判断・表現', maxScore: 10 }, score: 9, exp: 9 },
            { key: '振り返り(思考)', t: { testType: '振り返り', category: '思考・判断・表現', maxScore: 4 }, score: 3, exp: 7.5 },
            { key: '主体性(得点方式)', t: { testType: '授業課題', category: '主体性', maxScore: 10, inputMode: 'score' }, score: 6, exp: 6 },
            { key: '主体性(5段階)', t: { testType: '授業課題', category: '主体性', maxScore: 0, inputMode: 'abc5' }, score: 'B', exp: 7 },
            { key: '思考(5段階)', t: { testType: '記述問題', category: '思考・判断・表現', maxScore: 0, inputMode: 'abc5' }, score: 'A', exp: 10 },
            { key: '授業態度(主体性)', t: { testType: '授業態度', category: '主体性', maxScore: 0 }, score: 'A', exp: 10 },
            { key: '実技記録(点・知識)', t: { testType: '実技記録', category: '知識・技能', maxScore: 9999, peUnit: '点' }, score: 9, exp: 9 }
        ];
        const tests = specs.map((sp, i) => T(Object.assign({ id: 10 + i, name: 'S' + i + '_' + sp.key }, sp.t)));
        const scores = [];
        specs.forEach((sp, i) => { scores.push(S(10 + i, 0, sp.score, { lateSubmit: true })); scores.push(S(10 + i, 1, sp.score)); });
        // まとめテスト: 問1=知(2点) 問2=思(2点) 問3=主(2点)。答え 2 / 1 / 2 → 知10・思5・主10。甲は遅れの印つき
        tests.push(T({ id: 40, name: 'Sまとめ', type: 'matome', testType: 'まとめテスト', category: '複合', maxScore: 6, matomePoints: [2, 2, 2], matomeQuestionTypes: ['知', '思', '主'], matomeQCount: 3 }));
        scores.push(S(40, 0, 5, { answers: [2, 1, 2], lateSubmit: true })); scores.push(S(40, 1, 5, { answers: [2, 1, 2] }));
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores });
        for (let i = 0; i < specs.length; i++) {
            const sp = specs[i];
            const v = await itemS10('国語', 'S' + i + '_');
            check('種別「' + sp.key + '」: 遅れの印つき(甲)も印なし(乙)も同じ換算(' + sp.exp + '点)。0.8倍しない', v[0].length === 1 && v[0][0] === sp.exp && v[1][0] === sp.exp, JSON.stringify(v.slice(0, 2)));
        }
        const mat = await itemS10('国語', 'Sまとめ');
        check('種別「まとめテスト」(知・思・主に分かれる): 遅れの印つき(甲)も印なし(乙)も同じ(知10・思5・主10)', JSON.stringify(mat[0]) === JSON.stringify([10, 5, 10]) && JSON.stringify(mat[1]) === JSON.stringify([10, 5, 10]), JSON.stringify(mat.slice(0, 2)));
        const kept = await page.evaluate(() => StorageManager.get(KEYS.scores, []).filter(s => s.lateSubmit === true).length);
        check('遅れの印(lateSubmit)は記録に残っている(消えていない。11種別+まとめ=12件)', kept === specs.length + 1, String(kept));

        // 入力画面: 遅の印は今までどおり表示される(小テスト=得点入力。甲だけ「遅」・乙は番号)
        await page.evaluate(() => { showView('records'); recShowSub('input'); recSelectTestGoto(10); });
        await sleep(300);
        const mk = await page.evaluate(() => { const g = (i) => { const b = document.querySelector('#rec-row-' + i + ' .sub-row-num'); return b ? { t: b.textContent, late: b.classList.contains('late-on') } : null; }; return { r0: g(0), r1: g(1) }; });
        check('入力画面: 遅れの印つきの甲は今までどおり「遅」と表示され、印なしの乙は番号のまま', mk.r0 && mk.r0.t === '遅' && mk.r0.late && mk.r1 && mk.r1.t === '2' && !mk.r1.late, JSON.stringify(mk));

        // ============ 2. 先生の実データと同じ条件(作文_運動会なりきり: 満点5・27名・遅れの印1件) ============
        const N = 27;
        const SAKU = T({ id: 1779255384269, name: '作文_運動会なりきり', testType: '作文', category: '思考・判断・表現', maxScore: 5, date: '2026-05-20' });
        // 先生の作文と同じ条件: 27名分の数値の記録。8番目(番号8)の児童だけ「遅れて提出」の印つき・3点
        const sScores = Array.from({ length: N }, (_, i) => S(SAKU.id, i, 1 + (i % 5), { id: 5000 + i }));
        sScores[7] = S(SAKU.id, 7, 3, { id: 5007, lateSubmit: true });
        await seed({ students: Array.from({ length: N }, (_, i) => ({ name: '秘匿' + i + '氏' })), tests: [SAKU], scores: sScores });
        const sk = await itemS10('国語', '作文_運動会なりきり');
        const expectAll = sScores.map(s => Math.round(s.score / 5 * 10 * 10) / 10);
        const changed = sk.map((v, i) => v[0] !== expectAll[i]).filter(Boolean).length;
        check('先生の作文(満点5・遅れの印1件・3点): 8番目の児童は6.0点(以前は0.8倍の4.8点)', sk[7][0] === 6, String(sk[7][0]));
        check('先生の作文: 27名すべてが「得点÷満点×10」(遅れの印つきも同じ)', changed === 0 && sk.every(v => v.length === 1 && typeof v[0] === 'number'), 'changed=' + changed);
        const oldWay = sScores.map(s => { const x = Math.min(10, s.score / 5 * 10); return Math.round((s.lateSubmit ? Math.round(x * 0.8 * 10) / 10 : x) * 10) / 10; });
        const diffKids = sk.map((v, i) => v[0] !== oldWay[i]).filter(Boolean).length;
        check('先生の作文: 以前の計算(遅れは0.8倍)と比べて、値が変わる児童は1人だけ(4.8→6.0)', diffKids === 1 && oldWay[7] === 4.8, 'diffKids=' + diffKids + ' old=' + oldWay[7] + ' new=' + sk[7][0]);
        // ============ 3. 全経路で「遅れの印つき(甲)」と「印なし(乙)」が同じ値になる ============
        //   国語: 知識 小テスト 8/10 ・ 思考 作文 4/5 ・ 主体性 得点方式 6/10(いずれも甲に遅れの印)。以前は甲だけ 知識 6.4・思考 6.4 で評定が下がっていた
        const curTerm = await page.evaluate(() => grdGetCurrentTerm());
        const t3 = [
            T({ id: 1, name: '知K', testType: '小テスト', category: '知識・技能', maxScore: 10, term: curTerm }),
            T({ id: 2, name: '思T', testType: '作文', category: '思考・判断・表現', maxScore: 5, term: curTerm }),
            T({ id: 3, name: '主A', testType: '授業課題', category: '主体性', maxScore: 10, inputMode: 'score', term: curTerm })
        ];
        const s3 = [S(1, 0, 8, { lateSubmit: true }), S(1, 1, 8), S(2, 0, 4, { lateSubmit: true }), S(2, 1, 4), S(3, 0, 8, { lateSubmit: true }), S(3, 1, 8)];
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests: t3, scores: s3 });
        await installCaptures();
        const g = await page.evaluate(() => grdCalculate('国語', 'all').map(r => ({ k: r.knowledge.avg, t: r.thinking.avg, a: r.attitude.avg, kabc: r.knowledge.abc + r.thinking.abc + r.attitude.abc, h: r.hyoutei })));
        check('成績処理統合: 甲と乙が全く同じ(知識8.0・思考8.0・評定も同じ)', JSON.stringify(g[0]) === JSON.stringify(g[1]) && g[0].k === 8 && g[0].t === 8, JSON.stringify(g));
        // ダッシュボード「テスト平均」
        const dash = [];
        for (let i = 0; i < 2; i++) dash.push(await page.evaluate((i) => { showView('dashboard'); selectDashStudent(i); const rows = Array.from(document.querySelectorAll('#dashStudentKarte > .card > div')); const row = rows.find(r => /テスト平均/.test(r.textContent)); return row ? row.textContent.replace(/\s+/g, ' ').trim() : '(行なし)'; }, i));
        check('ダッシュボード: 甲と乙の「テスト平均」が同じ(8.0/10の系統。遅れの印で下がらない)', dash[0] === dash[1] && /8\.\d\/10/.test(dash[0]), JSON.stringify(dash));
        // 個人カルテのPDF(児童用・教員用): 評定・観点
        const kv = async (design, idx) => page.evaluate((design, idx) => {
            window.__pdfPages = null;
            showView('karte'); kvSetMode('output');
            const sel = document.getElementById('kvTermSel'); sel.value = 'all'; sel.dispatchEvent(new Event('change'));
            document.getElementById('kvSec_grades').checked = true;
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(idx)); });
            const r = document.querySelector('input[name="kvDesign"][value="' + design + '"]'); if (r) r.checked = true;
            document.getElementById('kvPrintBtn').click();
            const html = (window.__pdfPages || [])[0] || '';
            return html.replace(/秘匿\d+氏|甲|乙/g, '氏名').replace(/出席番号 \d+番/g, '出席番号 N番').replace(/>\d+(<\/span><span[^>]*>氏名)/g, '>N$1').replace(/\s+/g, ' ');
        }, design, idx);
        for (const design of ['child', 'teacher']) {
            const a = await kv(design, 0), b = await kv(design, 1);
            check('個人カルテPDF(' + (design === 'child' ? '児童用' : '教員用') + '): 甲と乙の成績欄が同じ(遅れの印で変わらない)', a.length > 0 && a === b, 'len=' + a.length + '/' + b.length);
        }
        // 面談用テキスト
        const conf = [];
        for (let i = 0; i < 2; i++) {
            conf.push(await page.evaluate((i) => {
                window.__clip = null; showView('karte'); kvSetMode('output');
                const sel = document.getElementById('kvTermSel'); sel.value = 'all'; sel.dispatchEvent(new Event('change'));
                document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(i)); });
                document.getElementById('kvCopyTextBtn').click();
                return null;
            }, i));
            await sleep(150);
            conf[i] = await page.evaluate(() => (window.__clip || '').split('\n').filter(l => /国語：知/.test(l)).join('|'));
        }
        check('面談用テキスト: 甲と乙の「国語：知…」の行が同じ', conf[0].length > 0 && conf[0] === conf[1], JSON.stringify(conf));
        // 成績CSV
        await page.evaluate(() => { showView('export'); });
        await sleep(200);
        await page.evaluate(() => { window.__csv = null; const subj = document.getElementById('expGradeSubj'); subj.value = '国語'; const term = document.getElementById('expGradeTerm'); if (term) term.value = 'all'; document.getElementById('expGradeBtn').click(); });
        await sleep(300);
        const csv = await page.evaluate(() => (window.__csv || '').replace(/^﻿/, '').split('\n').map(l => l.split(',')));
        const strip = (row) => row.filter((c, i) => i > 1 && !/^(甲|乙)$/.test(c)).join(',');
        check('成績CSV: 甲と乙の行が(氏名・番号を除いて)同じ', csv.length >= 3 && strip(csv[1]) === strip(csv[2]) && strip(csv[1]).length > 3, JSON.stringify(csv.slice(0, 3)));

        // 算出根拠シート(実際のボタン)の説明文
        await page.evaluate(() => { showView('grades'); });
        await sleep(300);
        await installCaptures();
        await page.evaluate(() => { const sel = document.getElementById('grdOverviewSubj'); sel.value = '国語'; });
        const basis = await page.evaluate(() => { window.__pdfPages = null; document.getElementById('grdPrintBasisBtn').click(); return null; }).then(() => sleep(400)).then(() => page.evaluate(() => (window.__pdfPages || []).join('').replace(/<[^>]*>/g, '')));
        check('算出根拠シート: 「児童の記録の「遅」の印は…得点の換算には使わない」と書かれ、「得点を80%」とは書かれない', /児童の記録の「遅」の印は表示・記録のみで、得点の換算には使わない/.test(basis) && !/得点を80%/.test(basis), basis.slice(0, 120));

        // ============ 4. 提出物チェックの遅れ(0.8上限)は今までどおり ============
        const assigns = [{ id: 101, subject: '国語', name: '宿題1', date: '2026-05-10', term: '1', createdAt: '2026-05-01T00:00:00Z' }, { id: 102, subject: '国語', name: '宿題2', date: '2026-05-11', term: '1', createdAt: '2026-05-01T00:00:00Z' }];
        const R = (id, i, a, status, extra) => Object.assign({ id: id, studentIndex: i, assignmentId: a, status: status, correctionDone: status === 'submitted', createdAt: '2026-05-12T00:00:00Z' }, extra || {});
        const subs = [R(1, 0, 101, 'submitted', { lateOnDue: true }), R(2, 0, 102, 'submitted', { lateOnDue: true }), R(3, 1, 101, 'submitted'), R(4, 1, 102, 'submitted')];
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests: [], scores: [], assigns, subs });
        const sub = await page.evaluate(() => grdCalculate('国語', '1').map(r => { const it = r.attitude.items.find(x => x.itemKey === 'submission'); return it ? it.score10 : null; }));
        check('提出物: 遅れて提出(甲)は提出の評価が上限80%(=8.0点)、期限内(乙)は100%(=10点)。ここは変わらない', sub[0] === 8 && sub[1] === 10, JSON.stringify(sub));
        const cr = await page.evaluate(() => [grdSubmissionCredit({ status: 'submitted', lateOnDue: true }), grdSubmissionCredit({ status: 'submitted' }), grdSubmissionCredit({ status: 'submitted', lateOnDue: true }, true)]);
        check('提出の評価の関数: 遅れ=0.8 / 期限内=1 / 期限日欠席の後日提出は遅れなし=1', JSON.stringify(cr) === JSON.stringify([0.8, 1, 1]), JSON.stringify(cr));

        // ============ 5. 算出根拠の説明文 ============
        // 読み取り専用: 成績計算はデータを書かない
        const before = await page.evaluate(() => StorageManager.getRaw(KEYS.scores));
        await page.evaluate(() => { grdCalculate('国語', 'all'); });
        const after = await page.evaluate(() => StorageManager.getRaw(KEYS.scores));
        check('成績計算は記録を書き換えない', before === after, '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== late-factor-scope: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
