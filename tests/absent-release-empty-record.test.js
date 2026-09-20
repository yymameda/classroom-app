// L7 案B(v1.60.4): 「欠席」→「欠席中」(解除)の操作で、中身が空の記録(score:'' で他の項目なし)を残さない。
//   背景(調査 2026-09-20): 記録のなかった児童を欠席にして解除すると、{score:''} の記録が残っていた。
//   主体性の得点方式では、この空文字が0点として成績に入り(観点C・評定が下がる)、「入力済み」の数にも数えられていた。
//   今は: 解除のとき、その記録が「空の殻」(score が空文字で、id・児童・課題・作成日時以外の項目がない)なら記録ごと消す。
//         点数・5段階・ルーブリック・遅れの印など、中身がある記録は、これまでどおり欠席の印だけを外して残す。
//         すでにある空の記録は、この変更では書き換えない(その児童の欠席の操作をしたときだけ)。
//   本番の操作経路: 児童の記録の入力画面の「欠席」ボタン→「欠席中」ボタンを、実際にクリックする(page.click)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node absent-release-empty-record.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 変更前の成績(国語・1学期): [名前, 知識平均, 知識ABC, 主体性平均, 主体性ABC, 評定]。丁・戊・己は空の記録が元からあるので主体性は0点(この変更では書き換えない)
const EXPECT_GRADE = '[["甲",8,"A",null,"",""],["乙",8,"A",9,"A",""],["丙",8,"A",null,"",""],["丁",8,"A",0,"C",""],["戊",8,"A",0,"C",""],["己",8,"A",0,"C",""]]';

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 900 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol }));

    const NAMES = ['甲', '乙', '丙', '丁', '戊', '己'];
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score }, extra || {});
    // 国語: 漢字(知識・得点 id1) 全員8点 / 音読(知識・得点 id2) 記録なし / ノート点(主体性・得点方式 id3) 乙=8点・丁=元からある空の記録・戊=空だが遅れの印つき・己=空だがメモつき / 発言(主体性・5段階 id4) 乙=A
    const tests = [
        T({ id: 1, name: '漢字' }), T({ id: 2, name: '音読' }),
        T({ id: 3, name: 'ノート点', category: '主体性', maxScore: 10, inputMode: 'score' }),
        T({ id: 4, name: '発言', category: '主体性', maxScore: 0, inputMode: 'abc5' })
    ];
    const scores = [
        S(1, 0, 8), S(1, 1, 8), S(1, 2, 8), S(1, 3, 8), S(1, 4, 8), S(1, 5, 8),
        S(3, 1, 8), S(3, 3, ''), S(3, 4, '', { lateSubmit: true }), S(3, 5, '', { memo: 'x' }),
        S(4, 1, 'A')
    ];
    await page.evaluate((K, d) => {
        const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
        put(K.master, { version: 2, students: d.names.map(n => ({ name: n })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
        put(K.tests, d.tests); put(K.scores, d.scores); put(K.assigns, []); put(K.subs, []);
        put(K.att, {}); put(K.weights, {}); put(K.patrol, []);
        StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
    }, K, { names: NAMES, tests, scores });
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(500);

    const rec = (testId, i) => page.evaluate((testId, i) => { const a = JSON.parse(StorageManager.getRaw(KEYS.scores)).filter(s => s.testId === testId && s.studentIndex === i); return a.length ? a[0] : null; }, testId, i);
    const gradeSnap = () => page.evaluate(() => JSON.stringify(grdCalculate('国語', '1').map(r => [r.name, r.knowledge.avg, r.knowledge.abc, r.attitude.avg, r.attitude.abc, r.hyoutei])));
    const openTest = async (testId) => { await page.evaluate((testId) => { showView('records'); recSelectTestGoto(testId); }, testId); await sleep(400); };
    const btnText = (i) => page.evaluate((i) => { const b = document.querySelector('#rec-row-' + i + ' .sub-absent-btn'); return b ? b.textContent : '(なし)'; }, i);
    const dotText = (i) => page.evaluate((i) => { const d = document.getElementById('rec-dot-' + i); return d ? d.textContent.trim() : '(なし)'; }, i);
    const progress = () => page.evaluate(() => { const e = document.getElementById('recProgress'); return e ? e.textContent.trim() : '(なし)'; });
    // 本番の操作: 「欠席」ボタンを実際にクリックする
    const clickAbsent = async (i) => { await page.click('#rec-row-' + i + ' .sub-absent-btn'); await sleep(350); };

    try {
        const G0 = await gradeSnap();
        check('準備: 操作前の成績は、変更前の値と同じ(丁・戊は元からある空の記録で主体性0点)', G0 === EXPECT_GRADE, G0);

        // ============ 1. 主体性(得点方式): 記録のない児童を 欠席 → 欠席中(解除) ============
        await openTest(3);
        await clickAbsent(0);
        const r1a = await rec(3, 0);
        check('欠席にすると、記録 {score:"", absent:true} ができ、ボタンは「欠席中」になる', r1a && r1a.absent === true && r1a.score === '' && (await btnText(0)) === '欠席中', JSON.stringify(r1a) + ' / ' + await btnText(0));
        await clickAbsent(0);
        const r1b = await rec(3, 0);
        check('解除すると、空の記録は残らない(記録ごと消える)。ボタンは「欠席」に戻る', r1b === null && (await btnText(0)) === '欠席', JSON.stringify(r1b) + ' / ' + await btnText(0));
        check('  → 行の「入力済み」の印(✓)も付かない', (await dotText(0)) === '', JSON.stringify(await dotText(0)));

        // ============ 2. 中身のある記録は残る ============
        const before2 = await rec(3, 1);
        await clickAbsent(1); await clickAbsent(1);
        const r2 = await rec(3, 1);
        check('8点が入っている乙: 欠席→解除しても、8点は残り、欠席の印だけが消える(記録の id も同じ)', r2 && r2.score === 8 && r2.absent === undefined && r2.id === before2.id, JSON.stringify(r2));

        // ============ 3. 5段階の課題 ============
        await openTest(4);
        await clickAbsent(0); await clickAbsent(0);
        check('5段階(発言): 記録のない甲を 欠席→解除 → 空の記録は残らない', (await rec(4, 0)) === null, JSON.stringify(await rec(4, 0)));
        await clickAbsent(1); await clickAbsent(1);
        const r3 = await rec(4, 1);
        check('5段階(発言): Aが入っている乙は、欠席→解除してもAが残る', r3 && r3.score === 'A' && r3.absent === undefined, JSON.stringify(r3));

        // ============ 4. 知識・技能の課題(音読・記録なし) ============
        await openTest(2);
        await clickAbsent(2); await clickAbsent(2);
        check('知識・技能(音読): 記録のない丙を 欠席→解除 → 空の記録は残らない', (await rec(2, 2)) === null, JSON.stringify(await rec(2, 2)));

        // ============ 5. 欠席のまま(解除しない)は今までどおり ============
        await openTest(3);
        await clickAbsent(2);
        const r5 = await rec(3, 2);
        check('欠席のまま(解除しない)の丙: 記録 {score:"", absent:true} が残る(欠席の印を保持)', r5 && r5.absent === true && r5.score === '', JSON.stringify(r5));
        const g5 = await page.evaluate(() => grdCalculate('国語', '1').map(r => r.attitude.avg)[2]);
        check('  → 欠席中の児童は、成績では未評価(0点にならない)', g5 === null, String(g5));

        // ============ 6. 空のようで空でない記録・元からある記録は変えない ============
        await clickAbsent(4); await clickAbsent(4);
        const r6 = await rec(3, 4);
        check('空の点数でも、遅れの印がある記録(戊)は、欠席→解除しても消さない(欠席の印だけ外れる)', r6 && r6.score === '' && r6.lateSubmit === true && r6.absent === undefined, JSON.stringify(r6));
        await clickAbsent(5); await clickAbsent(5);
        const r6c = await rec(3, 5);
        check('空の点数でも、ほかの項目(メモ)がある記録(己)は、欠席→解除しても消さない(欠席の印だけ外れる)', r6c && r6c.score === '' && r6c.memo === 'x' && r6c.absent === undefined, JSON.stringify(r6c));
        const r6b = await rec(3, 3);
        check('元からある空の記録(丁)は、丁に触れていない限り、そのまま残る(既存の記録は書き換えない)', r6b && r6b.score === '' && r6b.id === 303, JSON.stringify(r6b));
        // 元からある空の記録の児童を、実際に 欠席→解除 した場合: 空の殻なので消える(本人が操作したときだけ)
        await clickAbsent(3); await clickAbsent(3);
        check('元からある空の記録(丁)でも、丁を 欠席→解除 したときは、空の記録が消える(操作した児童だけ)', (await rec(3, 3)) === null, JSON.stringify(await rec(3, 3)));

        // ============ 7. 「入力済み」の数 ============
        await openTest(3);
        check('ノート点の「入力済み」は、乙(8点)・戊(遅れの印つき)・己(メモつき)・欠席中の丙の4件(空の記録は数えない)', /4 \/ 6 人入力済み/.test(await progress()), await progress());

        // ============ 8. 成績は変わらない(丁だけ、丁自身の操作で空の記録が消えて未評価に戻る) ============
        const G1 = await gradeSnap();
        const EXPECT_AFTER = '[["甲",8,"A",null,"",""],["乙",8,"A",9,"A",""],["丙",8,"A",null,"",""],["丁",8,"A",null,"",""],["戊",8,"A",0,"C",""],["己",8,"A",0,"C",""]]';
        check('成績画面: 甲・乙・丙・戊・己は操作前と同じ。丁だけ、丁自身の操作で0点の空の記録が消え、未評価になる', G1 === EXPECT_AFTER, G1);

        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));
    } catch (e) {
        check('テスト実行中に例外なし', false, String(e && e.stack || e));
    }
    await browser.close();
    const failed = results.filter(r => !r.pass).length;
    console.log('\n合計 ' + results.length + ' 件 / 成功 ' + (results.length - failed) + ' / 失敗 ' + failed);
    process.exit(failed ? 1 : 0);
})();
