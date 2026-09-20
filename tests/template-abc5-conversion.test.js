// 同僚用テンプレートxlsxの「A/B/C入力」の列で、5段階の B+・B- が空欄扱いになる問題の修正(v1.60.3)。
//   以前の式は A=10・B=7・C=3 だけで、B+・B- を入れると空欄(未入力扱い)になり、その項目が平均から抜けていた。
//   今は、アプリの換算(abcTo10: A=10・B+=8.5・B=7・B-=5・C=3)と同じ値になる。式の数字は abcTo10 から作る(二重管理しない)。
//   小文字(b+)・全角の＋／－(B＋・B－。アプリの画面の表記)・前後の空白も受け付ける。A/B/C と数値入力の換算は変えない。
//   確認の方法: 出力したシートの式を、テスト用の小さな計算機(helpers/xl-eval.js)で計算し、
//     (1) 入力の文字ごとの換算を abcTo10 と比べる (2) 児童ごとに、シートが出す観点のABC・評定を、成績処理(grdCalculate)と比べる。
//   SheetJS は、シートの中身を記録する代役に差し替える(ネットワークに依存しない)。実際の Excel では確認していない(標準の関数だけを使っている)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node template-abc5-conversion.test.js

const puppeteer = require('puppeteer-core');
const { makeEvaluator } = require('./helpers/xl-eval.js');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const colName = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '記述問題', name: 't', category: '知識・技能', type: 'standard', maxScore: 0, inputMode: 'abc5', date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const tests = [
        T({ id: 1, name: '知5段階', category: '知識・技能' }),
        T({ id: 2, name: '知得点', category: '知識・技能', testType: '小テスト', maxScore: 10, inputMode: 'score' }),
        T({ id: 3, name: '思5段階', category: '思考・判断・表現' }),
        T({ id: 4, name: '主5段階甲', category: '主体性', testType: '授業課題' }),
        T({ id: 5, name: '主5段階乙', category: '主体性', testType: '授業課題' }),
        T({ id: 6, name: '主得点', category: '主体性', testType: '授業課題', maxScore: 10, inputMode: 'score' }),
        T({ id: 7, name: '授業態度', category: '主体性', testType: '授業態度', maxScore: 10, inputMode: undefined })
    ];
    // 児童ごとの入力: [知5段階, 知得点, 思5段階, 主5段階甲, 主5段階乙, 主得点, 授業態度]
    const ROWS = [
        ['A', 8, 'B+', 'B+', 'B-', 6, 'A'],
        ['B-', 10, 'C', 'B', 'C', 3, 'B'],
        ['B+', 5, 'B+', 'A', 'A', 10, 'C'],
        ['C', 2, 'B-', 'B-', 'B-', 0, 'B'],
        ['B', 9, 'B', 'B', 'B', 7, 'A'],
        ['A', '', '', '', '', '', '']
    ];
    const scores = [];
    ROWS.forEach((row, i) => row.forEach((v, k) => { if (v !== '') scores.push({ id: (k + 1) * 100 + i, studentIndex: i, testId: k + 1 + (k === 6 ? 3 : 0), score: v }); }));
    // 授業態度の testId は 7 → 上で k===6 のとき 10 にしてしまうので直す
    scores.forEach(s => { if (s.testId === 10) s.testId = 7; });

    try {
        await page.evaluate((K, tests, scores) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: ['甲', '乙', '丙', '丁', '戊', '己'].map(n => ({ name: n })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3 } });
            put(K.tests, tests); put(K.scores, scores); put(K.weights, {}); put(K.assigns, []); put(K.subs, []);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, KN, tests, scores);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => {
            const col = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
            window.XLSX = { utils: { encode_col: col, encode_cell: (a) => col(a.c) + (a.r + 1), book_new: () => ({ names: [], sheets: {} }), book_append_sheet: (wb, ws, name) => { wb.names.push(name); wb.sheets[name] = ws; window.__wb = wb; }, aoa_to_sheet: (aoa) => ({ __aoa: aoa }) }, write: () => new Uint8Array(1) };
            window.__wb = null; window.universalShare = function() { return Promise.resolve(); };
            showView('grades');
            const s = document.getElementById('grdTermSel'); s.value = 'all'; s.dispatchEvent(new Event('change'));
            document.getElementById('grdGradeSubj').value = '国語';
        });
        await sleep(300);

        // ---- 成績処理(アプリ)の値 ----
        const app = await page.evaluate(() => grdCalculate('国語', 'all').map(r => ({ k: r.knowledge.abc, t: r.thinking.abc, a: r.attitude.abc, h: r.hyoutei === '' ? '' : Number(r.hyoutei) })));
        // アプリの換算(abcTo10 は成績モジュールの中なので直接は呼べない)を、成績処理の項目の点(score10)から取り出す: 主5段階の甲・乙に A〜C が並ぶ
        const appConv = await page.evaluate(() => { const m = {}; grdCalculate('国語', 'all').forEach((r, i) => { r.attitude.items.filter(x => x.name === '主5段階甲' || x.name === '主5段階乙').forEach(it => { if (it.raw) m[it.raw] = it.score10; }); }); return m; });
        check('前提: アプリの換算(abcTo10)は A=10・B+=8.5・B=7・B-=5・C=3', JSON.stringify(['A', 'B+', 'B', 'B-', 'C'].map(v => appConv[v])) === '[10,8.5,7,5,3]', JSON.stringify(appConv));

        await page.evaluate(() => { document.getElementById('grdTemplateBtn').click(); });
        await sleep(600);
        const wb = await page.evaluate(() => window.__wb ? JSON.parse(JSON.stringify(window.__wb.sheets)) : null);
        const ws = wb && wb['国語'];
        check('同僚用テンプレートが出力された', !!ws, '');

        // ---- 入力列・出力列の位置 ----
        const head = {};
        for (let c = 2; c < 80; c++) { const h = ws[colName(c) + '10']; if (h && h.v !== undefined) head[h.v] = colName(c); }
        const IN = ['知5段階', '知得点', '思5段階', '主5段階甲', '主5段階乙', '主得点', '授業態度'].map(n => head[n]);
        check('7つの入力列(5段階の項目・得点の項目・授業態度)が見つかる', IN.every(Boolean), JSON.stringify(IN));
        const maxRow = IN.map(c => (ws[c + '9'] || {}).v);
        check('満点の欄: 5段階の項目は「A/B+/B/B-/C」・得点の項目は満点の数字(10)', JSON.stringify(maxRow) === JSON.stringify(['A/B+/B/B-/C', 10, 'A/B+/B/B-/C', 'A/B+/B/B-/C', 'A/B+/B/B-/C', 10, 'A/B+/B/B-/C']), JSON.stringify(maxRow));

        // ---- (1) 入力の文字ごとの換算(補助の式)を、abcTo10 と比べる ----
        const helperOf = (inCol) => { const k = Object.keys(ws).find(a => /^[A-Z]+11$/.test(a) && ws[a].f && ws[a].f.indexOf('IF(' + inCol + '11=""') === 0); return k; };
        const evalWith = (inCol, value) => { const w2 = JSON.parse(JSON.stringify(ws)); w2[inCol + '11'] = { v: value, t: typeof value === 'number' ? 'n' : 's' }; return makeEvaluator(w2)(helperOf(inCol)); };
        const conv = (v) => evalWith(IN[0], v);
        const expectConv = appConv; // アプリの換算と同じ
        check('A/B+/B/B-/C を入れると、アプリの換算と同じ点(10/8.5/7/5/3)になる', Object.keys(expectConv).every(v => conv(v) === expectConv[v]), JSON.stringify(Object.keys(expectConv).map(v => [v, conv(v)])));
        check('小文字(a・b+・b-・c)でも同じ点になる', ['a', 'b+', 'b', 'b-', 'c'].map(conv).join() === '10,8.5,7,5,3', ['a', 'b+', 'b', 'b-', 'c'].map(conv).join());
        check('全角の＋／－(B＋・B－。アプリの画面の表記)・前後の空白(" B+ ")でも同じ点になる', conv('B＋') === 8.5 && conv('B－') === 5 && conv(' B+ ') === 8.5 && conv('B−') === 5, [conv('B＋'), conv('B－'), conv(' B+ '), conv('B−')].join());
        check('決められた文字以外(X・B++)と空欄は、今までどおり空(未入力扱い)', conv('X') === '' && conv('B++') === '' && conv('') === '', JSON.stringify([conv('X'), conv('B++'), conv('')]));
        // 既存の換算: A=10・B=7・C=3(変わっていない)と、数値入力(得点÷満点×10・上限10・0.1丸め)・授業態度(A/B/C)
        const numCol = IN[1];
        const numConv = (v) => evalWith(numCol, v);
        check('数値入力の換算は今までどおり(8/10→8・5/10→5・15/10→上限の10・3.33/10→3.3)', numConv(8) === 8 && numConv(5) === 5 && numConv(15) === 10 && numConv(3.33) === 3.3, [numConv(8), numConv(5), numConv(15), numConv(3.33)].join());
        const taiConv = (v) => evalWith(IN[6], v);
        check('授業態度の列も A/B+/B/B-/C の換算(10/8.5/7/5/3)', ['A', 'B+', 'B', 'B-', 'C'].map(taiConv).join() === '10,8.5,7,5,3', ['A', 'B+', 'B', 'B-', 'C'].map(taiConv).join());

        // ---- (2) 児童ごとに、シートが出す観点ABC・評定を、成績処理と比べる ----
        const w3 = JSON.parse(JSON.stringify(ws));
        ROWS.forEach((row, i) => row.forEach((v, k) => { if (v !== '') w3[IN[k] + (11 + i)] = { v, t: typeof v === 'number' ? 'n' : 's' }; }));
        const ev = makeEvaluator(w3);
        const sheetOut = ROWS.map((_, i) => ({ k: ev(head['知識ABC'] + (11 + i)), t: ev(head['思考ABC'] + (11 + i)), a: ev(head['主体性ABC'] + (11 + i)), h: ev(head['評定'] + (11 + i)) }));
        const same = sheetOut.map((o, i) => o.k === app[i].k && o.t === app[i].t && o.a === app[i].a && o.h === app[i].h);
        check('6人分の入力で、シートが出す 知識・思考・主体のABC と評定が、成績処理(grdCalculate)と全員同じ', same.every(Boolean), JSON.stringify(sheetOut.map((o, i) => [o.k, o.t, o.a, o.h, app[i].k, app[i].t, app[i].a, app[i].h])));
        // B+・B- の効果を、はっきり見える児童で確認する(丙: 主体性の主5段階甲=A・乙=A・主得点10 → A、丁: 主5段階B-・B-・得点0 → 平均3.3)
        const gradesOfApp = JSON.stringify(app.map(a => a.a));
        check('題材が、B+・B- の有無でABCが変わる場面を含んでいる(主体性のABCが、全員同じではない)', new Set(app.map(a => a.a)).size >= 2, gradesOfApp);
        // 修正前の式(B+・B-を空欄にする)では、この題材で結果が変わることを、式の計算で示す(題材の妥当性)
        const oldF = (inA) => 'IF(' + inA + '="","",IF(UPPER(' + inA + ')="A",10,IF(UPPER(' + inA + ')="B",7,IF(UPPER(' + inA + ')="C",3,""))))';
        const w4 = JSON.parse(JSON.stringify(w3));
        IN.forEach((c, k) => { if (![1, 5].includes(k)) for (let i = 0; i < 6; i++) { const a = helperOf(c).replace(/[0-9]+$/, String(11 + i)); if (w4[a]) w4[a] = Object.assign({}, w4[a], { f: oldF(c + (11 + i)) }); } });
        const ev4 = makeEvaluator(w4);
        const oldOut = ROWS.map((_, i) => [ev4(head['知識ABC'] + (11 + i)), ev4(head['思考ABC'] + (11 + i)), ev4(head['主体性ABC'] + (11 + i)), ev4(head['評定'] + (11 + i))].join());
        check('(題材の妥当性)修正前の式なら、この題材の児童のうち少なくとも1人は、成績処理と結果が食い違う', oldOut.some((o, i) => o !== [app[i].k, app[i].t, app[i].a, app[i].h].join()), JSON.stringify(oldOut));

        // ---- 使い方シートに、入力できる文字が書かれている ----
        const guide = (wb['使い方'].__aoa || []).map(r => r.join('')).join('\n');
        check('「使い方」に、A/B/C型の入力の換算(A=10点 / B＋=8.5点 / B=7点 / B－=5点 / C=3点)が書かれている', /A=10点 \/ B＋=8.5点 \/ B=7点 \/ B－=5点 \/ C=3点/.test(guide), guide.split('\n').filter(l => /換算/.test(l)).join(' | '));
        const app2 = await page.evaluate(() => grdCalculate('国語', 'all').map(r => [r.knowledge.abc, r.attitude.abc, r.hyoutei]));
        check('成績画面の観点別・評定は、テンプレートを出力しても変わらない', JSON.stringify(app2) === JSON.stringify(app.map(a => [a.k, a.a, a.h === '' ? '' : a.h])), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== template-abc5-conversion: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
