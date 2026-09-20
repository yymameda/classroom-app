// M5(v1.60.0): 同僚用テンプレートxlsx(📤 同僚用テンプレート)と、算出根拠xlsx(📊 Excel（根拠）)の直し。
//   (1) 同僚用テンプレートは、成績画面で選んでいる学期のテスト・まとめテストだけを列にする(以前は学期で絞らず通年)。
//       シートの題名と「使い方」に、どの学期かを書く。
//   (2) 得点方式の主体性(v1.49.0〜)は、A/B/C入力の列ではなく、得点÷満点×10の列にする(以前は主体性を無条件にA/B/C扱いにして、満点が「A/B/C」と出ていた)。
//       5段階(A/B/C)の主体性・授業態度は今までどおりA/B/C入力。
//   (3) 算出根拠xlsxの換算式のラベル「1→4点」を実際の値「1→3点」に直す(abcTo10(1)=3。成績の計算は変えない。ラベルの文字だけ)。
//   成績画面の評定・観点別の値は変えない。
//   SheetJS(XLSX)は、実際のライブラリではなく、シートの中身を記録するだけの代役に差し替えて確認する(ネットワークに依存しないため)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node template-xlsx-term.test.js

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
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, mq: KEYS.matome_questions }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []);
            put(K.scores, d.scores || []);
            put(K.assigns, []);
            put(K.subs, []);
            put(K.att, {});
            put(K.weights, {});
            put(K.mq, {});
            StorageManager.remove(K.thresholds);
            StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        // SheetJS の代役: シートを作る関数だけを記録する(ネットワーク・実物のライブラリに依存しない)
        await page.evaluate(() => {
            window.__wb = null; window.__shared = null;
            const col = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
            window.XLSX = {
                utils: {
                    encode_col: col,
                    encode_cell: (a) => col(a.c) + (a.r + 1),
                    book_new: () => ({ names: [], sheets: {} }),
                    book_append_sheet: (wb, ws, name) => { wb.names.push(name); wb.sheets[name] = ws; window.__wb = wb; },
                    aoa_to_sheet: (aoa) => ({ __aoa: aoa })
                },
                write: () => new Uint8Array(1)
            };
            window.universalShare = function(blob, name) { window.__shared = name; return Promise.resolve(); };
        });
    }
    // 成績画面で学期を選び、教科「国語」で、指定のボタンを押す
    async function exportWith(term, btnId) {
        await page.evaluate((term) => {
            window.__wb = null; window.__shared = null;
            showView('grades');
            const s = document.getElementById('grdTermSel'); s.value = term; s.dispatchEvent(new Event('change'));
            const g = document.getElementById('grdGradeSubj'); g.value = '国語';
        }, term);
        await sleep(200);
        await page.evaluate((btnId) => { document.getElementById(btnId).click(); }, btnId);
        await sleep(400);
        return page.evaluate(() => window.__wb ? { names: window.__wb.names, sheets: JSON.parse(JSON.stringify(window.__wb.sheets)) } : null);
    }
    // 同僚用テンプレートの「国語」シートから、入力列の見出し(10行目)・満点の行(9行目)・1人目の補助式(11行目)を取り出す
    function templateCols(wb) {
        const ws = wb.sheets['国語'];
        const colName = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
        const out = [];
        for (let c = 2; c < 60; c++) {
            const h = ws[colName(c) + '10'];
            if (!h || h.v === undefined || /(%|ABC|点)$/.test(h.v) && /^(知識|思考|主体性)/.test(h.v) || h.v === '合計' || h.v === '評定') break;
            const mx = ws[colName(c) + '9'];
            out.push({ label: h.v, max: mx ? mx.v : undefined, col: colName(c) });
        }
        // 補助式(隠し列)を、入力セルへの参照で対応づける
        out.forEach(o => {
            const key = Object.keys(ws).find(k => /^[A-Z]+11$/.test(k) && ws[k].f && ws[k].f.indexOf('IF(' + o.col + '11=""') === 0);
            o.f = key ? ws[key].f : '';
        });
        return out;
    }

    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score) => ({ id: testId * 100 + i, studentIndex: i, testId, score });
    const MT = (id, name, term, types) => T({ id, name, term, type: 'matome', testType: 'まとめテスト', category: '複合', maxScore: 0, matomePoints: types.map(() => 2), matomeQuestionTypes: types, matomeQCount: types.length });

    // ---- 題材: 国語 ----
    const tests = [
        T({ id: 1, name: '一学期の漢字', term: '1', date: '2026-05-10', maxScore: 10 }),
        T({ id: 2, name: '二学期の漢字', term: '2', date: '2026-09-10', maxScore: 20 }),
        T({ id: 3, name: '一学期の作文', term: '1', date: '2026-05-11', maxScore: 5, category: '思考・判断・表現', testType: '作文' }),
        T({ id: 5, name: '一学期の意欲得点', term: '1', date: '2026-05-12', maxScore: 10, category: '主体性', testType: '授業課題', inputMode: 'score' }),
        T({ id: 4, name: '二学期の意欲得点', term: '2', date: '2026-09-12', maxScore: 10, category: '主体性', testType: '授業課題', inputMode: 'score' }),
        T({ id: 6, name: '一学期の態度五段階', term: '1', date: '2026-05-14', maxScore: 0, category: '主体性', testType: '授業課題', inputMode: 'abc5' }),
        T({ id: 7, name: '二学期の態度五段階', term: '2', date: '2026-09-14', maxScore: 0, category: '主体性', testType: '授業課題', inputMode: 'abc5' }),
        T({ id: 10, name: '授業態度メモ', term: '1', date: '2026-05-15', maxScore: 10, category: '主体性', testType: '授業態度' }),
        MT(8, 'まテ1', '1', ['知', '思']),
        MT(9, 'まテ2', '2', ['知', '思'])
    ];
    const scores = [S(1, 0, 8), S(2, 0, 16), S(3, 0, 4), S(5, 0, 6), S(4, 0, 2), S(6, 0, 'B'), S(7, 0, 'A'), S(1, 1, 10), S(5, 1, 10)];
    const T1 = ['一学期の漢字', 'まテ1（知識）', '一学期の作文', 'まテ1（思考）', '一学期の意欲得点', '一学期の態度五段階', '授業態度メモ'];
    const T2 = ['二学期の漢字', 'まテ2（知識）', 'まテ2（思考）', '二学期の意欲得点', '二学期の態度五段階'];

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores });

        // ============ 0. 成績画面の値(変えない) ============
        const grades = await page.evaluate(() => ['1', '2', 'all'].map(t => JSON.stringify(grdCalculate('国語', t).map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.avg, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei]))));
        const GRADES = ['[[8,"A",8,"A",6.5,"B",3],[10,"A",null,"",10,"A",""]]', '[[8,"A",null,"",6,"B",""],[null,"",null,"",null,"",""]]', '[[8,"A",8,"A",6.3,"B",3],[10,"A",null,"",10,"A",""]]'];
        check('成績画面: 国語の観点別・評定が、1学期・2学期・通年とも変更前と完全に同じ', JSON.stringify(grades) === JSON.stringify(GRADES), JSON.stringify(grades));

        // ============ 1. 同僚用テンプレート: 成績画面が「1学期」→ 1学期のテストだけ ============
        const w1 = await exportWith('1', 'grdTemplateBtn');
        check('同僚用テンプレートが出力された(シート「国語」と「使い方」ができる)', !!w1 && w1.names.indexOf('国語') !== -1 && w1.names.indexOf('使い方') !== -1, JSON.stringify(w1 && w1.names));
        const c1 = templateCols(w1);
        check('1学期: 入力列は1学期のテスト・まとめテストだけ(二学期のテストは出ない)', JSON.stringify(c1.map(x => x.label)) === JSON.stringify(T1), JSON.stringify(c1.map(x => x.label)));
        // 得点方式の主体性は、満点(10)つきの得点入力・A/B/C入力ではない
        const sc1 = c1.find(x => x.label === '一学期の意欲得点');
        check('1学期: 得点方式の主体性は「満点10」の得点入力(A/B/Cではない)。換算式は 得点÷満点×10(上限10)', sc1 && sc1.max === 10 && /ROUND\(MIN\(/.test(sc1.f) && !/UPPER\(/.test(sc1.f), JSON.stringify(sc1));
        const ab1 = c1.find(x => x.label === '一学期の態度五段階');
        check('1学期: 5段階の主体性は「A/B+/B/B-/C」入力(v1.60.3で B+・B- に対応。換算は template-abc5-conversion.test.js)', ab1 && ab1.max === 'A/B+/B/B-/C' && /UPPER\(/.test(ab1.f), JSON.stringify(ab1));
        const tai1 = c1.find(x => x.label === '授業態度メモ');
        check('1学期: 授業態度の主体性も「A/B+/B/B-/C」入力(v1.60.3)', tai1 && tai1.max === 'A/B+/B/B-/C' && /UPPER\(/.test(tai1.f), JSON.stringify(tai1));
        check('1学期: 知識・思考の得点入力の満点は今までどおり(漢字10・まとめテストの知識2・作文5)', c1[0].max === 10 && c1[1].max === 2 && c1[2].max === 5 && /ROUND\(MIN\(/.test(c1[0].f), JSON.stringify(c1.slice(0, 3).map(x => x.max)));
        const ws1 = w1.sheets['国語'];
        check('1学期: シートの題名に対象の学期が入る(「国語　成績計算（同僚用）（1学期）」)', ws1.A1 && ws1.A1.v === '国語　成績計算（同僚用）（1学期）', ws1.A1 && ws1.A1.v);
        const guide1 = (w1.sheets['使い方'].__aoa || []).map(r => r.join('')).join('\n');
        check('1学期: 「使い方」に、対象の学期(成績画面で選んでいた学期)が書かれる', /対象の学期：1学期/.test(guide1), guide1.split('\n').slice(0, 4).join(' / '));

        // ============ 2. 成績画面が「2学期」 ============
        const w2 = await exportWith('2', 'grdTemplateBtn');
        const c2 = templateCols(w2);
        check('2学期: 入力列は2学期のテスト・まとめテストだけ(得点方式の主体性は得点入力・5段階はA/B/C)', JSON.stringify(c2.map(x => x.label)) === JSON.stringify(T2) && c2.find(x => x.label === '二学期の意欲得点').max === 10 && c2.find(x => x.label === '二学期の態度五段階').max === 'A/B+/B/B-/C', JSON.stringify(c2.map(x => [x.label, x.max])));

        // ============ 3. 成績画面が「通年」 → 全学期(以前の出力と同じ列) ============
        const wa = await exportWith('all', 'grdTemplateBtn');
        const ca = templateCols(wa);
        const ALL = T1.concat(T2);
        check('通年: 入力列は全学期のテスト(1学期の分と2学期の分の両方)。題名は「（通年）」', ca.length === ALL.length && ALL.every(l => ca.some(x => x.label === l)) && wa.sheets['国語'].A1.v === '国語　成績計算（同僚用）（通年）', JSON.stringify(ca.map(x => x.label)));
        check('通年: 得点方式の主体性2件はどちらも得点入力(満点10)', ca.filter(x => /意欲得点$/.test(x.label)).every(x => x.max === 10), JSON.stringify(ca.filter(x => /意欲得点$/.test(x.label)).map(x => x.max)));

        // ============ 4. 学期にテストが1件も無い教科(3学期): 入力列が空でも出力は壊れない ============
        const w3 = await exportWith('3', 'grdTemplateBtn');
        check('3学期(テストなし): 出力は壊れず、入力列は0件・題名は「（3学期）」', !!w3 && templateCols(w3).length === 0 && w3.sheets['国語'].A1.v === '国語　成績計算（同僚用）（3学期）', JSON.stringify(w3 && templateCols(w3).length));

        // ============ 5. 算出根拠xlsx: 換算式のラベル「1→4点」→「1→3点」(実際の値)。成績の値は変えない ============
        //   数値の3/2/1で入力された5段階の主体性(旧バージョンの記録)。abcTo10(3)=10・(2)=7・(1)=3
        await seed({ students: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], tests: [T({ id: 21, name: '旧三段階', term: '1', maxScore: 0, category: '主体性', testType: '授業課題', inputMode: 'abc5' })], scores: [S(21, 0, 3), S(21, 1, 2), S(21, 2, 1)] });
        const g5 = await page.evaluate(() => grdCalculate('国語', '1').map(r => [r.attitude.avg, r.attitude.abc]));
        check('成績画面: 数値3/2/1の5段階は 10/7/3点として今までどおり計算される(10・7・3)', JSON.stringify(g5) === '[[10,"A"],[7,"B"],[3,"C"]]', JSON.stringify(g5));
        const wb = await exportWith('1', 'grdExcelBtn');
        const sheet = wb && wb.sheets['根拠_主体性'] && wb.sheets['根拠_主体性'].__aoa;
        const labels = sheet ? sheet.slice(3, 6).map(r => r[3]) : [];
        check('算出根拠xlsx(根拠_主体性): 換算式は 3→10点・2→7点・1→3点(以前は「1→4点」)', JSON.stringify(labels) === JSON.stringify(['3→10点', '2→7点', '1→3点']), JSON.stringify(labels));
        check('算出根拠xlsx: 「1→4点」という表記はどのシートにも残っていない', !!wb && JSON.stringify(wb.sheets).indexOf('1→4点') === -1, '');
        check('算出根拠xlsx: 表の下の換算ルール行(3段階：3=10 2=7 1=3)と、ラベルの値が一致している', !!sheet && sheet.some(r => r.indexOf('3段階：3=10 2=7 1=3') !== -1), '');

        // ============ 6. 読み取り専用 ============
        const before = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores), StorageManager.getRaw(K.weights)], KN);
        await exportWith('1', 'grdTemplateBtn');
        await exportWith('1', 'grdExcelBtn');
        const after = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores), StorageManager.getRaw(K.weights)], KN);
        check('xlsxの出力で、課題・記録・重みは1バイトも変わらない', JSON.stringify(before) === JSON.stringify(after), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== template-xlsx-term: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
