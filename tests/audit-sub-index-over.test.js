// L5 案D(v1.60.4): 監査診断が、提出記録の「範囲外の studentIndex」(名簿の人数を超える番号・負の番号)を数えて表示する。
//   背景(調査 2026-09-20): 名簿を減らす操作は今は必ず退避される(範囲外の記録は残らない)が、過去の版で取り残された記録があると、
//   提出物統計の課題別の人数・課題カードの○△×が、名簿より多く出ることがある。診断は得点の範囲外(studentIndexOver)は数えていたが、
//   提出記録の範囲外は数えていなかった(orphan 提出記録は「課題のない記録」で別物)。
//   診断は読み取り専用。総合判定(致命的問題なし／注意)は変えず、「情報」に出す。成績・提出率の値は変えない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node audit-sub-index-over.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 変更前の課題カードの○△×(課題管理・1学期): 範囲外の記録も含めて数えている(宿題Aは名簿6人を超えて○11)。案E(名簿の人数までに絞る)は今回入れないので、このまま
const EXPECT_CARDS = '📅 5/18 ○7 △3 ×0 | 📅 5/11 ○11 △0 ×0';
// 変更前の成績(国語・1学期): [名前, 知識平均, 提出物の10点換算, 評定]。範囲外の提出記録・得点があっても、名簿の6名の値は同じ
const EXPECT_GRADE = '[["甲",8,10,""],["乙",8,9,""],["丙",8,10,""],["丁",8,9,""],["戊",8,10,""],["己",8,9,""]]';

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol }));

    const NAMES = ['甲', '乙', '丙', '丁', '戊', '己'];
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const tests = [T({ id: 1, name: '漢字' })];
    const scoresOk = NAMES.map((n, i) => ({ id: 10 + i, studentIndex: i, testId: 1, score: 8 }));
    const assigns = [{ id: 101, subject: '国語', name: '宿題A', date: '2026-05-11', term: '1', createdAt: '2026-05-01T00:00:00Z' }, { id: 102, subject: '国語', name: '宿題B', date: '2026-05-18', term: '1', createdAt: '2026-05-02T00:00:00Z' }];
    const subsOk = [];
    NAMES.forEach((n, i) => { subsOk.push({ id: 100 + i, studentIndex: i, assignmentId: 101, status: 'submitted', createdAt: '2026-05-12T00:00:00Z' }); subsOk.push({ id: 200 + i, studentIndex: i, assignmentId: 102, status: i % 2 ? 'resubmit' : 'submitted', createdAt: '2026-05-19T00:00:00Z' }); });
    const SB = (id, idx, aid) => ({ id, studentIndex: idx, assignmentId: aid, status: 'submitted', createdAt: '2026-05-12T00:00:00Z' });

    async function seed(scores, subs) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.names.map(n => ({ name: n })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests); put(K.scores, d.scores); put(K.assigns, d.assigns); put(K.subs, d.subs);
            put(K.att, {}); put(K.weights, {}); put(K.patrol, []);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, K, { names: NAMES, tests, scores, assigns, subs });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
    }
    // 実際の「診断を実行」の経路(runAuditDiagnosis → renderAuditResult / copyAuditResultAsText)
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
    const gradeSnap = () => page.evaluate(() => JSON.stringify(grdCalculate('国語', '1').map(r => [r.name, r.knowledge.avg, (r.attitude.items.find(x => x.type === '提出物') || {}).score10, r.hyoutei])));

    // 範囲外の提出記録: 6・7番(宿題A)・9・6番(宿題B。6は2件目)・10番・負の -1・文字列の "8"(数字の文字列でも番号として読める)。範囲内の "3"(文字列)・番号なしは数えない
    //   → 記録7件・番号は6種類(-1, 6, 7, 8, 9, 10。10が一桁の番号より後ろに並ぶことで、数字の順に並べていることを確かめる)
    const straySubs = [SB(901, 6, 101), SB(902, 7, 101), SB(903, 9, 102), SB(904, -1, 101), SB(905, '8', 102), SB(906, '3', 101), { id: 907, assignmentId: 101, status: 'submitted' }, SB(908, 10, 102), SB(909, 6, 102)];
    const strayScores = [{ id: 991, studentIndex: 6, testId: 1, score: 10 }, { id: 992, studentIndex: 7, testId: 1, score: 10 }];

    try {
        await seed(scoresOk.concat(strayScores), subsOk.concat(straySubs));
        const G0 = await gradeSnap();
        const a = await audit();
        const si = a.si;

        // ============ 1. 数える ============
        check('提出記録の範囲外: 7件(6・7・9・6・10・-1・"8")。範囲内の"3"・番号のない記録は数えない', si.subIndexOver === 7, String(si.subIndexOver));
        check('範囲外の番号の一覧(数字の小さい順・重複なし・6種類): -1, 6, 7, 8, 9, 10', JSON.stringify(si.subIndexOverValues) === '[-1,6,7,8,9,10]' && si.subIndexOverValueCount === 6, JSON.stringify(si.subIndexOverValues));
        check('得点の範囲外(studentIndexOver)は今までどおり別に数える(2件)。提出記録の件数と混ざらない', si.studentIndexOver === 2 && si.subIndexOver === 7, si.studentIndexOver + ' / ' + si.subIndexOver);
        check('orphan 提出記録(課題のない記録)は別のまま0件', si.subOrphans === 0, String(si.subOrphans));

        // ============ 2. 表示: 情報(参考)・構造的整合性の表・コピー用テキスト ============
        const info = a.an.info.filter(m => /提出記録/.test(m) && /範囲外/.test(m));
        check('「情報」に1行出る(件数・名簿の人数・範囲外の番号)', info.length === 1 && /7件/.test(info[0]) && /6名/.test(info[0]) && /-1/.test(info[0]) && /9/.test(info[0]), JSON.stringify(info));
        check('  → 成績・提出率には入らないこと、課題ごとの人数の表示が名簿より多く出ることがあることを、やさしく説明している', /成績・提出率[^。]*入りません|成績・提出率の数字には入りません/.test(info[0] || '') && /課題ごとの人数/.test(info[0] || ''), info[0]);
        check('構造的整合性の表に「提出記録の studentIndex 範囲超過」の行があり、7件と出る', /提出記録の studentIndex 範囲超過[^。]{0,10}7件/.test(a.screen), (a.screen.match(/提出記録の studentIndex 範囲超過.{0,40}/) || ['(なし)'])[0]);
        check('コピー用テキストの構造的整合性にも行があり、情報(参考)にも入る', /提出記録の studentIndex 範囲超過: 7件 \(児童数:6\)/.test(a.copy) && /情報\(参考\):[\s\S]*提出記録[\s\S]*範囲外/.test(a.copy), (a.copy.match(/提出記録の studentIndex 範囲超過.{0,30}/) || ['(なし)'])[0]);

        // ============ 3. 範囲外の提出記録だけの端末: 総合判定は変えない(情報にだけ出る) ============
        await seed(scoresOk, subsOk.concat(straySubs));
        const b = await audit();
        check('範囲外の提出記録だけのとき: 総合判定は「致命的問題なし」のまま・注意は0件・情報にだけ出る', /致命的問題なし/.test(b.an.overallStatus) && b.an.warn.length === 0 && b.an.critical.length === 0 && b.an.info.some(m => /提出記録/.test(m) && /範囲外/.test(m)), b.an.overallStatus + ' warn=' + JSON.stringify(b.an.warn));

        // ============ 4. 該当なしの端末: 表に「0件」が出る・情報には出ない ============
        await seed(scoresOk, subsOk);
        const z = await audit();
        check('該当なしのとき: 表に「提出記録の studentIndex 範囲超過」が「0件」と出る・情報には出ない・コピー用テキストも0件', z.si.subIndexOver === 0 && (z.si.subIndexOverValues || []).length === 0 && /提出記録の studentIndex 範囲超過[^。]{0,10}0件/.test(z.screen) && !z.an.info.some(m => /提出記録/.test(m) && /範囲外/.test(m)) && /提出記録の studentIndex 範囲超過: 0件 \(児童数:6\)/.test(z.copy), (z.screen.match(/提出記録の studentIndex 範囲超過.{0,30}/) || ['(なし)'])[0]);

        // ============ 5. 一覧は最大10個まで(多いときは「ほか N個」) ============
        const many = []; for (let k = 0; k < 14; k++) many.push(SB(1000 + k, 20 + k, 101));
        await seed(scoresOk, subsOk.concat(many));
        const m14 = await audit();
        const info14 = m14.an.info.filter(m => /提出記録/.test(m) && /範囲外/.test(m))[0] || '';
        check('範囲外の番号が14個あるとき: 件数は14件・一覧は最初の10個まで・「ほか4個」と添える', m14.si.subIndexOver === 14 && m14.si.subIndexOverValues.length === 10 && m14.si.subIndexOverValueCount === 14 && /14件/.test(info14) && /ほか4個/.test(info14), JSON.stringify(m14.si.subIndexOverValues) + ' ' + info14);

        // ============ 5.5 課題ごとの人数の表示は、今回は変えない(案E は別の判断。範囲外の記録があるときの今までの表示のまま) ============
        await seed(scoresOk, subsOk.concat(straySubs));
        const cards = await page.evaluate(async () => {
            const wait = (ms) => new Promise(r => setTimeout(r, ms));
            showView('submissions'); await wait(200);
            const ts = document.getElementById('subTermSel'); if (ts) { ts.value = '1'; ts.dispatchEvent(new Event('change')); }
            const b = document.querySelector('.sub-subnav-btn[data-sub="assign"]'); if (b) b.click(); await wait(300);
            return Array.from(document.querySelectorAll('#subAssignList .sub-assign-meta')).map(c => c.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
        });
        check('課題カードの○△×は、範囲外の記録も含めた今までの表示のまま(宿題Aは名簿の6人を超える。案E は今回入れない)', cards === EXPECT_CARDS, cards);

        // ============ 6. 成績は変わらない(診断は読み取り専用。範囲外の記録があっても名簿の6名の値は同じ) ============
        await seed(scoresOk.concat(strayScores), subsOk.concat(straySubs));
        const G1 = await gradeSnap();
        await audit();
        const G2 = await gradeSnap();
        check('成績画面(国語・1学期): 診断の前後で同じ', G1 === G2, G2);
        check('成績画面: 変更前の値と完全に同じ(範囲外の提出記録・得点があっても、名簿の6名の観点別・提出物・評定は同じ)', G0 === EXPECT_GRADE && G1 === EXPECT_GRADE, G0);
        const stray = await page.evaluate(() => ({ s: JSON.parse(StorageManager.getRaw(KEYS.submissions_data)).length, c: JSON.parse(StorageManager.getRaw(KEYS.scores)).length }));
        check('診断は記録を書き換えない(提出記録19件・得点8件のまま。自動では消さない)', stray.s === 12 + straySubs.length && stray.c === 6 + strayScores.length, JSON.stringify(stray));

        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));
    } catch (e) {
        check('テスト実行中に例外なし', false, String(e && e.stack || e));
    }
    await browser.close();
    const failed = results.filter(r => !r.pass).length;
    console.log('\n合計 ' + results.length + ' 件 / 成功 ' + (results.length - failed) + ' / 失敗 ' + failed);
    process.exit(failed ? 1 : 0);
})();
