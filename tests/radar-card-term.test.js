// M4(v1.60.0): 面談用レーダーPDFの教科カード(2ページ目以降)のテスト一覧・テスト平均を、成績画面で選んでいる学期で絞る。
//   以前は、同じカードの中で 評定・観点別=成績画面の学期 なのに、テスト一覧・テスト平均は通年(全学期)だった。
//   また「主体性」の観点のテストを category だけで外していたため、得点方式(v1.49.0〜)の主体性が平均に入らなかった。
//   今は、成績と同じく入力形式(getItemInputMode)で分け、得点方式の主体性は平均に含め、5段階の主体性は今までどおり含めない。
//   成績画面の評定・観点別の値・レーダー1ページ目の表は変えない。検定(実技記録)・漢字は学期に関係なく今までどおり。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node radar-card-term.test.js

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
    // 個人カルテ(出力)の画面の学期を選び、レーダーPDFの実際のボタンを押して、PDFの各ページのHTMLを取り出す(v1.60.2 で成績処理画面から変更)
    async function radar(gradeTerm) {
        await page.evaluate((gradeTerm) => {
            window.__pdfPages = null;
            window.htmlPagesToPdf = function(pages) { window.__pdfPages = pages; return Promise.resolve(true); };
            // v1.60.2: ボタンは個人カルテ(出力)の画面にある。学期はその画面の学期セレクタ(kvTermSel)
            showView('karte'); kvSetMode('output');
            const s = document.getElementById('kvTermSel'); s.value = gradeTerm; s.dispatchEvent(new Event('change'));
        }, gradeTerm);
        await sleep(200);
        await page.evaluate(() => { document.getElementById('grdExtRadarPdfBtn').click(); });
        await sleep(400);
        return page.evaluate(() => (window.__pdfPages || []).map(h => h));
    }
    const text = (html) => html.replace(/<[^>]*>/g, '\n').replace(/\n+/g, '\n').trim();
    // 国語カード(2ページ目の中の、教科名「国語」のカード)のテキスト
    const kokugo = (pages, pageIdx) => { const t = text(pages[pageIdx] || ''); const a = t.indexOf('国語\n評定'); return a < 0 ? '' : t.slice(a, a + 400); };
    const avgOf = (card) => { const m = /テスト平均 ([\d.]+)点\(換算\)/.exec(card); return m ? m[1] : '-'; };

    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score) => ({ id: testId * 100 + i, studentIndex: i, testId, score });

    // ---- 題材: 国語。甲(0)の点数 ----
    //   知識 一学期=8点(→8.0)・二学期=4点(→4.0) / 主体性(得点方式) 一学期=6点・二学期=2点 / 主体性(5段階) 一学期=A(数値でないので平均に入らない)
    //   平均(10点換算の単純平均): 1学期=(8+6)÷2=7.0→「70点」/ 2学期=(4+2)÷2=3.0→「30点」/ 通年=(8+4+6+2)÷4=5.0→「50点」
    //   以前(通年・主体性の得点方式は含めない): 知識だけの (8+4)÷2=6.0 →「60点」を、どの学期を選んでも表示していた
    const tests = [
        T({ id: 1, name: '一学期の漢字', term: '1', date: '2026-05-10' }),
        T({ id: 2, name: '二学期の漢字', term: '2', date: '2026-09-10' }),
        T({ id: 3, name: '一学期の意欲得点', category: '主体性', inputMode: 'score', term: '1', date: '2026-05-12', testType: '授業課題' }),
        T({ id: 4, name: '二学期の意欲得点', category: '主体性', inputMode: 'score', term: '2', date: '2026-09-12', testType: '授業課題' }),
        T({ id: 5, name: '一学期の態度五段階', category: '主体性', inputMode: 'abc5', maxScore: 0, term: '1', date: '2026-05-14', testType: '授業課題' })
    ];
    const scores = [S(1, 0, 8), S(2, 0, 4), S(3, 0, 6), S(4, 0, 2), S(5, 0, 'A'), S(1, 1, 10), S(2, 1, 10), S(3, 1, 10), S(4, 1, 10)];

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores });

        // ============ 0. 成績画面の値(変えない): 学期ごとの観点別・評定 ============
        const grades = await page.evaluate(() => ['1', '2', 'all'].map(t => JSON.stringify(grdCalculate('国語', t).map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei]))));
        const GRADES = ['[[8,"A","",8,"A",""],[10,"A","",10,"A",""]]', '[[4,"C","",2,"C",""],[10,"A","",10,"A",""]]', '[[6,"B","",6,"B",""],[10,"A","",10,"A",""]]'];
        check('成績画面: 国語の観点別・評定が、1学期・2学期・通年とも変更前と完全に同じ(主体性は得点方式6点と5段階Aを合わせた平均8→A、という成績の計算のまま)', JSON.stringify(grades) === JSON.stringify(GRADES), JSON.stringify(grades));

        // ============ 1. 成績画面が「1学期」: 1学期のテストだけ(得点方式の主体性を含む) ============
        const p1 = await radar('1');
        const c1 = kokugo(p1, 1);
        check('1学期: 教科カードのテスト平均は「70点(換算)」(知識8.0と主体性得点方式6.0の平均。二学期のテストは入らない)', avgOf(c1) === '70', c1.replace(/\n/g, ' / '));
        check('1学期: テストの一覧に、一学期の知識・一学期の主体性(得点方式)が出て、二学期のテスト・5段階の主体性は出ない', c1.indexOf('一学期の漢字') !== -1 && c1.indexOf('一学期の意欲得点') !== -1 && c1.indexOf('二学期') === -1 && c1.indexOf('五段階') === -1, c1.replace(/\n/g, ' / '));
        // 同じカードの 評定・観点別(1ページ目の表)は成績画面の1学期と同じ
        const rowOf = (html) => { const m = /<td[^>]*>国語<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td>/.exec(html || ''); return m ? m.slice(1, 5).join(',') : '?'; };
        check('1学期: 1ページ目の表(観点別・評定)は成績画面の1学期のまま(知A・思—・主A・評定—)', rowOf(p1[0]) === 'A,—,A,—', rowOf(p1[0]));

        // ============ 2. 成績画面が「2学期」 ============
        const p2 = await radar('2');
        const c2 = kokugo(p2, 1);
        check('2学期: 教科カードのテスト平均は「30点(換算)」・一覧は二学期のテストだけ(得点方式の主体性を含む)', avgOf(c2) === '30' && c2.indexOf('二学期の漢字') !== -1 && c2.indexOf('二学期の意欲得点') !== -1 && c2.indexOf('一学期') === -1, c2.replace(/\n/g, ' / '));

        // ============ 3. 成績画面が「通年」 ============
        const pa = await radar('all');
        const ca = kokugo(pa, 1);
        check('通年: 教科カードのテスト平均は「50点(換算)」(知識2件＋主体性の得点方式2件の平均。5段階は入らない)', avgOf(ca) === '50', ca.replace(/\n/g, ' / '));
        check('通年: 一覧(直近3件)に、得点方式の主体性も出る(二学期の意欲得点)', ca.indexOf('二学期の意欲得点') !== -1 && ca.indexOf('五段階') === -1, ca.replace(/\n/g, ' / '));

        // ============ 4. 学期にテストが1件も無い教科は、カードの平均が出ない(0点にしない) ============
        const p3 = await radar('3');
        const c3 = kokugo(p3, 1);
        check('3学期(この教科にテストが無い): 「テスト平均」は出ない(0点にしない)', c3.indexOf('テスト平均') === -1, c3.replace(/\n/g, ' / '));

        // ============ 5. 読み取り専用 ============
        const before = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores)], KN);
        await radar('1');
        const after = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores)], KN);
        check('レーダーPDFの生成で、課題・記録は1バイトも変わらない', JSON.stringify(before) === JSON.stringify(after), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== radar-card-term: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
