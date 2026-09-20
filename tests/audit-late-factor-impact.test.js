// 診断: 遅れ係数の変更(v1.56.0)で成績の値が変わる記録の表示(v1.57.1。読み取り専用・氏名なし)。
//   児童の記録の課題のうち、lateSubmit の印がある数値の記録(知識・技能／思考・判断・表現)を、課題名・教科・学期・該当児童数と合計で出す。
//   提出物チェックの記録・まとめテスト・主体性・実技記録・専科・欠席・文字の記録・値が変わらない記録(0点)・名簿の範囲外・2件目以降の記録は含めない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-late-factor-impact.test.js

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
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, ext: KEYS.grades_external }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    const N = 27;
    const T = (o) => Object.assign({ subject: '国語', testType: '小テスト', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    let sid = 1;
    const S = (testId, i, score, extra) => Object.assign({ id: sid++, studentIndex: i, testId: testId, score: score }, extra || {});
    const L = { lateSubmit: true };
    async function seed(d) {
        await page.evaluate((K, d, N) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: Array.from({ length: N }, (_, i) => ({ name: '秘匿' + i + '氏' })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []);
            put(K.scores, d.scores || []);
            put(K.assigns, d.assigns || []);
            put(K.subs, d.subs || []);
            put(K.att, {});
            if (d.ext) put(K.ext, d.ext); else StorageManager.remove(K.ext);
        }, KN, d, N);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
    }
    const runDiag = async () => {
        await page.evaluate(() => { showView('export'); runAuditDiagnosis(); });
        await sleep(800);
        return page.evaluate(() => window._auditDiagnosisLastResult.lateFactorImpact);
    };

    try {
        // ---- 先生の作文と同じ条件(満点5・27名・遅れの印1件・3点)＋ いろいろな除外条件 ----
        const SAKU = T({ id: 1779255384269, name: '作文_運動会なりきり', testType: '作文', category: '思考・判断・表現', maxScore: 5, date: '2026-05-20' });
        const tests = [
            SAKU,
            T({ id: 2, name: '知-小テスト', maxScore: 10, term: '1' }),                                       // 印つき: 甲0=8点・甲1=5点 / 印なし: 甲2
            T({ id: 3, name: '思-記述(2学期)', testType: '記述問題', category: '思考・判断・表現', maxScore: 20, term: '2' }), // 印つき1件
            T({ id: 4, name: '主体性-得点', category: '主体性', maxScore: 10, inputMode: 'score' }),             // 対象外(以前から0.8倍されていない)
            T({ id: 5, name: 'まとめ', type: 'matome', testType: 'まとめテスト', category: '複合', maxScore: 4, matomePoints: [2, 2], matomeQuestionTypes: ['知', '思'], matomeQCount: 2 }), // 対象外
            T({ id: 6, name: '実技-点', testType: '実技記録', category: '知識・技能', maxScore: 9999, peUnit: '点' }), // 対象外
            T({ id: 7, name: '0点だけ', maxScore: 10 }),                                                         // 印つきでも0点: 値が変わらない
            T({ id: 8, name: '欠席だけ', maxScore: 10 }),                                                        // 欠席
            T({ id: 9, name: '5段階(文字)', category: '思考・判断・表現', maxScore: 0, inputMode: 'abc5', testType: '記述問題' }), // 文字の記録
            T({ id: 10, name: '範囲外・重複', maxScore: 10 }),                                                    // 名簿の範囲外・同じ児童の2件目
            T({ id: 11, name: '満点なしの思考', category: '思考・判断・表現', maxScore: 0, testType: '記述問題', inputMode: 'score' }), // 思考は満点0なら未評価(値が出ない)
            T({ id: 12, name: '専科の課題', subject: '音楽', maxScore: 10 })                                      // 専科(外部)の教科: 対象外
        ];
        const scores = [];
        for (let i = 0; i < N; i++) scores.push(S(SAKU.id, i, 1 + (i % 5), i === 7 ? L : {}));
        scores[7] = Object.assign({}, scores[7], { score: 3 });
        scores.push(S(2, 0, 8, L), S(2, 1, 5, L), S(2, 2, 8));
        scores.push(S(3, 4, 15, L));
        scores.push(S(4, 0, 6, L));
        scores.push(S(5, 0, 4, Object.assign({ answers: [2, 2] }, L)));
        scores.push(S(6, 0, 9, L));
        scores.push(S(7, 0, 0, L), S(7, 1, 0, L));
        scores.push(S(8, 0, 8, Object.assign({ absent: true }, L)));
        scores.push(S(9, 0, 'A', L));
        scores.push(S(10, 99, 8, L), S(10, 3, 6, L), S(10, 3, 9, L));   // 99=名簿の範囲外 / 児童3は2件(最初の6点だけが成績に使われる)
        scores.push(S(11, 0, 7, L));
        scores.push(S(12, 0, 8, L));
        // 提出物チェックの記録(遅れの印 lateOnDue)は含めない
        const assigns = [{ id: 101, subject: '国語', name: '宿題1', date: '2026-05-10', term: '1', createdAt: '2026-05-01T00:00:00Z' }];
        const subs = [0, 1, 2].map(i => ({ id: 900 + i, studentIndex: i, assignmentId: 101, status: 'submitted', correctionDone: true, lateOnDue: true, createdAt: '2026-05-12T00:00:00Z' }));
        await seed({ tests, scores, assigns, subs, ext: { subjects: ['音楽'], data: {} } });
        const before = await page.evaluate(() => [KEYS.tests, KEYS.scores, KEYS.master, KEYS.submissions_data, KEYS.submissions_assignments].map(k => StorageManager.getRaw(k)));
        const spy = await page.evaluate(async () => {
            let n = 0; const o = Storage.prototype.setItem, r = Storage.prototype.removeItem;
            Storage.prototype.setItem = function() { n++; return o.apply(this, arguments); }; Storage.prototype.removeItem = function() { n++; return r.apply(this, arguments); };
            try { showView('export'); runAuditDiagnosis(); await new Promise(res => setTimeout(res, 900)); } finally { Storage.prototype.setItem = o; Storage.prototype.removeItem = r; }
            return { writes: n, lf: window._auditDiagnosisLastResult.lateFactorImpact };
        });
        const lf = spy.lf;
        const byName = {}; lf.list.forEach(e => { byName[e.name] = e; });

        check('先生の作文と同じ条件(満点5・遅れの印1件・3点): 課題名・教科・学期(1学期)・該当1人で出る', byName['作文_運動会なりきり'] && byName['作文_運動会なりきり'].count === 1 && byName['作文_運動会なりきり'].subject === '国語' && byName['作文_運動会なりきり'].termLabel === '1学期', JSON.stringify(byName['作文_運動会なりきり']));
        check('知識・技能の小テスト: 印つき2人が該当(印なしの1人は数えない)', byName['知-小テスト'] && byName['知-小テスト'].count === 2 && byName['知-小テスト'].termLabel === '1学期', JSON.stringify(byName['知-小テスト']));
        check('思考・判断・表現の記述問題(2学期): 学期は課題の学期(2学期)で出る', byName['思-記述(2学期)'] && byName['思-記述(2学期)'].count === 1 && byName['思-記述(2学期)'].termLabel === '2学期', JSON.stringify(byName['思-記述(2学期)']));
        check('範囲外の児童と2件目の記録は数えない(児童3の最初の6点の1件だけ)', byName['範囲外・重複'] && byName['範囲外・重複'].count === 1, JSON.stringify(byName['範囲外・重複']));
        check('主体性・まとめテスト・実技記録は含めない(以前から0.8倍されていない)', !byName['主体性-得点'] && !byName['まとめ'] && !byName['実技-点'], Object.keys(byName).join(','));
        check('印つきでも0点(値が変わらない)・欠席・文字の記録(5段階)・満点なしの思考(値が出ない)は含めない', !byName['0点だけ'] && !byName['欠席だけ'] && !byName['5段階(文字)'] && !byName['満点なしの思考'], Object.keys(byName).join(','));
        check('専科(外部)の教科の課題は含めない', !byName['専科の課題'], Object.keys(byName).join(','));
        check('提出物チェックの記録(lateOnDue)は含めない(提出物の課題名も出ない)', !byName['宿題1'] && lf.list.every(e => e.testType !== ''), Object.keys(byName).join(','));
        check('含まれる課題は4つだけ(作文・知識・思考・範囲外/重複)。それ以外は出ない', lf.testCount === 4 && lf.list.length === 4, String(lf.testCount) + ':' + Object.keys(byName).join(','));
        check('合計: 4課題・のべ5人分の記録(1+2+1+1)・児童は実5人(0,1,3,4,7。重複なしで数える)', lf.recordCount === 5 && lf.studentCount === 5, JSON.stringify({ t: lf.testCount, r: lf.recordCount, s: lf.studentCount }));
        // 独立に確かめる: 一覧の課題は、実際の成績計算(grdCalculate)で「以前の0.8倍」と値が違う児童の数と一致する
        const indep = await page.evaluate(() => {
            const res = grdCalculate('国語', 'all'), out = {};
            const items = (r) => [].concat(r.knowledge.items, r.thinking.items);
            res.forEach((r, i) => {
                const sc = StorageManager.get(KEYS.scores, []);
                items(r).forEach(it => {
                    if (typeof it.score10 !== 'number') return;
                    const rec = sc.find(x => Number(x.studentIndex) === i && x.lateSubmit === true && x.absent !== true && typeof x.score === 'number' && StorageManager.get(KEYS.tests, []).some(t => t.name === it.name && t.id === x.testId && t.type !== 'matome' && t.testType !== '実技記録'));
                    // 同じ児童・同じ課題の最初の記録が印つきのときだけ(成績計算と同じ)
                    const first = rec && sc.find(x => x.testId === rec.testId && Number(x.studentIndex) === i);
                    if (!rec || first !== rec) return;
                    const before = Math.round(it.score10 * 0.8 * 10) / 10;
                    if (Math.round(it.score10 * 10) / 10 !== before) out[it.name] = (out[it.name] || 0) + 1;
                });
            });
            return out;
        });
        check('独立の確認: 成績計算の値と「以前の0.8倍」が違う児童数が、課題ごとに一覧と一致する', JSON.stringify(Object.keys(indep).sort().map(k => [k, indep[k]])) === JSON.stringify(lf.list.map(e => [e.name, e.count]).sort()) , JSON.stringify(indep));
        // 画面
        const dom = await page.evaluate(() => { const c = document.getElementById('audit-late-factor'); return { has: !!c, rows: c ? Array.from(c.querySelectorAll('tr.audit-late-row')).map(r => Array.from(r.children).map(td => td.textContent)) : [], text: c ? c.textContent : '' }; });
        check('診断の画面: 課題名・教科・学期・該当の児童数の表と、合計が出る', dom.has && dom.rows.length === 4 && dom.rows.some(r => r[0] === '作文_運動会なりきり' && r[1] === '国語' && r[2] === '1学期' && r[3] === '1人') && /合計: 4課題・のべ5人分の記録（児童 実5人）/.test(dom.text), JSON.stringify(dom.rows));
        check('画面と結果に氏名が含まれない', dom.text.indexOf('秘匿') === -1 && JSON.stringify(lf).indexOf('秘匿') === -1, '');
        // コピー用テキスト
        const clip = await page.evaluate(() => new Promise(res => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { res(t); return Promise.resolve(); } } }); copyAuditResultAsText(); setTimeout(() => res(''), 1500); }));
        check('テキストでコピー: 課題ごとの行と合計が入る(氏名なし)', /【遅れの印がある数値の記録/.test(clip) && /1学期 国語 「作文_運動会なりきり」 : 1人/.test(clip) && /合計: 4課題・のべ5人分の記録（児童 実5人）/.test(clip) && clip.indexOf('秘匿') === -1, clip.slice(clip.indexOf('【遅れ'), clip.indexOf('【遅れ') + 160));
        // 読み取り専用
        const after = await page.evaluate(() => [KEYS.tests, KEYS.scores, KEYS.master, KEYS.submissions_data, KEYS.submissions_assignments].map(k => StorageManager.getRaw(k)));
        check('読み取り専用: 診断の間、localStorage への書き込み・削除が0回で、課題・記録・名簿・提出物が1バイトも変わらない', spy.writes === 0 && JSON.stringify(before) === JSON.stringify(after), 'writes=' + spy.writes);

        // ---- 該当なし ----
        await seed({ tests: [T({ id: 1, name: '印なし' })], scores: [S(1, 0, 8), S(1, 1, 5)] });
        const none = await runDiag();
        const noneDom = await page.evaluate(() => (document.getElementById('audit-late-factor') || {}).textContent || '');
        check('該当なし: 「該当なし（この変更で成績の値が変わる記録はありません）」と出る', none.testCount === 0 && none.recordCount === 0 && /該当なし/.test(noneDom), JSON.stringify(none));
        // ---- 学期の判定: 課題の学期指定がなければ実施日から ----
        await seed({ tests: [T({ id: 1, name: '日付で3学期', term: undefined, date: '2027-02-10' }), T({ id: 2, name: '日付で2学期', term: undefined, date: '2026-10-05' })], scores: [S(1, 0, 8, L), S(2, 0, 8, L)] });
        const terms = await runDiag();
        check('学期は課題の学期(指定がなければ実施日)で出る(3学期・2学期)', terms.list.some(e => e.name === '日付で3学期' && e.termLabel === '3学期') && terms.list.some(e => e.name === '日付で2学期' && e.termLabel === '2学期') && terms.list[0].termLabel === '2学期', JSON.stringify(terms.list));
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== audit-late-factor-impact: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
