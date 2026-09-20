// M3(v1.60.0): 面談用テキストの学期を1つに揃える。
//   以前は、成績だけ出力画面の学期(kvTermSel)で計算し、提出物とテスト個票は通年(全学期)のままだった(1つのテキストの中で学期が混在)。
//   今は、成績・提出物・テスト個票のすべてを、出力画面で選んでいる学期(カルテPDFと同じ選択)に揃える。「通年」を選べば全学期。
//   成績画面(成績処理)の表示・成績の計算は変えない。
//   注: 生活記録・児童の記録・保護者対応・出欠席などは、今までどおり学期で絞らない(この項目の対象外)。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node conference-text-term.test.js

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
            window.__clip = null;
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
        });
    }
    // 成績画面の学期(grdTermSel)を選ぶ(出力画面の学期とは別)
    async function setGradeScreenTerm(term) {
        await page.evaluate((term) => { showView('grades'); const s = document.getElementById('grdTermSel'); s.value = term; s.dispatchEvent(new Event('change')); }, term);
        await sleep(150);
    }
    // 出力画面の学期を選んで、面談用テキストを作る(甲だけ)
    async function conference(outTerm, idx) {
        await page.evaluate((outTerm, idx) => {
            window.__clip = null; showView('karte'); kvSetMode('output');
            const sel = document.getElementById('kvTermSel'); sel.value = outTerm; sel.dispatchEvent(new Event('change'));
            document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(idx)); });
            document.getElementById('kvCopyTextBtn').click();
        }, outTerm, idx);
        await sleep(150);
        return page.evaluate(() => window.__clip || '');
    }
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score) => ({ id: testId * 100 + i, studentIndex: i, testId, score });

    // ---- 題材: 国語 ----
    //   小テスト3件(1学期8点・2学期6点・3学期4点)。甲の知識: 1学期=8→A・2学期=6→B・3学期=4→C(標準のしきい値)
    //   宿題2件(1学期=提出・2学期=未提出)
    const tests = [
        T({ id: 1, name: '一学期の小テスト', term: '1', date: '2026-05-10' }),
        T({ id: 2, name: '二学期の小テスト', term: '2', date: '2026-09-10' }),
        T({ id: 3, name: '三学期の小テスト', term: '3', date: '2027-01-10' })
    ];
    const scores = [S(1, 0, 8), S(2, 0, 6), S(3, 0, 4), S(1, 1, 10), S(2, 1, 10), S(3, 1, 10)];
    const assigns = [
        { id: 101, subject: '国語', name: '一学期の宿題', date: '2026-05-11', term: '1', createdAt: '2026-05-01T00:00:00Z' },
        { id: 102, subject: '国語', name: '二学期の宿題', date: '2026-09-11', term: '2', createdAt: '2026-09-01T00:00:00Z' }
    ];
    const subs = [{ id: 1, studentIndex: 0, assignmentId: 101, status: 'submitted', correctionDone: true, createdAt: '2026-05-12T00:00:00Z' }];

    // テキストから、各部分を取り出す
    const part = (txt, head, next) => { const a = txt.indexOf(head); if (a < 0) return ''; const b = txt.indexOf(next, a + head.length); return txt.slice(a, b < 0 ? undefined : b); };
    const parts = (txt) => ({
        grade: part(txt, '【成績（観点別・評定）】', '【テスト個票'),
        tests: part(txt, '【テスト個票', '【出欠席】'),
        subs: part(txt, '【提出物', '【漢字チェック】')
    });
    const knowOf = (g) => { const m = /国語：知 (\S+)／/.exec(g); return m ? m[1] : '?'; };

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores, assigns, subs });
        await installCaptures();

        // ============ 0. 成績画面(成績処理)の値: 学期ごと。変えない(変更前のコードで確認した値) ============
        const grades = await page.evaluate(() => ['1', '2', '3', 'all'].map(t => JSON.stringify(grdCalculate('国語', t).map(r => [r.knowledge.avg, r.knowledge.abc, r.attitude.avg, r.attitude.abc, r.hyoutei]))));
        const GRADES = ['[[8,"A",10,"A",""],[10,"A",0,"C",""]]', '[[6,"B",0,"C",""],[10,"A",0,"C",""]]', '[[4,"C",null,"",""],[10,"A",null,"",""]]', '[[6,"B",5,"B",""],[10,"A",0,"C",""]]'];
        check('成績画面: 国語の観点別・評定が、1学期・2学期・3学期・通年とも変更前と完全に同じ(甲の知識 8/6/4/6)', JSON.stringify(grades) === JSON.stringify(GRADES), JSON.stringify(grades));

        // ============ 1. 出力画面で「1学期」→ 成績・提出物・テスト個票がすべて1学期だけ ============
        //   成績画面の学期は別の学期(3学期)にしておく: 面談テキストは成績画面の選択に引きずられない
        await setGradeScreenTerm('3');
        const t1 = parts(await conference('1', 0));
        check('1学期: 成績の知識は1学期の値(A)', knowOf(t1.grade) === 'A', t1.grade);
        check('1学期: テスト個票は1学期の1件だけ(「一学期の小テスト」。二学期・三学期は出ない)', /テスト個票（1件/.test(t1.tests) && t1.tests.indexOf('一学期の小テスト') !== -1 && t1.tests.indexOf('二学期の小テスト') === -1 && t1.tests.indexOf('三学期の小テスト') === -1, t1.tests);
        check('1学期: 提出物は1学期の1件だけ(100%・提出済1件・未提出0件。二学期の宿題の未提出は数えない)', /【提出物（100%）】/.test(t1.subs) && /提出済 1件／再提出 0件／未提出 0件/.test(t1.subs) && t1.subs.indexOf('二学期の宿題') === -1, t1.subs);

        // ============ 2. 出力画面で「2学期」 ============
        await setGradeScreenTerm('1');
        const t2 = parts(await conference('2', 0));
        check('2学期: 成績の知識は2学期の値(B)', knowOf(t2.grade) === 'B', t2.grade);
        check('2学期: テスト個票は2学期の1件だけ', /テスト個票（1件/.test(t2.tests) && t2.tests.indexOf('二学期の小テスト') !== -1 && t2.tests.indexOf('一学期の小テスト') === -1, t2.tests);
        check('2学期: 提出物は2学期の1件だけ(0%・未提出1件。一学期の提出は数えない)', /【提出物（0%）】/.test(t2.subs) && /提出済 0件／再提出 0件／未提出 1件/.test(t2.subs) && t2.subs.indexOf('二学期の宿題（未提出）') !== -1, t2.subs);

        // ============ 3. 出力画面で「通年」 → 全学期(今までの通年の表示と同じ) ============
        const tAll = parts(await conference('all', 0));
        check('通年: 成績の知識は通年の値(B)・テスト個票は3件・提出物は2件(50%)', knowOf(tAll.grade) === 'B' && /テスト個票（3件/.test(tAll.tests) && /【提出物（50%）】/.test(tAll.subs) && /提出済 1件／再提出 0件／未提出 1件/.test(tAll.subs), tAll.grade.split('\n')[1] + ' | ' + (tAll.tests.split('\n')[0]) + ' | ' + tAll.subs.split('\n')[0]);

        // ============ 4. 3学期: 課題が1件も無い学期は「（課題なし）」 ============
        const t3 = parts(await conference('3', 0));
        check('3学期: テスト個票は3学期の1件・提出物は対象の課題が無いので「（課題なし）」(1・2学期の宿題は出ない)', /テスト個票（1件/.test(t3.tests) && t3.tests.indexOf('三学期の小テスト') !== -1 && t3.subs.indexOf('（課題なし）') !== -1 && t3.subs.indexOf('宿題') === -1 && knowOf(t3.grade) === 'C', t3.subs);

        // ============ 5. 面談テキストの成績は、成績処理の計算(grdCalculate)とその学期で完全に一致する ============
        const same = await page.evaluate(() => ['1', '2', '3'].map(t => grdCalculate('国語', t)[0].knowledge.abc));
        check('面談テキストの成績(1/2/3学期)が、成績処理の計算の同じ学期の値と一致(A/B/C)', same.join() === [knowOf(t1.grade), knowOf(t2.grade), knowOf(t3.grade)].join(), same.join());

        // ============ 6. 学期で絞らないもの(生活記録など)は今までどおり全期間 ============
        //   (生活記録・保護者対応・出欠席は、この項目の対象外。学期を変えても件数が変わらないことを確認)
        const life = await page.evaluate(() => {
            const L = {}; L['0'] = [{ id: 1, date: '2026-05-10', categories: [], summary: '一学期の生活', createdAt: '2026-05-10T00:00:00Z' }, { id: 2, date: '2026-09-10', categories: [], summary: '二学期の生活', createdAt: '2026-09-10T00:00:00Z' }];
            StorageManager.setImmediate(KEYS.karte_life, JSON.stringify(L));
            return true;
        });
        const lifeParts = async (term) => { const txt = await conference(term, 0); return /【生活記録（(\d+)件）】/.exec(txt)[1]; };
        check('学期を変えても、生活記録の件数は今までどおり全期間(1学期でも2学期でも2件。この項目の対象外)', life && (await lifeParts('1')) === '2' && (await lifeParts('2')) === '2', '');
        await page.evaluate(() => StorageManager.remove(KEYS.karte_life));

        // ============ 7. 読み取り専用 ============
        const before = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores), StorageManager.getRaw(K.assigns), StorageManager.getRaw(K.subs)], KN);
        await conference('1', 0);
        const after = await page.evaluate((K) => [StorageManager.getRaw(K.tests), StorageManager.getRaw(K.scores), StorageManager.getRaw(K.assigns), StorageManager.getRaw(K.subs)], KN);
        check('面談テキストの生成で、課題・記録・提出物は1バイトも変わらない', JSON.stringify(before) === JSON.stringify(after), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); StorageManager.remove(KEYS.karte_life); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== conference-text-term: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
