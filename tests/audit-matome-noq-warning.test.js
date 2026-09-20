// L10(v1.60.0): 診断の警告「まとめ形式のテスト(まとめテスト・単元テスト)のうち問題定義のないもの N件」が出るようにする。
//   以前は collectAnomalies が result.matomeBalance.matomeNoQ を読んでいたが、その値は structuralIntegrity.matomeNoQ にしか無く、
//   警告は一度も出なかった(画面の構造の行では見えていた)。読み取る場所を直しただけで、成績・記録・設問の計算には触れない。
//   設問なしのテストがあると、診断の総合判定は「🟠 注意項目あり」になる(以前は「🟢 致命的問題なし」のまま)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-matome-noq-warning.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WARN_RE = /まとめ形式のテスト\(まとめテスト・単元テスト\)のうち問題定義のないもの (\d+)件/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, mq: KEYS.matome_questions }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    const M = (id, name, types, extra) => Object.assign({ id, subject: '体育', testType: 'まとめテスト', type: 'matome', name, category: '複合', maxScore: 0, date: '2026-06-23', term: '1', matomePoints: types.map(() => 2), matomeQuestionTypes: types, matomeQCount: types.length }, extra || {});
    const EMPTY = { matomePoints: [], matomeQuestionTypes: [], matomeQCount: 0 };
    const STD = { id: 90, subject: '国語', testType: '小テスト', type: 'standard', name: '漢字小テスト', category: '知識・技能', maxScore: 10, date: '2026-06-23', term: '1' };

    async function seed(tests, qstore, scores) {
        await page.evaluate((K, tests, qstore, scores) => {
            StorageManager.setImmediate(K.master, JSON.stringify({ version: 2, students: [{ name: '甲' }, { name: '乙' }], classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3 } }));
            StorageManager.setImmediate(K.tests, JSON.stringify(tests));
            StorageManager.setImmediate(K.scores, JSON.stringify(scores || []));
            StorageManager.setImmediate(K.mq, JSON.stringify(qstore || {}));
        }, KN, tests, qstore, scores);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
    }
    async function diagnose() {
        return page.evaluate(async () => {
            let n = 0; const o = Storage.prototype.setItem, r = Storage.prototype.removeItem;
            Storage.prototype.setItem = function() { n++; return o.apply(this, arguments); }; Storage.prototype.removeItem = function() { n++; return r.apply(this, arguments); };
            try { showView('export'); runAuditDiagnosis(); await new Promise(res => setTimeout(res, 900)); } finally { Storage.prototype.setItem = o; Storage.prototype.removeItem = r; }
            const res = window._auditDiagnosisLastResult;
            return { writes: n, warn: res.anomalies.warn, critical: res.anomalies.critical, overall: res.anomalies.overallStatus, siNoQ: res.structuralIntegrity.matomeNoQ, text: document.getElementById('audit-result-container').textContent };
        });
    }
    const noqWarns = (d) => d.warn.filter(w => WARN_RE.test(w));
    const gradeSnap = () => page.evaluate(() => JSON.stringify(grdCalculate('国語', 'all').map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.avg, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum])));

    try {
        // ============ 1. 設問なしのテストがある: 警告が出る・総合判定は「注意項目あり」 ============
        //   設問なし = matomePoints が空で、設問の別ストア(matome_questions)にも無い、type==='matome' のテスト(まとめテスト・単元テスト)
        const tests1 = [
            M(1, 'まテ_設問あり', ['知', '思']),
            M(2, 'まテ_設問なし', [], EMPTY),
            M(3, '単元_設問なし', [], Object.assign({ testType: '単元テスト' }, EMPTY)),
            M(4, 'まテ_設問は別ストア', [], EMPTY),
            STD
        ];
        const scores1 = [{ id: 1, studentIndex: 0, testId: 90, score: 8 }, { id: 2, studentIndex: 1, testId: 90, score: 6 }];
        await seed(tests1, { 4: [{ points: 3, type: '思' }] }, scores1);
        const gradeBefore = await gradeSnap();
        const rawBefore = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores), StorageManager.getRaw(K.mq), StorageManager.getRaw(K.master)], KN);
        const d1 = await diagnose();
        const w1 = noqWarns(d1);
        check('設問なしのまとめ形式テストが2件(まとめテスト1・単元テスト1)あると、警告「…問題定義のないもの 2件」が1行出る', w1.length === 1 && WARN_RE.exec(w1[0])[1] === '2', JSON.stringify(d1.warn));
        check('警告の件数は、画面の「構造的整合性」の行(問題定義なし)の件数と同じ(2件)', d1.siNoQ === 2, String(d1.siNoQ));
        check('総合判定は「🟠 注意項目あり」になる(致命的な問題は無い)', d1.overall === '🟠 注意項目あり' && d1.critical.length === 0, d1.overall + ' critical=' + d1.critical.length);
        check('診断の画面にも、警告の文が出る', WARN_RE.test(d1.text) && d1.text.indexOf('🟠 注意項目あり') !== -1, '');
        check('設問が別ストア(matome_questions)にあるテストは「設問なし」に数えない(数えるのは2件だけ)', d1.siNoQ === 2, '');
        const gradeAfter = await gradeSnap();
        const rawAfter = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores), StorageManager.getRaw(K.mq), StorageManager.getRaw(K.master)], KN);
        check('成績画面の観点別・評定の値は診断の前後で完全に同じ(国語: 知識8・6の平均が出る)', gradeBefore === gradeAfter && JSON.parse(gradeAfter)[0][0] === 8 && JSON.parse(gradeAfter)[1][0] === 6, gradeAfter.slice(0, 80));
        check('読み取り専用: 診断の間の書き込み・削除が0回で、課題・記録・設問・名簿が1バイトも変わらない', d1.writes === 0 && JSON.stringify(rawBefore) === JSON.stringify(rawAfter), 'writes=' + d1.writes);

        // ============ 2. 設問なしのテストが無い: 警告は出ない(総合判定は今までどおり) ============
        await seed([M(1, 'まテ_設問あり', ['知', '思']), M(4, 'まテ_設問は別ストア', [], EMPTY), M(5, '単元_設問あり', ['知', '知'], { testType: '単元テスト' }), STD], { 4: [{ points: 3, type: '思' }] }, scores1);
        const d2 = await diagnose();
        check('設問なしのテストが無いとき、警告は出ない・画面の構造の行は0件(なし)', noqWarns(d2).length === 0 && d2.siNoQ === 0 && !WARN_RE.test(d2.text), JSON.stringify(d2.warn));
        check('設問なしのテストが無いとき、総合判定は「🟢 致命的問題なし」のまま(他に注意項目が無いデータ)', d2.overall === '🟢 致命的問題なし', d2.overall + ' warn=' + JSON.stringify(d2.warn));

        // ============ 3. まとめ形式ではないテストは「設問なし」に数えない ============
        //   通常のテスト(type が standard)・新体力テストの自動取り込みが作る課題(testType は「まとめテスト」だが type が無い)
        const fitness = { id: 'fitness_2026', subject: '体育', name: '新体力テスト総合', category: '知識・技能', testType: 'まとめテスト', date: '2026-06-23', maxScore: 10, year: '2026' };
        await seed([M(1, 'まテ_設問あり', ['知', '思']), STD, fitness], {}, scores1);
        const d3 = await diagnose();
        check('通常のテストと、type の無い「新体力テスト総合」(testType はまとめテスト)は、設問なしの警告に数えない', noqWarns(d3).length === 0 && d3.siNoQ === 0, JSON.stringify(d3.warn));

        // ============ 4. テストが1件も無い ============
        await seed([], {}, []);
        const d4 = await diagnose();
        check('テストが1件も無いときも警告は出ない', noqWarns(d4).length === 0, JSON.stringify(d4.warn));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== audit-matome-noq-warning: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
