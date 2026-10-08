// v1.66.0: 単元テスト・まとめテストの「主体性」の課題(全設問が「主」)を、課題ごとに 得点(設問ごと)／5段階 で選べる。
//
// 検証すること:
//   A. 課題フォーム(実際のクリック): 全設問が「主」のときだけ「得点／5段階」の選択が出る・初期値は得点(観点で自動決定しない)・
//      5段階を選ぶと設問の設定が隠れ、保存すると 5段階の主体性の課題(type:'standard'・category:'主体性'・inputMode:'abc5'・maxScore:0)になる。
//      得点に戻して保存すれば従来どおりのまとめ形式(type:'matome')。設問の観点を1つでも「主」以外にすると選択が消え、得点になる。
//   B. 入力: リスト(A〜Cボタン)・連続入力(空のマスをタップ→即時Bで確定／入力済みのマス→ポップアップで変更)・座席(値の表示と取消)。
//   C. 集計: 成績処理統合(grdCalculate)・成績の明細CSV(grdBuildDetailRows)・換算方法の文字が abcTo10(A=10/B+=8.5/B=7/B-=5/C=3)。
//      遅れの印(lateSubmit)があっても0.8倍しない。
//   D. 既存の得点入力の主体性まとめテスト(type:'matome')は、記録があれば入力形式を変えられず、編集して保存しても形式・設問・成績が変わらない。
//   E. 5段階の課題を編集で開くと5段階が選ばれている・記録がなければ得点(設問ごと)に戻せる。主体性の重みは ma_⇔a_ で引き継ぐ。
//   F. 監査診断: 5段階の単元テストに数値の記録があれば「入力形式と満点が矛盾する課題」に数える。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123`
// 実行: cd tests && node matome-attitude-5rank.test.js

const puppeteer = require('puppeteer-core');
const { termSafeDate } = require('./helpers/term-date');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TEST_DATE = termSafeDate(10);

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
    page.on('dialog', d => d.accept());

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, mq: KEYS.matome_questions, weights: KEYS.grade_weights, seating: KEYS.seating }));
    const backup = {};
    for (const k of Object.values(K)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    // 既存の得点入力の主体性まとめテスト(記録あり)と、記録のない全問「主」のまとめテスト
    const OLD_ID = 1700000000001, EMPTY_ID = 1700000000002;
    const OLD_TEST = { id: OLD_ID, subject: '国語', testType: 'まとめテスト', name: 'まテ_既存_主体性', category: '複合', type: 'matome', maxScore: 10, date: TEST_DATE, createdAt: '2026-05-01T00:00:00.000Z', matomePoints: [5, 5], matomeQuestionTypes: ['主', '主'], matomeQCount: 2 };
    const EMPTY_TEST = { id: EMPTY_ID, subject: '国語', testType: '単元テスト', name: '単テ_空_主体性', category: '複合', type: 'matome', maxScore: 4, date: TEST_DATE, createdAt: '2026-05-01T00:00:00.000Z', matomePoints: [2, 2], matomeQuestionTypes: ['主', '主'], matomeQCount: 2 };
    const OLD_SCORES = [
        { id: 1, studentIndex: 0, testId: OLD_ID, score: 7, answers: [4, 3], createdAt: '2026-05-02T00:00:00.000Z' },
        { id: 2, studentIndex: 1, testId: OLD_ID, score: 10, answers: [5, 5], createdAt: '2026-05-02T00:00:00.000Z' }
    ];
    const NAMES = ['甲', '乙', '丙', '丁'];

    try {
        await page.evaluate((d) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ students: d.names.map(n => ({ name: n })), classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([d.old, d.empty]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(d.scores));
            var mq = {}; mq[d.old.id] = [{ points: 5, type: '主' }, { points: 5, type: '主' }]; mq[d.empty.id] = [{ points: 2, type: '主' }, { points: 2, type: '主' }];
            StorageManager.setImmediate(KEYS.matome_questions, JSON.stringify(mq));
            var w = { '国語': { attitude: {} } }; w['国語'].attitude['ma_' + d.empty.id] = 2;
            StorageManager.setImmediate(KEYS.grade_weights, JSON.stringify(w));
            var seat = {}; d.names.forEach((_, i) => { seat['0-' + i] = i; });
            StorageManager.setImmediate(KEYS.seating, JSON.stringify(seat));
        }, { names: NAMES, old: OLD_TEST, empty: EMPTY_TEST, scores: OLD_SCORES });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => { window.showView('records'); window.recShowSub('tests'); });
        await sleep(200);

        const getTests = () => page.evaluate(() => StorageManager.get(KEYS.tests, []));
        const findTest = async (name) => (await getTests()).find(t => t.name === name) || null;
        const oldGradeBefore = await page.evaluate(() => grdCalculate('国語', 'all').map(r => r.attitude.items.filter(it => it.itemKey === 'ma_1700000000001').map(it => it.score10)[0]));
        const formState = () => page.evaluate(() => {
            const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
            const sb = document.getElementById('recInputModeScoreBtn'), ab = document.getElementById('recInputModeAbc5Btn'), mx = document.getElementById('recTestMaxScore');
            return {
                toggle: vis('recInputModeWrap'), matomeFields: vis('recMatomeFields'), lockNote: vis('recInputModeLockNote'),
                scoreActive: sb.classList.contains('active'), abcActive: ab.classList.contains('active'), scoreDisabled: sb.disabled, abcDisabled: ab.disabled,
                maxDisabled: mx.disabled, maxPh: mx.placeholder, cat: document.getElementById('recTestCategory').value
            };
        });
        const ALL_SHU = '#recMatomeFields button[onclick="recSetMatomeUniformType(\'主\')"]';
        const ALL_CHI = '#recMatomeFields button[onclick="recSetMatomeUniformType(\'知\')"]';
        async function startForm(type, name) {
            await page.select('#recTestSubject', '国語');
            await page.click('#recTestName', { clickCount: 1 });
            await page.evaluate(() => document.getElementById('recTestName').select());
            await page.type('#recTestName', name);
            await page.select('#recTestType', type); // 種別を選ぶと課題名に「単テ_」「まテ_」が付く
            await page.evaluate((d) => { document.getElementById('recTestDate').value = d; }, TEST_DATE);
            await page.evaluate(() => { document.getElementById('recMatomeQCount').value = '2'; window.recRenderMatomePreview(); });
            await page.click(ALL_CHI); await sleep(50); // 前の入力の設問の観点が残っているので「知」にそろえる
        }

        // 課題の一覧の「編集」ボタンから開く(実際の操作と同じ)
        async function editVia(id) {
            await page.evaluate(() => window.recShowSub('tests')); await sleep(200);
            await page.click('button.btn-rec-small.edit[onclick*="' + id + '"]'); await sleep(200);
        }

        // ================= A. 課題フォーム =================
        for (const type of ['単元テスト', 'まとめテスト']) {
            const P = '[' + type + '] ';
            const prefix = type === '単元テスト' ? '単テ_' : 'まテ_';
            await startForm(type, '主体性5段階');
            let s = await formState();
            check(P + '設問が「知」のままでは「得点／5段階」の選択は出ない', s.toggle === false && s.matomeFields === true, JSON.stringify(s));
            await page.click(ALL_SHU); await sleep(80);
            s = await formState();
            check(P + '全設問を「主」にすると選択が出て、初期値は得点(観点で自動決定しない)', s.toggle === true && s.scoreActive === true && s.abcActive === false && s.matomeFields === true, JSON.stringify(s));
            await page.click('#recInputModeAbc5Btn'); await sleep(80);
            s = await formState();
            check(P + '5段階を選ぶと設問の設定が隠れ、満点欄は「ABC評価」で入力不可・観点は主体性', s.abcActive === true && s.matomeFields === false && s.maxDisabled === true && s.maxPh === 'ABC評価' && s.cat === '主体性', JSON.stringify(s));
            await page.click('#recInputModeScoreBtn'); await sleep(80);
            s = await formState();
            check(P + '得点に戻すと設問の設定が戻る(全設問「主」のまま・満点は配点合計)', s.scoreActive === true && s.matomeFields === true && s.toggle === true && s.maxPh === '配点合計で自動計算' && s.cat === '', JSON.stringify(s));
            await page.click('#recInputModeAbc5Btn'); await sleep(80);
            await page.click('#recAddTestBtn'); await sleep(250);
            const t = await findTest(prefix + '主体性5段階');
            check(P + '保存: 5段階の主体性の課題になる(type:standard・category:主体性・inputMode:abc5・maxScore:0・設問なし)',
                t && t.type === 'standard' && t.testType === type && t.category === '主体性' && t.inputMode === 'abc5' && t.maxScore === 0 && !t.matomePoints && !t.matomeQuestionTypes,
                JSON.stringify(t));
            const mqHas = await page.evaluate((id) => !!(StorageManager.get(KEYS.matome_questions, {})[id]), t && t.id);
            check(P + '保存: 設問の定義(matome_questions)は作らない', mqHas === false);
        }
        // 得点のまま保存すれば従来どおり
        await startForm('単元テスト', '主体性得点');
        await page.click(ALL_SHU); await sleep(80);
        await page.click('#recAddTestBtn'); await sleep(250);
        const tScore = await findTest('単テ_主体性得点');
        check('得点のまま保存: 従来どおりのまとめ形式(type:matome・inputMode なし・設問2問「主」)',
            tScore && tScore.type === 'matome' && tScore.inputMode === undefined && JSON.stringify(tScore.matomeQuestionTypes) === '["主","主"]' && tScore.maxScore === 10, JSON.stringify(tScore));
        // 5段階を選んだあと設問を1つ「知」に戻すと(得点に戻してから)選択が消える
        await startForm('まとめテスト', '混在');
        await page.click(ALL_SHU); await sleep(80);
        await page.click('#rec-mq-type-1'); await sleep(80); // 主→知
        let sMix = await formState();
        check('設問の観点が1つでも「主」以外なら選択は出ない', sMix.toggle === false && sMix.scoreActive === true, JSON.stringify(sMix));
        await page.click(ALL_CHI); await sleep(80);
        await page.click('#recAddTestBtn'); await sleep(250);
        const tMix = await findTest('まテ_混在');
        check('「主」以外を含むテストは従来どおりまとめ形式', tMix && tMix.type === 'matome' && tMix.inputMode === undefined, JSON.stringify(tMix));
        // 記述問題で5段階を選んでから単元テストへ切り替えても、5段階のまま保存されない(設問が「知」)
        await page.select('#recTestType', '記述問題'); await sleep(50);
        await page.click('#recInputModeAbc5Btn'); await sleep(50);
        await page.select('#recTestType', '単元テスト'); await sleep(80);
        const sSwitch = await formState();
        check('5段階を選んだ別の種別から単元テストに切り替えると、得点(設問ごと)になる', sSwitch.toggle === false && sSwitch.matomeFields === true && sSwitch.maxPh === '配点合計で自動計算', JSON.stringify(sSwitch));
        await page.evaluate(() => { var c = document.getElementById('recCancelEditBtn'); if (c) c.click(); window.recResetTestForm && 0; });
        await page.evaluate(() => { document.getElementById('recTestType').value = ''; window.recOnTestTypeChange(); });

        // ================= B. 入力(3つの表示モード) =================
        const abcTest = await findTest('単テ_主体性5段階');
        await page.evaluate((id) => window.recSelectTestGoto(id), abcTest.id);
        await sleep(300);
        const rec = (i) => page.evaluate((d) => (StorageManager.get(KEYS.scores, []).find(s => Number(s.studentIndex) === d.i && s.testId === d.id) || null), { i, id: abcTest.id });
        const listBtns = await page.evaluate(() => ({ abc: document.querySelectorAll('#rec-row-0 .rec-abc-btn').length, num: !!document.getElementById('rec-sc-0') }));
        check('[リスト] A〜Cの5つのボタンが出て、数値の入力欄は出ない', listBtns.abc === 5 && listBtns.num === false, JSON.stringify(listBtns));
        await page.click('#rec-row-0 .rec-abc-btn:nth-child(1)'); await sleep(150); // A
        await page.click('#rec-row-1 .rec-abc-btn:nth-child(2)'); await sleep(150); // B+
        check('[リスト] A を押すと A が記録される', ((await rec(0)) || {}).score === 'A', JSON.stringify(await rec(0)));
        check('[リスト] B+ を押すと B+ が記録される', ((await rec(1)) || {}).score === 'B+', JSON.stringify(await rec(1)));

        await page.click('#recViewContBtn'); await sleep(300);
        await page.click('#recContGrid .rec-cont-cell[data-cidx="2"]'); await sleep(250);
        check('[連続入力] 空のマスをタップすると即時に B で確定', ((await rec(2)) || {}).score === 'B', JSON.stringify(await rec(2)));
        await page.click('#recContGrid .rec-cont-cell[data-cidx="2"]'); await sleep(250);
        const popup = await page.evaluate(() => { const c = document.querySelector('#recContGrid .rec-cont-cell.editing'); return c ? c.querySelectorAll('button').length : 0; });
        check('[連続入力] 入力済みのマスをタップすると選択のポップアップが開く', popup >= 5, 'buttons=' + popup);
        const clickedBm = await page.evaluate(() => {
            const c = document.querySelector('#recContGrid .rec-cont-cell.editing');
            const b = c && Array.from(c.querySelectorAll('button')).find(x => /^B[-－]$/.test(x.textContent.trim()));
            if (!b) return false; b.click(); return true;
        });
        await sleep(250);
        check('[連続入力] ポップアップで B- を選ぶと B- に変わる', clickedBm && ((await rec(2)) || {}).score === 'B-', JSON.stringify(await rec(2)));

        await page.click('#recViewSeatBtn'); await sleep(300);
        const seatTxt = await page.evaluate(() => Array.from(document.querySelectorAll('#recSeatGrid .rec-seat-cell')).slice(0, 4).map(c => c.textContent));
        check('[座席] 各席に入力した値(A・B+・B-)が出る', /A/.test(seatTxt[0]) && /B\+/.test(seatTxt[1]) && /B-/.test(seatTxt[2]), JSON.stringify(seatTxt));
        await page.click('#recSeatGrid .rec-cancel-btn[data-cancel-idx="2"]'); await sleep(250);
        check('[座席] 取消で記録が消える', (await rec(2)) === null, JSON.stringify(await rec(2)));
        await page.click('#toastUndoBtn').catch(() => {}); await sleep(300);
        check('[座席] 元に戻すで B- が戻る', ((await rec(2)) || {}).score === 'B-', JSON.stringify(await rec(2)));
        await page.click('#recViewListBtn'); await sleep(250);
        await page.click('#rec-row-3 .rec-abc-btn:nth-child(5)'); await sleep(150); // C
        // 遅れの印を付けても成績は0.8倍しない
        await page.evaluate((id) => { var sc = StorageManager.get(KEYS.scores, []); sc.forEach(s => { if (s.testId === id && s.studentIndex === 0) s.lateSubmit = true; }); StorageManager.setImmediate(KEYS.scores, JSON.stringify(sc)); window.uiResetCaches && uiResetCaches(); }, abcTest.id);

        // ================= C. 集計 =================
        const calc = await page.evaluate((id) => {
            const res = grdCalculate('国語', 'all');
            return res.map(r => { const it = r.attitude.items.find(x => x.itemKey === 'a_' + id); return it ? { s: it.score10, max: it.max, type: it.type, desc: grdItemConversionDesc('国語', it) } : null; });
        }, abcTest.id);
        check('成績処理統合: 5段階の値が abcTo10 で入る(A=10・B+=8.5・B-=5・C=3)', calc.map(c => c && c.s).join(',') === '10,8.5,5,3', JSON.stringify(calc));
        check('成績処理統合: 遅れの印があっても0.8倍しない(Aは10のまま)', calc[0] && calc[0].s === 10);
        check('成績処理統合: 項目に満点を持たない(5段階)・種別は単元テスト', calc[0] && calc[0].max === null && calc[0].type === '単元テスト', JSON.stringify(calc[0]));
        check('算出根拠の換算方法: 「ABC評価 → A=10点…」(得点÷満点 ではない)', calc[0] && /^ABC評価 → A=10点/.test(calc[0].desc), calc[0] && calc[0].desc);
        const detail = await page.evaluate((name) => {
            const H = GRD_DETAIL_HEADER, iMode = H.indexOf('入力形式'), i10 = H.indexOf('10点換算');
            return grdBuildDetailRows('国語', 'all').filter(r => r.indexOf(name) >= 0).map(r => ({ mode: r[iMode], s10: String(r[i10]) }));
        }, abcTest.name);
        check('成績の明細CSV: 5段階の課題の行が「5段階」・10点換算 10/8.5/5/3', detail.length === 4 && detail.every(r => r.mode === '5段階') && detail.map(r => r.s10).join(',') === '10,8.5,5,3', JSON.stringify(detail));
        const avgA = await page.evaluate(() => grdCalculate('国語', 'all').map(r => r.attitude.avg));
        check('成績処理統合: 主体性の平均に5段階の値が入る(甲は既存7と10の重み付き平均で 8.5)', avgA[0] === 8.5, JSON.stringify(avgA));

        // ================= D. 既存の得点入力の主体性まとめテスト =================
        const oldGradeAfter = await page.evaluate(() => grdCalculate('国語', 'all').map(r => r.attitude.items.filter(it => it.itemKey === 'ma_1700000000001').map(it => it.score10)[0]));
        check('既存の得点入力テストの成績は変わらない(7→7・10→10)', JSON.stringify(oldGradeBefore) === JSON.stringify(oldGradeAfter) && oldGradeAfter[0] === 7 && oldGradeAfter[1] === 10, JSON.stringify(oldGradeAfter));
        await editVia(OLD_ID);
        const sOld = await formState();
        check('既存(記録あり)を編集で開く: 選択は出るが得点で固定(押せない・理由の表示)', sOld.toggle === true && sOld.scoreActive === true && sOld.abcDisabled === true && sOld.lockNote === true && sOld.matomeFields === true, JSON.stringify(sOld));
        await page.click('#recInputModeAbc5Btn').catch(() => {}); await sleep(80);
        await page.click('#recAddTestBtn'); await sleep(250);
        const oldAfter = (await getTests()).find(t => t.id === OLD_ID);
        const strip = (t) => { const c = Object.assign({}, t); delete c.createdAt; return JSON.stringify(c); };
        check('既存(記録あり)を編集して保存しても、形式・設問・観点は変わらない', oldAfter && strip(oldAfter) === strip(OLD_TEST), strip(oldAfter));
        const oldScoresAfter = await page.evaluate((id) => StorageManager.get(KEYS.scores, []).filter(s => s.testId === id), OLD_ID);
        check('既存の得点入力テストの記録は書き換わらない', JSON.stringify(oldScoresAfter) === JSON.stringify(OLD_SCORES), JSON.stringify(oldScoresAfter));

        // ================= E. 編集での切り替え・重みの引き継ぎ =================
        await editVia(abcTest.id);
        const sEditAbc = await formState();
        check('5段階の課題(記録あり)を編集で開く: 5段階が選ばれて固定・設問の設定は隠れる', sEditAbc.toggle === true && sEditAbc.abcActive === true && sEditAbc.scoreDisabled === true && sEditAbc.matomeFields === false && sEditAbc.cat === '主体性', JSON.stringify(sEditAbc));
        await page.click('#recAddTestBtn'); await sleep(250);
        const abcAfterSave = (await getTests()).find(t => t.id === abcTest.id);
        check('5段階の課題を編集して保存しても5段階のまま', abcAfterSave && abcAfterSave.type === 'standard' && abcAfterSave.inputMode === 'abc5' && abcAfterSave.category === '主体性' && abcAfterSave.maxScore === 0, JSON.stringify(abcAfterSave));
        // 記録のない全問「主」の単元テストを5段階へ(重み ma_ → a_)
        await editVia(EMPTY_ID);
        const sEmpty = await formState();
        check('記録のない全問「主」のテストを編集で開く: 得点が選ばれ、5段階も押せる', sEmpty.toggle === true && sEmpty.scoreActive === true && sEmpty.abcDisabled === false, JSON.stringify(sEmpty));
        await page.click('#recInputModeAbc5Btn'); await sleep(80);
        await page.click('#recAddTestBtn'); await sleep(250);
        const emptyAbc = (await getTests()).find(t => t.id === EMPTY_ID);
        const w1 = await page.evaluate((id) => { const a = (StorageManager.get(KEYS.grade_weights, {})['国語'] || {}).attitude || {}; return { ma: a['ma_' + id], a: a['a_' + id] }; }, EMPTY_ID);
        const mq1 = await page.evaluate((id) => !!StorageManager.get(KEYS.matome_questions, {})[id], EMPTY_ID);
        check('記録のないテストを5段階へ: 5段階の主体性の課題になる', emptyAbc && emptyAbc.type === 'standard' && emptyAbc.inputMode === 'abc5' && emptyAbc.category === '主体性' && emptyAbc.maxScore === 0 && !emptyAbc.matomePoints, JSON.stringify(emptyAbc));
        check('5段階へ: 主体性の重み(2)を ma_ から a_ へ引き継ぐ', w1.ma === undefined && w1.a === 2, JSON.stringify(w1));
        check('5段階へ: 使わなくなった設問の定義を消す', mq1 === false);
        await editVia(EMPTY_ID);
        await page.click('#recInputModeScoreBtn'); await sleep(80);
        const sBack = await formState();
        check('5段階→得点に切り替えると設問の設定が出て、全設問が「主」', sBack.matomeFields === true && sBack.toggle === true, JSON.stringify(sBack));
        await page.click('#recAddTestBtn'); await sleep(250);
        const emptyBack = (await getTests()).find(t => t.id === EMPTY_ID);
        const w2 = await page.evaluate((id) => { const a = (StorageManager.get(KEYS.grade_weights, {})['国語'] || {}).attitude || {}; return { ma: a['ma_' + id], a: a['a_' + id] }; }, EMPTY_ID);
        check('得点へ戻す: まとめ形式(全設問「主」)に戻る', emptyBack && emptyBack.type === 'matome' && emptyBack.inputMode === undefined && emptyBack.category === '複合' && (emptyBack.matomeQuestionTypes || []).length > 0 && emptyBack.matomeQuestionTypes.every(x => x === '主'), JSON.stringify(emptyBack));
        check('得点へ戻す: 重みを a_ から ma_ へ戻す', w2.ma === 2 && w2.a === undefined, JSON.stringify(w2));

        // ================= F. 監査診断 =================
        await page.evaluate((id) => {
            var sc = StorageManager.get(KEYS.scores, []);
            sc.push({ id: 99, studentIndex: 3, testId: id, score: 8, createdAt: '2026-05-03T00:00:00.000Z' });
            sc = sc.filter(s => !(s.testId === id && s.studentIndex === 3 && typeof s.score === 'string'));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(sc));
            showView('settings');
            window.runAuditDiagnosis();
        }, abcTest.id);
        await sleep(800);
        const audit = await page.evaluate((id) => {
            const r = window._auditDiagnosisLastResult;
            return ((r && r.structuralIntegrity.inputModeConflictDetail) || []).filter(x => x.testId === id).map(x => x.kind);
        }, abcTest.id);
        check('監査診断: 5段階の単元テストに数値の記録があれば矛盾として数える', JSON.stringify(audit) === '["abc5num"]', JSON.stringify(audit));

        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));
    } catch (e) {
        check('例外なく完了', false, e && e.stack);
    } finally {
        for (const [k, v] of Object.entries(backup)) {
            await page.evaluate((kk, vv) => { if (vv === null) StorageManager.remove(kk); else StorageManager.setImmediate(kk, vv); }, k, v).catch(() => {});
        }
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n結果: PASS ' + (results.length - fail) + ' / FAIL ' + fail);
        process.exit(fail ? 1 : 0);
    }
})();
