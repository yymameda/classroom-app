// L7 案C(v1.60.4): 監査診断が、主体性(得点方式)の課題にある「空文字・数字でない文字」の記録を数えて「情報」に出す。
//   背景(調査 2026-09-20): 主体性の得点方式は、score が空文字なら0点、数字でない文字なら計算不能(NaN)として成績に入る。
//   空文字は「欠席→解除」の操作で残る。今までの診断は空文字を数えられなかった(null・欠損と合算)。
//   あわせて、数字の文字列("8")は成績が数値と同じになる(JavaScript が数値に読む)のに、「成績に正しく入っていない」と数えていた過大を直す。
//   診断は読み取り専用。成績画面の評定・観点別の値は変えない(各ケースで変更前の値を固定して確かめる)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node audit-attitude-scorestr.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 変更前の成績(この題材。国語・1学期): [名前, 主体性平均, 主体性ABC, 評定]。空文字の丙・丁は0点、"8点"の戊・"A"の己はNaN→C(JSON では null)。案Aは実装しないので、このまま。
const EXPECT_GRADE = '[["甲",7.7,"B",""],["乙",7,"B",""],["丙",0,"C",""],["丁",5,"B",""],["戊",null,"C",""],["己",null,"C",""],["庚",null,"",""],["辛",null,"",""]]';

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol }));

    const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score }, extra || {});

    async function seed(tests, scores, weights) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.names.map(n => ({ name: n })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests); put(K.scores, d.scores); put(K.assigns, []); put(K.subs, []);
            put(K.att, {}); put(K.weights, d.weights || {}); put(K.patrol, []);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, K, { names: NAMES, tests, scores, weights: weights || {} });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
    }
    // 診断を実行し、結果と、画面の表示・コピー用テキストを取り出す(実際の「診断を実行」の経路: runAuditDiagnosis → renderAuditResult / copyAuditResultAsText)
    async function audit() {
        return page.evaluate(async () => {
            showView('settings');
            window.__clip = null;
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__clip = t; return Promise.resolve(); } } });
            runAuditDiagnosis();
            await new Promise(r => setTimeout(r, 1500));
            const r = window._auditDiagnosisLastResult;
            copyAuditResultAsText();
            await new Promise(r => setTimeout(r, 200));
            const box = document.querySelector('[id*="audit"][id*="esult"]');
            return { si: r.structuralIntegrity, an: r.anomalies, screen: box ? box.innerText.replace(/\s+/g, ' ') : '', copy: window.__clip || '' };
        });
    }
    const gradeSnap = () => page.evaluate(() => JSON.stringify(grdCalculate('国語', '1').map(r => [r.name, r.attitude.avg, r.attitude.abc, r.hyoutei])));

    // ---- 題材 ----
    // 国語: ノート点(主体性・得点方式 id3) = 甲:8(数値) 乙:"8"(数字の文字列) 丙:"" 丁:"" 戊:"8点" 己:"A" 庚:欠席(score "") 辛:null
    //       発言(主体性・5段階 id4)   = 丙:"" 丁:"A"           ← 5段階は対象外
    //       漢字(知識・技能 id1)       = 丙:""                  ← 知識・技能は対象外(空文字は未評価として読まれる)
    //       音読(主体性・得点方式 id5) = 甲:"4" 乙:"3"          ← 数字の文字列だけ(成績は数値と同じ。数えない)
    //       係活動(主体性・得点方式 id6)= 全員数値                ← 出さない
    //       授業態度(主体性 id7・入力形式は得点方式に固定) = 丙:""   ← 授業態度は対象外(種別で除く)
    // 算数: 宿題への取り組み(主体性・得点方式 id8) = 甲:"" 乙:"" 丙:"" 辛:" "(空白だけ)   ← 丙は国語のノート点にもいる(全体の児童数では1人と数える)。空白だけも空文字と同じ0点
    const tests = [
        T({ id: 1, name: '漢字' }),
        T({ id: 3, name: 'ノート点', category: '主体性', maxScore: 10, inputMode: 'score' }),
        T({ id: 4, name: '発言', category: '主体性', maxScore: 0, inputMode: 'abc5' }),
        T({ id: 5, name: '音読', category: '主体性', maxScore: 5, inputMode: 'score' }),
        T({ id: 6, name: '係活動', category: '主体性', maxScore: 10, inputMode: 'score' }),
        T({ id: 7, name: '授業態度', testType: '授業態度', category: '主体性', maxScore: 10, inputMode: 'score' }),
        T({ id: 8, subject: '算数', name: '宿題への取り組み', category: '主体性', maxScore: 10, inputMode: 'score' })
    ];
    const scores = [
        S(3, 0, 8), S(3, 1, '8'), S(3, 2, ''), S(3, 3, ''), S(3, 2, '', { id: 399 }), S(3, 4, '8点'), S(3, 5, 'A'), S(3, 6, '', { absent: true }), S(3, 7, null),
        S(4, 2, ''), S(4, 3, 'A'),
        S(1, 2, ''),
        S(5, 0, '4'), S(5, 1, '3'),
        S(6, 0, 7), S(6, 1, 7),
        S(7, 2, ''),
        S(8, 0, ''), S(8, 1, ''), S(8, 2, ''), S(8, 7, ' ')
    ];

    try {
        await seed(tests, scores);
        const G0 = await gradeSnap();
        const a = await audit();
        const si = a.si;
        const det = (id) => (si.attitudeScoreStrDetail || []).find(d => d.testId === id);

        // ============ 1. 件数(課題ごと・児童数) ============
        check('主体性(得点方式)の課題で、空文字・数字でない文字の記録がある課題は2つ(ノート点・宿題への取り組み)', si.attitudeScoreStrTests === 2 && !!det(3) && !!det(8), JSON.stringify(si.attitudeScoreStrDetail));
        check('ノート点: 空文字3件(丙が2件・丁)・数字でない文字2件("8点"・"A")・児童4人(同じ児童の2件は1人)', det(3) && det(3).emptyCount === 3 && det(3).textCount === 2 && det(3).studentCount === 4, JSON.stringify(det(3)));
        check('宿題への取り組み(算数): 空文字4件(空白だけの辛を含む)・数字でない文字0件・児童4人。教科・課題名が入る', det(8) && det(8).emptyCount === 4 && det(8).textCount === 0 && det(8).studentCount === 4 && det(8).subject === '算数' && det(8).name === '宿題への取り組み', JSON.stringify(det(8)));
        check('合計: 記録9件・児童7人(甲乙丙丁戊己辛)。2課題に出る丙は1人と数える', si.attitudeScoreStrRecords === 9 && si.attitudeScoreStrStudents === 7, si.attitudeScoreStrRecords + '件・' + si.attitudeScoreStrStudents + '人');
        check('数字の文字列("8"・"4"・"3")は数えない(音読は出ない)', !det(5), JSON.stringify(det(5)));
        check('数えない: 5段階の課題(発言)・知識・技能(漢字)・授業態度・全員数値の課題(係活動)・欠席の記録・null', !det(4) && !det(1) && !det(7) && !det(6), Object.keys(si.attitudeScoreStrDetail || []).join());

        // ============ 2. 表示: 情報(参考)・構造的整合性の表・コピー用テキスト ============
        const infoLines = a.an.info.filter(m => /ノート点|宿題への取り組み/.test(m) && /主体性/.test(m));
        check('「情報」に、課題ごとの行が2つ出る(課題名・教科・空文字と文字の件数・児童数)', infoLines.length === 2 && infoLines.some(m => /ノート点/.test(m) && /空文字3件/.test(m) && /文字2件/.test(m) && /4人/.test(m)) && infoLines.some(m => /宿題への取り組み/.test(m) && /算数/.test(m) && /空文字4件/.test(m) && /4人/.test(m)), JSON.stringify(infoLines));
        check('  → 成績への入り方(空文字は0点・数字でない文字は計算不能)を、やさしく説明している', infoLines.every(m => /0点/.test(m)) && infoLines.some(m => /観点C|計算できず|計算不能/.test(m)), infoLines[0]);
        check('構造的整合性の表に「主体性(得点方式)の空欄・文字の記録」の行があり、9件・課題2件・児童7人と出る', /主体性（得点方式）の空欄・文字の記録[^。]{0,10}9件（課題2件・児童7人/.test(a.screen), (a.screen.match(/主体性（得点方式）の空欄・文字の記録.{0,60}/) || ['(なし)'])[0]);
        check('コピー用テキストの「情報(参考)」にも同じ行が入る。構造的整合性の行もある', /情報\(参考\):[\s\S]*ノート点[\s\S]*空文字3件/.test(a.copy) && /主体性（得点方式）の空欄・文字の記録: 9件（課題2件・児童7人）/.test(a.copy), (a.copy.match(/主体性（得点方式）の空欄・文字の記録.{0,30}/) || ['(なし)'])[0]);

        // ============ 3. 数字の文字列("8")は「成績に正しく入っていない」に数えない ============
        const c3 = (si.inputModeConflictDetail || []).find(d => d.testId === 3);
        check('入力形式の矛盾(scorestr)のノート点: 成績に正しく入っていない児童は2人("8点"の戊・"A"の己)。"8"の乙は数えない', c3 && c3.kind === 'scorestr' && c3.gradeAffectedStudents === 2 && c3.invalid5Scores === 2, JSON.stringify(c3));
        check('数字の文字列だけの課題(音読)は、入力形式の矛盾に出ない(矛盾はノート点と、空白だけの記録がある宿題の2件。空白だけの扱いは今までどおり)', !(si.inputModeConflictDetail || []).some(d => d.testId === 5) && (si.inputModeConflictDetail || []).map(d => d.testId).sort().join() === '3,8', (si.inputModeConflictDetail || []).map(d => d.testId).join());

        // ============ 3.5 重み0の課題は「成績には入りません」と添える ============
        await seed([T({ id: 8, subject: '算数', name: '宿題への取り組み', category: '主体性', maxScore: 10, inputMode: 'score' })], [S(8, 0, '')], { 算数: { attitude: { a_8: 0 } } });
        const w0 = await audit();
        check('重み0の課題: 情報の行に「重み0のため、成績には入りません」と添える(件数は数える)', w0.si.attitudeScoreStrRecords === 1 && w0.an.info.some(m => /宿題への取り組み/.test(m) && /重み0のため、成績には入りません/.test(m)), JSON.stringify(w0.an.info));

        // ============ 4. 空文字だけの端末: 注意・総合判定は変えず、情報にだけ出る ============
        await seed([T({ id: 8, subject: '算数', name: '宿題への取り組み', category: '主体性', maxScore: 10, inputMode: 'score' })], [S(8, 0, ''), S(8, 1, '')]);
        const b = await audit();
        check('空文字だけのとき: 総合判定は「致命的問題なし」のまま(注意に出さない)・情報にだけ出る', /致命的問題なし/.test(b.an.overallStatus) && b.an.warn.length === 0 && b.an.info.some(m => /宿題への取り組み/.test(m)), b.an.overallStatus + ' warn=' + JSON.stringify(b.an.warn));

        // ============ 5. 0件の端末: 表に「0件」が出る(先生が「0件なら OK」と見分けられる)・情報には出ない ============
        await seed([T({ id: 6, name: '係活動', category: '主体性', maxScore: 10, inputMode: 'score' })], [S(6, 0, 7), S(6, 1, 9)]);
        const z = await audit();
        check('該当なしのとき: 構造的整合性の表に「主体性(得点方式)の空欄・文字の記録」が「0件」と出る・情報には出ない', z.si.attitudeScoreStrTests === 0 && z.si.attitudeScoreStrRecords === 0 && /主体性（得点方式）の空欄・文字の記録[^。]{0,20}0件/.test(z.screen) && !z.an.info.some(m => /主体性/.test(m) && /空文字/.test(m)), (z.screen.match(/主体性（得点方式）の空欄・文字の記録.{0,40}/) || ['(なし)'])[0]);

        // ============ 6. 成績は変わらない(診断は読み取り専用) ============
        await seed(tests, scores);
        const G1 = await gradeSnap();
        await audit();
        const G2 = await gradeSnap();
        check('成績画面の主体性・評定: 診断の実行の前後で同じ', G1 === G2, G2);
        check('成績画面の主体性・評定: 変更前の値と完全に同じ(数値・"8"は8、""は0、文字はNaN→C。案Aは実装していない)', G1 === G0 && G0 === EXPECT_GRADE, G0);

        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));
    } catch (e) {
        check('テスト実行中に例外なし', false, String(e && e.stack || e));
    }
    await browser.close();
    const failed = results.filter(r => !r.pass).length;
    console.log('\n合計 ' + results.length + ' 件 / 成功 ' + (results.length - failed) + ' / 失敗 ' + failed);
    process.exit(failed ? 1 : 0);
})();

