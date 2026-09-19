// データ反映の回帰テスト（DATA_FLOW_AUDIT.md の H1〜H5・M1・M6 対応）
//
// 児童の記録・提出物チェックで入力したデータが、成績処理統合・個人カルテ・データ出力(PDF/CSV)・
// ダッシュボードに、学期別・入力形式別に正しい値で反映されているかを検証する。
// 期待値は「成績処理統合(grdCalculate)」を基準とし、各出力がそれと一致することを確認する。
//
// セクション: H1(出力の学期)+H5(成績キャッシュの古さ) / H2(汎用実技記録) / H3(観点変更時の重み) /
//             M1(ダッシュボード平均) / M6(提出物: 期限日欠席の除外)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node data-reflection.test.js            (全セクション)
//       cd tests && ONLY=H1 node data-reflection.test.js    (指定セクションのみ。カンマ区切りで複数可)
//
// 日付依存を避けるため、課題の学期は test.term / assignment.term の明示指定で固定する
// (grdItemTerm は term を最優先で参照する)。

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.indexOf(name) !== -1;

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
function evidence(label, obj) { console.log('EVIDENCE ' + label + ' :: ' + JSON.stringify(obj)); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);

    const KEYNAMES = await page.evaluate(() => ({
        master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores,
        assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data,
        att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds,
        ext: KEYS.grades_external
    }));
    const backup = {};
    for (const k of Object.values(KEYNAMES)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    // 全キーを与えて再読み込み(名簿はメモリ常駐のため reload 必須)
    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []);
            put(K.scores, d.scores || []);
            put(K.assigns, d.assigns || []);
            put(K.subs, d.subs || []);
            put(K.att, d.att || {});
            put(K.weights, d.weights || {});
            StorageManager.remove(K.thresholds);
            StorageManager.remove(K.ext);
        }, KEYNAMES, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
    }
    // ページ内の PDF/CSV/クリップボード出力をキャプチャ用にすり替える
    async function installCaptures() {
        await page.evaluate(() => {
            window.__pdfPages = null; window.__pdfOpts = null; window.__csv = null; window.__csvName = null; window.__clip = null;
            window.htmlPagesToPdf = function(pages, opts) { window.__pdfPages = pages; window.__pdfOpts = opts; return Promise.resolve(); };
            window.universalShare = function(blob, name) {
                window.__csvName = name;
                return blob.text().then(function(t) { window.__csv = t; });
            };
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
        });
    }
    const T = (o) => Object.assign({ id: 0, subject: '算数', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-05-10', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId: testId, score: score }, extra || {});

    try {
        // ============================================================
        // H1: 出力側で選んだ学期が、成績（評定・知思主）に反映されること
        // ============================================================
        if (want('H1')) {
            console.log('--- H1: カルテ出力/面談テキスト/成績CSVの学期 ---');
            // 児童0: 1学期=全観点A(評定3)、2学期=全観点C(評定1)。児童1はその逆。
            const tests = [
                T({ id: 1, name: '知1', category: '知識・技能', term: '1' }),
                T({ id: 2, name: '知2', category: '知識・技能', term: '2' }),
                T({ id: 3, name: '思1', category: '思考・判断・表現', term: '1', maxScore: 0, inputMode: 'abc5', testType: '記述問題' }),
                T({ id: 4, name: '思2', category: '思考・判断・表現', term: '2', maxScore: 0, inputMode: 'abc5', testType: '記述問題' }),
                T({ id: 5, name: '主1', category: '主体性', term: '1', maxScore: 0, inputMode: 'abc5' }),
                T({ id: 6, name: '主2', category: '主体性', term: '2', maxScore: 0, inputMode: 'abc5' })
            ];
            const scores = [
                S(1, 0, 100), S(1, 1, 20), S(2, 0, 20), S(2, 1, 100),
                S(3, 0, 'A'), S(3, 1, 'C'), S(4, 0, 'C'), S(4, 1, 'A'),
                S(5, 0, 'A'), S(5, 1, 'C'), S(6, 0, 'C'), S(6, 1, 'A')
            ];
            await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores });
            await installCaptures();

            const exp = await page.evaluate(() => ({
                t1: grdCalculate('算数', '1').map(r => String(r.hyoutei)),
                t2: grdCalculate('算数', '2').map(r => String(r.hyoutei)),
                all: grdCalculate('算数', 'all').map(r => String(r.hyoutei))
            }));
            check('前提: 学期1と学期2で児童0の評定が異なる', exp.t1[0] === '3' && exp.t2[0] === '1', JSON.stringify(exp));

            // 成績処理画面の学期を「2学期」にしたまま、カルテ出力で「1学期」を選ぶ
            await page.evaluate(() => {
                showView('grades');
                const g = document.getElementById('grdTermSel'); g.value = '2'; g.dispatchEvent(new Event('change'));
                showView('karte');
                kvSetMode('output');
            });
            await sleep(200);

            async function kvRender(term, design) {
                return page.evaluate((term, design) => {
                    window.__pdfPages = null;
                    const sel = document.getElementById('kvTermSel'); sel.value = term; sel.dispatchEvent(new Event('change'));
                    document.getElementById('kvSec_grades').checked = true;
                    document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === '0'); });
                    const r = document.querySelector('input[name="kvDesign"][value="' + design + '"]'); if (r) r.checked = true;
                    document.getElementById('kvPrintBtn').click();
                    const html = (window.__pdfPages || [])[0] || '';
                    const m1 = /font-size:18pt;font-weight:900;line-height:1;color:[^"]*">([^<]*)<\/div>/.exec(html);
                    const m2 = /background:#f9f9f9;font-size:10pt;font-weight:900;">([^<]*)<\/td>/.exec(html);
                    return { got: !!html, child: m1 && m1[1], teacher: m2 && m2[1] };
                }, term, design);
            }
            let r = await kvRender('1', 'child');
            check('H1 児童用PDF: 出力学期=1学期のとき評定は1学期の値(3)', r.got && r.child === exp.t1[0], 'got=' + r.child + ' expected=' + exp.t1[0] + '（成績画面=2学期）');
            r = await kvRender('2', 'child');
            check('H1 児童用PDF: 出力学期=2学期のとき評定は2学期の値(1)', r.got && r.child === exp.t2[0], 'got=' + r.child + ' expected=' + exp.t2[0]);
            r = await kvRender('all', 'child');
            check('H1 児童用PDF: 出力学期=通年のとき評定は通年の値', r.got && r.child === exp.all[0], 'got=' + r.child + ' expected=' + exp.all[0]);
            r = await kvRender('1', 'teacher');
            check('H1 教員用PDF: 出力学期=1学期のとき評定は1学期の値(3)', r.got && r.teacher === exp.t1[0], 'got=' + r.teacher + ' expected=' + exp.t1[0] + '（成績画面=2学期）');
            evidence('H1 PDF評定(出力=1学期/成績画面=2学期)', { expected: exp.t1[0], childActual: (await kvRender('1', 'child')).child });

            // 面談用テキスト
            await page.evaluate(() => {
                const sel = document.getElementById('kvTermSel'); sel.value = '1'; sel.dispatchEvent(new Event('change'));
                document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === '0'); });
                window.__clip = null;
                document.getElementById('kvCopyTextBtn').click();
            });
            await sleep(100);
            const clip = await page.evaluate(() => window.__clip || '');
            const line = (clip.match(/算数：知 [^\n]*/) || [''])[0];
            check('H1 面談用テキスト: 出力学期=1学期のとき成績行は1学期の値', /評定 3/.test(line), line);

            // 成績処理CSV: データ出力画面で学期を明示して出力できること
            await page.evaluate(() => { showView('export'); });
            await sleep(200);
            const csv1 = await page.evaluate(() => {
                window.__csv = null;
                const subj = document.getElementById('expGradeSubj'); subj.value = '算数';
                const term = document.getElementById('expGradeTerm');
                if (term) term.value = '1';
                document.getElementById('expGradeBtn').click();
                return { hasTermSel: !!term };
            });
            await sleep(200);
            const out = await page.evaluate(() => ({ csv: window.__csv || '', name: window.__csvName || '' }));
            const rows = out.csv.replace(/^﻿/, '').split('\n').map(l => l.split(','));
            const hi = rows[0] ? rows[0].indexOf('評定') : -1;
            check('H1 成績CSV: 学期セレクトがあり、1学期を選ぶと1学期の評定になる', csv1.hasTermSel && hi >= 0 && rows[1] && rows[1][hi] === exp.t1[0], 'hasTermSel=' + csv1.hasTermSel + ' 評定=' + (rows[1] && rows[1][hi]) + ' expected=' + exp.t1[0]);
            check('H1 成績CSV: ファイル名に学期が入る', /1学期/.test(out.name), out.name);
            check('H1 成績CSV: 学期列がある', rows[0] && rows[0].indexOf('学期') >= 0, rows[0] && rows[0].join('|'));
        }

        // ============================================================
        // H5: 成績処理を一度開いた後に入力したデータが、出力(カルテPDF・CSV)へ反映されること
        // (成績側キャッシュが showView('grades') でしか破棄されず、他画面での入力が古いまま残る)
        // ============================================================
        if (want('H5') || want('H1')) {
            console.log('--- H5: 成績キャッシュの古さ ---');
            const tests = [
                T({ id: 1, name: '知1', category: '知識・技能', term: '1' }),
                T({ id: 2, name: '思1', category: '思考・判断・表現', term: '1', maxScore: 0, inputMode: 'abc5', testType: '記述問題' }),
                T({ id: 3, name: '主1', category: '主体性', term: '1', maxScore: 0, inputMode: 'abc5' })
            ];
            const scores = [S(1, 0, 20), S(2, 0, 'C'), S(3, 0, 'C')];
            await seed({ students: [{ name: '甲' }], tests, scores });
            await installCaptures();
            const before = await page.evaluate(() => {
                showView('grades'); // ここで成績側キャッシュが作られる
                return String(grdCalculate('算数', '1')[0].hyoutei);
            });
            // 児童の記録画面で実際の保存関数(recSelectABC / 得点欄→blur)を使って入力し直す
            await page.evaluate(() => {
                showView('records'); recShowSub('input');
                window.recSelectTestGoto(2); window.recSelectABC(0, 'A');
                window.recSelectTestGoto(3); window.recSelectABC(0, 'A');
                window.recSelectTestGoto(1);
            });
            await sleep(150);
            await page.evaluate(() => {
                const inp = document.getElementById('rec-sc-0');
                if (inp) { inp.focus(); inp.value = '100'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.blur(); }
            });
            await sleep(150);
            const stored = await page.evaluate(() => JSON.parse(StorageManager.getRaw(KEYS.scores)).filter(s => s.studentIndex === 0).map(s => s.testId + ':' + s.score).join(','));
            check('前提: 記録画面の保存関数で点数が更新されている', /1:100/.test(stored) && /2:A/.test(stored) && /3:A/.test(stored), stored);
            // 成績処理は開かずに、カルテ出力へ
            await page.evaluate(() => {
                showView('karte'); kvSetMode('output');
                const sel = document.getElementById('kvTermSel'); sel.value = '1'; sel.dispatchEvent(new Event('change'));
                document.getElementById('kvSec_grades').checked = true;
                document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = true; });
                document.getElementById('kvPrintBtn').click();
            });
            const h5 = await page.evaluate(() => {
                const html = (window.__pdfPages || [])[0] || '';
                const m = /font-size:18pt;font-weight:900;line-height:1;color:[^"]*">([^<]*)<\/div>/.exec(html);
                return m && m[1];
            });
            check('H5 成績処理を開いた後に記録を更新 → カルテ出力は最新の評定(3)になる', h5 === '3', 'before(成績画面)=' + before + ' PDF評定=' + h5);
        }
        // ============================================================
        // H2: 汎用の実技記録を「思考・判断・表現」「主体性」に設定しても、知識・技能と同じ
        //     共通の換算関数(peRecordToScore10)で10点換算されること。実技ルーブリック/検定の計算は不変。
        // ============================================================
        if (want('H2')) {
            console.log('--- H2: 汎用の実技記録×観点 ---');
            const PE = (o) => T(Object.assign({ subject: '体育', testType: '実技記録', maxScore: 9999, term: '1' }, o));
            const tests = [
                PE({ id: 1, name: '点-思考', peUnit: '点', category: '思考・判断・表現' }),
                PE({ id: 2, name: '点-主体', peUnit: '点', category: '主体性' }),
                PE({ id: 3, name: '秒-思考', peUnit: '秒', category: '思考・判断・表現' }),
                PE({ id: 4, name: '点-知識', peUnit: '点', category: '知識・技能' }),
                PE({ id: 5, name: 'ルーブリック風', peUnit: '実技:mat', category: '知識・技能', peRubric: { items: [] } })
            ];
            const scores = [
                S(1, 0, 8), S(1, 1, 5), S(2, 0, 6), S(2, 1, 4), S(3, 0, 12.3), S(3, 1, 15.1),
                S(4, 0, 8), S(4, 1, 5),
                S(5, 0, '', { score10: 7.5 }), S(5, 1, '', { score10: 4 }),
                S(1, 2, 7, { absent: true })
            ];
            await seed({ students: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], tests, scores });
            const g = await page.evaluate(() => {
                const res = grdCalculate('体育', '1');
                const pick = (r, persp, name) => { const it = r[persp].items.find(x => x.name === name); return it ? it.score10 : 'なし'; };
                return res.map(r => ({
                    name: r.name,
                    thinkP: pick(r, 'thinking', '点-思考'), attP: pick(r, 'attitude', '点-主体'),
                    thinkSec: pick(r, 'thinking', '秒-思考'), knowP: pick(r, 'knowledge', '点-知識'),
                    rubric: pick(r, 'knowledge', 'ルーブリック風'),
                    thinkAvg: r.thinking.avg, attAvg: r.attitude.avg, knowAvg: r.knowledge.avg
                }));
            });
            evidence('H2 児童別の換算結果', g);
            check('H2 思考・判断・表現の実技記録(点): 甲=8, 乙=5（約0点にならない）', g[0].thinkP === 8 && g[1].thinkP === 5, '甲=' + g[0].thinkP + ' 乙=' + g[1].thinkP);
            check('H2 主体性の実技記録(点): 甲=6, 乙=4（abcTo10へ渡らない）', g[0].attP === 6 && g[1].attP === 4, '甲=' + g[0].attP + ' 乙=' + g[1].attP);
            check('H2 換算できない単位(秒)は思考でも未評価(null)で0点に混入しない', g[0].thinkSec === null && g[1].thinkSec === null, '甲=' + g[0].thinkSec + ' 乙=' + g[1].thinkSec);
            check('H2 思考の平均は換算できる項目のみ(甲=8)', g[0].thinkAvg === 8, String(g[0].thinkAvg));
            check('H2 欠席(丙)は実技記録でも未評価', g[2].thinkP === null, String(g[2].thinkP));
            check('H2 対照: 知識・技能の実技記録(点)は従来どおり 甲=8, 乙=5', g[0].knowP === 8 && g[1].knowP === 5, '甲=' + g[0].knowP + ' 乙=' + g[1].knowP);
            check('H2 実技ルーブリック(保存済score10)の値は不変: 甲=7.5, 乙=4', g[0].rubric === 7.5 && g[1].rubric === 4, '甲=' + g[0].rubric + ' 乙=' + g[1].rubric);
        }

        // ============================================================
        // H3: 課題の観点・教科を編集/削除しても、項目重み(spa_grade_weights)が追従すること
        //     (重みキーは [教科][観点][k_/t_/a_ + testId]。追従しないと既定値1に戻り成績値が変わる)
        // ============================================================
        if (want('H3')) {
            console.log('--- H3: 観点/教科の変更・削除と項目重み ---');
            const mkTests = () => [
                T({ id: 1, name: '重み2の課題', category: '知識・技能', term: '1' }),
                T({ id: 2, name: '対照の課題', category: '知識・技能', term: '1' })
            ];
            const mkScores = () => [S(1, 0, 100), S(2, 0, 50)];
            const mkWeights = () => ({ '算数': { knowledge: { k_1: 2, k_2: 0.5 } } });
            const readW = () => page.evaluate(() => JSON.parse(StorageManager.getRaw(KEYS.grade_weights) || '{}'));
            const editViaForm = (id, changes) => page.evaluate((id, changes) => {
                showView('records'); recShowSub('tests');
                recEditTest(id);
                if (changes.subject) document.getElementById('recTestSubject').value = changes.subject;
                if (changes.category) { document.getElementById('recTestCategory').value = changes.category; recOnCategoryChange(); }
                recAddTest();
            }, id, changes);

            // (a) 観点を 知識・技能 → 思考・判断・表現 に変更
            await seed({ students: [{ name: '甲' }], tests: mkTests(), scores: mkScores(), weights: mkWeights() });
            await page.evaluate(() => { showView('grades'); grdCalculate('算数', '1'); }); // 成績側キャッシュを作っておく
            await editViaForm(1, { category: '思考・判断・表現' });
            let w = await readW();
            check('H3 観点変更: 新しい観点キー t_1 に重み2が移る', w['算数'] && w['算数'].thinking && w['算数'].thinking.t_1 === 2, JSON.stringify(w));
            check('H3 観点変更: 旧キー k_1 は残らない(孤立しない)', !(w['算数'] && w['算数'].knowledge && w['算数'].knowledge.k_1 !== undefined), JSON.stringify(w['算数'] && w['算数'].knowledge));
            check('H3 観点変更: 変更していない課題(k_2)の重みは不変', w['算数'] && w['算数'].knowledge && w['算数'].knowledge.k_2 === 0.5, JSON.stringify(w['算数'] && w['算数'].knowledge));
            const gw = await page.evaluate(() => {
                const r = grdCalculate('算数', '1')[0];
                const it = r.thinking.items.find(x => x.itemKey === 't_1'); // 編集保存で課題名に自動プレフィックスが付くため itemKey で探す
                return it ? it.weight : 'なし';
            });
            evidence('H3 観点変更後の成績側の重み', { expected: 2, actual: gw });
            check('H3 観点変更: 成績処理が読む重みも2のまま(既定値1に戻らない)', gw === 2, String(gw));

            // (b) 教科を 算数 → 理科 に変更(観点は知識・技能のまま)
            await seed({ students: [{ name: '甲' }], tests: mkTests(), scores: mkScores(), weights: mkWeights() });
            await editViaForm(1, { subject: '理科' });
            w = await readW();
            check('H3 教科変更: 理科の知識・技能 k_1 に重み2が移る', w['理科'] && w['理科'].knowledge && w['理科'].knowledge.k_1 === 2, JSON.stringify(w));
            check('H3 教科変更: 算数側の旧キー k_1 は残らない', !(w['算数'] && w['算数'].knowledge && w['算数'].knowledge.k_1 !== undefined), JSON.stringify(w['算数']));

            // (c) 保存しただけ(観点・教科は同じ)なら重みは不変
            await seed({ students: [{ name: '甲' }], tests: mkTests(), scores: mkScores(), weights: mkWeights() });
            await editViaForm(1, {});
            w = await readW();
            check('H3 観点・教科を変えずに保存: 重み2は不変', w['算数'] && w['算数'].knowledge && w['算数'].knowledge.k_1 === 2 && w['算数'].knowledge.k_2 === 0.5, JSON.stringify(w));

            // (d) 課題の削除で重みキーも掃除される
            await seed({ students: [{ name: '甲' }], tests: mkTests(), scores: mkScores(), weights: mkWeights() });
            await page.evaluate(() => { showView('records'); recShowSub('tests'); recDeleteTest(1); });
            w = await readW();
            check('H3 課題削除: 削除した課題の重みキー k_1 は残らない', !(w['算数'] && w['算数'].knowledge && w['算数'].knowledge.k_1 !== undefined), JSON.stringify(w['算数'] && w['算数'].knowledge));
            check('H3 課題削除: 他の課題の重み k_2 は残る', w['算数'] && w['算数'].knowledge && w['算数'].knowledge.k_2 === 0.5, JSON.stringify(w['算数'] && w['算数'].knowledge));
        }

        // ============================================================
        // M1: ダッシュボードの「テスト平均」が成績処理統合と同じ集計(欠席・学期・入力形式・遅れ係数)であること
        // ============================================================
        if (want('M1')) {
            console.log('--- M1: ダッシュボード テスト平均 ---');
            // 現在学期は実行日で決まるため、現在学期=cur / 別学期=other を実行時に決めて課題に明示する
            const curTerm = await page.evaluate(() => grdGetCurrentTerm());
            const other = curTerm === '1' ? '2' : '1';
            const tests = [
                T({ id: 1, name: '知-通常', category: '知識・技能', term: curTerm }),
                T({ id: 2, name: '知-欠席', category: '知識・技能', term: curTerm }),
                T({ id: 3, name: '主-得点方式', category: '主体性', term: curTerm, maxScore: 10, inputMode: 'score' }),
                T({ id: 4, name: '知-別学期', category: '知識・技能', term: other }),
                T({ id: 5, name: '思-5段階', category: '思考・判断・表現', term: curTerm, maxScore: 0, inputMode: 'abc5', testType: '記述問題' }),
                T({ id: 6, name: '知-遅れ提出', category: '知識・技能', term: curTerm })
            ];
            const scores = [
                S(1, 0, 80), S(2, 0, 100, { absent: true }), S(3, 0, 6), S(4, 0, 20), S(5, 0, 'A'), S(6, 0, 100, { lateSubmit: true })
            ];
            await seed({ students: [{ name: '甲' }], tests, scores });
            // 期待: 現在学期の 80→8.0 / 主体性得点 6 / 5段階A→10 / 遅れ100→8.0 の平均=8.0。
            //       欠席・別学期は含めない。
            const dash = await page.evaluate(() => {
                showView('dashboard');
                selectDashStudent(0);
                const rows = Array.from(document.querySelectorAll('#dashStudentKarte > .card > div'));
                const row = rows.find(r => /テスト平均/.test(r.textContent));
                return row ? row.textContent.replace(/\s+/g, ' ').trim() : '(行なし)';
            });
            evidence('M1 ダッシュボード表示', { expected: '8.0/10 ・ 4件', actual: dash });
            check('M1 テスト平均=8.0/10（欠席・別学期を除外、主体性得点方式・5段階・遅れ係数を反映）', /8\.0\/10/.test(dash), dash);
            check('M1 入力済み件数=4件', /4件/.test(dash), dash);
        }

        // ============================================================
        // M6: 期限日に欠席かつ未提出の提出物は、提出率の分母から除外する(全経路で同じ判定)。
        //     後日提出された場合は「提出」として数え、遅延提出には判定しない。
        //   甲: a1○ a2○                           → 100%
        //   乙: a1=期限日に欠席(出席簿×)・記録なし(除外) a2○ → 1/1
        //   丙: a1=欠席フラグ+未提出(除外)        a2 未提出 → 0/1
        //   丁: a1=期限日欠席だが後日提出(遅れ印つき) a2=再提出(お直し前0.8)
        // ============================================================
        if (want('M6')) {
            console.log('--- M6: 期限日欠席の提出物 ---');
            const A1 = 'a1日', A2 = 'a2日';
            const assigns = [
                { id: 101, subject: '算数', name: '宿題1', date: '2026-05-10', term: '1', createdAt: '2026-05-01T00:00:00Z' },
                { id: 102, subject: '算数', name: '宿題2', date: '2026-05-11', term: '1', createdAt: '2026-05-01T00:00:00Z' }
            ];
            const R = (id, i, a, status, extra) => Object.assign({ id: id, studentIndex: i, assignmentId: a, status: status, correctionDone: status === 'submitted', createdAt: '2026-05-12T00:00:00Z' }, extra || {});
            const subs = [
                R(1, 0, 101, 'submitted'), R(2, 0, 102, 'submitted'),
                R(3, 1, 102, 'submitted'),
                R(4, 2, 101, 'missing', { absent: true }),
                R(5, 3, 101, 'submitted', { lateOnDue: true }), R(6, 3, 102, 'resubmit', { correctionDone: false })
            ];
            const att = { '2026-05-10': { '1': '×', '3': '×' } };
            const names = ['甲', '乙', '丙', '丁'];
            await seed({ students: names.map(n => ({ name: n })), assigns, subs, att });
            await installCaptures();

            // --- 成績処理統合(提出物の10点換算) ---
            const grade = await page.evaluate(() => grdCalculate('算数', '1').map(r => {
                const it = r.attitude.items.find(x => x.itemKey === 'submission');
                return it ? { s10: it.score10, detail: it.detail } : null;
            }));
            evidence('M6 成績処理の提出物10点 [甲,乙,丙,丁]', grade.map(g => g && g.s10));
            check('M6 成績: 甲=10, 乙=10(欠席分を除外), 丙=0, 丁=9(後日提出は1.0・再提出0.8)', grade[0].s10 === 10 && grade[1].s10 === 10 && grade[2].s10 === 0 && grade[3].s10 === 9, JSON.stringify(grade.map(g => g && g.s10)));

            // --- 提出物画面 統計タブ ---
            const stats = await page.evaluate(() => {
                showView('submissions');
                const t = document.getElementById('subTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
                document.querySelector('.sub-subnav-btn[data-sub="stats"]').click();
                const rows = Array.from(document.querySelectorAll('#subStudentStats .sub-student-row')).map(r => {
                    const b = r.querySelector('.sub-stu-badges');
                    const pctEl = b && b.querySelector('span:last-child');   // 「×1」と「50%」を連結して誤読しないよう要素で取る
                    const ngEl = b && b.querySelector('.sub-badge.ng');
                    return { pct: pctEl ? parseInt(pctEl.textContent, 10) : null, ng: ngEl ? parseInt(ngEl.textContent.replace('×', ''), 10) : null };
                });
                const cards = {};
                document.querySelectorAll('#subStatsCards .sub-stat-card').forEach(c => { cards[(c.querySelector('.sub-stat-label') || {}).textContent] = (c.querySelector('.sub-stat-val') || {}).textContent; });
                return { rows, cards };
            });
            evidence('M6 統計タブ 児童別% [甲,乙,丙,丁]', stats.rows.map(r => r.pct));
            check('M6 提出物統計(児童別): 100/100/0/90%', stats.rows.map(r => r.pct).join() === '100,100,0,90', stats.rows.map(r => r.pct).join());
            check('M6 提出物統計(児童別): 乙・丙の欠席分は未提出×に数えない(×0 / ×1)', stats.rows[1].ng === 0 && stats.rows[2].ng === 1, '乙×' + stats.rows[1].ng + ' 丙×' + stats.rows[2].ng);
            check('M6 提出物統計(クラス): 提出率80%（credit4.8÷対象6）', stats.cards['提出率'] === '80%', stats.cards['提出率']);

            // --- 提出物画面 入力タブの進捗(宿題1) ---
            const prog = await page.evaluate(() => {
                document.querySelector('.sub-subnav-btn[data-sub="input"]').click();
                const sel = document.getElementById('subInputAssignSel'); sel.value = '101'; sel.dispatchEvent(new Event('change'));
                return (document.getElementById('subProgressLabel') || {}).textContent;
            });
            check('M6 入力タブ進捗(宿題1): 提出2÷対象2=100%', prog === '100%', prog);

            // --- 個人カルテ 概要 ---
            const karte = [];
            for (let i = 0; i < 4; i++) {
                karte.push(await page.evaluate((i) => {
                    showView('karte'); kvSetMode('view');
                    const t = document.getElementById('karteTermSel'); t.value = 'all'; t.dispatchEvent(new Event('change'));
                    selectKarteStudent(i);
                    const c = document.getElementById('karteSummaryContent');
                    const rate = (c.querySelector('.ks-card.submission .ks-card-value') || {}).textContent;
                    return { rate: rate, late: /提出遅れ/.test(c.textContent), miss: (/未提出：(\d+)件/.exec(c.textContent) || [])[1] || '0' };
                }, i));
            }
            evidence('M6 個人カルテ提出率 [甲,乙,丙,丁]', karte.map(k => k.rate));
            check('M6 個人カルテ 提出率: 100/100/0/100%', karte.map(k => k.rate).join() === '100%,100%,0%,100%', karte.map(k => k.rate).join());
            check('M6 個人カルテ: 丁(期限日欠席の後日提出)は提出遅れにならない', karte[3].late === false, String(karte[3].late));
            check('M6 個人カルテ: 乙の未提出は0件・丙は1件(欠席分は数えない)', karte[1].miss === '0' && karte[2].miss === '1', '乙' + karte[1].miss + ' 丙' + karte[2].miss);

            // --- PDF個票の提出状況(calcSubmissionStats) ---
            const pdf = await page.evaluate((assigns, subs) => [0, 1, 2, 3].map(i => {
                const st = calcSubmissionStats(i, assigns, subs);
                return { rate: st.rate, labels: st.rows.map(r => r.label).join('/') };
            }), assigns, subs);
            evidence('M6 PDF提出率 [甲,乙,丙,丁]', pdf.map(x => x.rate));
            check('M6 PDF個票 提出率: 100/100/0/100%', pdf.map(x => x.rate).join() === '100%,100%,0%,100%', pdf.map(x => x.rate).join());
            check('M6 PDF個票: 乙の宿題1は「欠席(対象外)」表示で★未提出にならない', /対象外/.test(pdf[1].labels) && !/★未提出/.test(pdf[1].labels.split('/')[0]), pdf[1].labels);

            // --- 面談用テキスト ---
            await page.evaluate(() => {
                showView('karte'); kvSetMode('output');
                document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = true; });
                window.__clip = null; document.getElementById('kvCopyTextBtn').click();
            });
            await sleep(100);
            const clip = await page.evaluate(() => window.__clip || '');
            const conf = names.map(n => { const m = new RegExp('氏名：' + n + '[\\s\\S]*?【提出物（(\\d+)%）】').exec(clip); return m ? m[1] : '?'; });
            evidence('M6 面談テキスト提出率 [甲,乙,丙,丁]', conf);
            check('M6 面談テキスト 提出率: 100/100/0/100%', conf.join() === '100,100,0,100', conf.join());

            // --- ダッシュボード ---
            const dash = await page.evaluate(() => {
                showView('dashboard');
                const cls = (document.getElementById('statSubmission') || {}).textContent;
                const one = [];
                for (let i = 0; i < 4; i++) {
                    selectDashStudent(i);
                    const row = Array.from(document.querySelectorAll('#dashStudentKarte > .card > div')).find(r => /提出率/.test(r.textContent));
                    one.push(row ? (/(\d+)%/.exec(row.textContent) || [])[1] : '?');
                }
                return { cls: cls, one: one };
            });
            evidence('M6 ダッシュボード 児童別 [甲,乙,丙,丁] / クラス', { one: dash.one, cls: dash.cls });
            check('M6 ダッシュボード(児童): 100/100/0/100%', dash.one.join() === '100,100,0,100', dash.one.join());
            check('M6 ダッシュボード(クラス): 80%（(提出4+再提出1×0.8)÷対象6）', dash.cls === '80%', dash.cls);

            // --- データ出力 提出物CSV ---
            await page.evaluate(() => { showView('export'); });
            await sleep(200);
            const csv = await page.evaluate(() => {
                window.__csv = null;
                const subj = document.getElementById('expSubSubj'); if (subj) subj.value = '算数';
                document.getElementById('expSubBtn').click();
                return null;
            });
            await sleep(200);
            const csvText = await page.evaluate(() => (window.__csv || '').replace(/^\uFEFF/, ''));
            const rows = csvText.split('\n').map(l => l.split(','));
            const cell = (i, a) => (rows[i + 1] || [])[2 + a];
            evidence('M6 CSV 宿題1列 [甲,乙,丙,丁]', [0, 1, 2, 3].map(i => cell(i, 0)));
            check('M6 提出物CSV: 乙・丙の宿題1は「欠席」、丁は後日提出(submitted)', cell(1, 0) === '欠席' && cell(2, 0) === '欠席' && cell(3, 0) === 'submitted' && cell(0, 0) === 'submitted', [0, 1, 2, 3].map(i => cell(i, 0)).join('/'));
            check('M6 提出物CSV: 未提出(丙の宿題2)はmissingでなく空欄の従来表記のまま', cell(2, 1) === '', String(cell(2, 1)));
        }

    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        // 実データの復元
        for (const k of Object.keys(backup)) {
            await page.evaluate((kk, raw) => {
                if (raw === null || raw === undefined) StorageManager.remove(kk); else StorageManager.setImmediate(kk, raw);
            }, k, backup[k]);
        }
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== data-reflection: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
