// v1.63.0: 児童の記録(点数入力)の A〜C・5段階を、児童1人ずつ取り消せる(「✕ 取り消し」ボタン)。
//   「取り消し」＝その児童のその課題の記録を消して未入力に戻す(score:'' の空の殻は残さない。v1.60.4 L7 案B と同じ考え方)。
//   元に戻す: 8秒のトースト(uiUndoable。点数のキー1つだけ。名簿変更などの「取り消し点の枠」は使わない・触らない)。
//   欠席中の児童は取り消せない(A〜Cの入力も欠席中は押せないのと同じ)。対象は A〜C・5段階だけ(数値入力・まとめテスト等は変えない)。
//
// 本番の操作経路: 児童の記録の入力画面で、表示モード(リスト・連続入力・座席)のボタンを実際にクリックする(page.click)。
//   連続入力は「入力済みのセルをタップ → 開いた入力画面の『取り消し』」。座席は各セルの『取り消し』。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node abc-cancel.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚'];
const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score, createdAt: '2026-05-10T00:00:00Z' }, extra || {});
// 1=発言(主体性・5段階) 2=音読(知識・5段階) 3=漢字(知識・数値)
const TESTS = [
    T({ id: 1, name: '発言', category: '主体性', maxScore: 0, inputMode: 'abc5' }),
    T({ id: 2, name: '音読', category: '知識・技能', maxScore: 0, inputMode: 'abc5' }),
    T({ id: 3, name: '漢字', category: '知識・技能', maxScore: 10 })
];
// 発言: 甲A 乙B+ 丙B 丁B- 戊C / 己=欠席(点数Aを保持) / 庚=未入力。音読: 甲B 乙A 丙B。漢字: 全員8点
const SCORES = [
    S(1, 0, 'A'), S(1, 1, 'B+'), S(1, 2, 'B'), S(1, 3, 'B-'), S(1, 4, 'C'), S(1, 5, 'A', { absent: true }),
    S(2, 0, 'B'), S(2, 1, 'A'), S(2, 2, 'B'),
    S(3, 0, 8), S(3, 1, 8), S(3, 2, 8), S(3, 3, 8), S(3, 4, 8), S(3, 5, 8), S(3, 6, 8)
];
const without = (arr, testId, i) => arr.filter(s => !(s.testId === testId && s.studentIndex === i));

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol, seating: KEYS.seating }));

    // 名簿・課題・記録を入れて再読み込み(名簿の人数ぶんの座席も並べる)
    async function seed(names, scores) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.names.map(n => ({ name: n })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests); put(K.scores, d.scores); put(K.assigns, []); put(K.subs, []);
            put(K.att, {}); put(K.weights, {}); put(K.patrol, []);
            const seat = {}; d.names.forEach((_, i) => { seat[Math.floor(i / 6) + '-' + (i % 6)] = i; }); put(K.seating, seat);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.ext);
        }, K, { names, tests: TESTS, scores });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(500);
    }
    const recs = () => page.evaluate(() => JSON.parse(StorageManager.getRaw(KEYS.scores) || '[]'));
    const rec = async (testId, i) => (await recs()).find(s => s.testId === testId && s.studentIndex === i) || null;
    const gradeSnap = () => page.evaluate(() => JSON.stringify(grdCalculate('国語', '1').map(r => [r.name, r.knowledge.avg, r.knowledge.abc, r.attitude.avg, r.attitude.abc, r.hyoutei])));
    const toast = () => page.evaluate(() => {
        const t = document.getElementById('toast'), b = document.getElementById('toastUndoBtn');
        return { show: t.classList.contains('show'), msg: (document.getElementById('toastMsg') || {}).textContent || '', undo: !!b && b.style.display !== 'none' };
    });
    const progress = () => page.evaluate(() => (document.getElementById('recProgress') || {}).textContent.trim());
    const contProgress = () => page.evaluate(() => (document.getElementById('recContProgress') || {}).textContent.trim());
    // 取り消し点の枠(名簿変更などの全データの写し)と、課題・名簿のキー: 取り消しの操作で1文字も変わらないこと
    const slotDump = () => page.evaluate(() => {
        const o = {};
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^spa_roster_(snapshot|txn)|^spa_undo_|^spa_student_archive$/.test(k)) o[k] = localStorage.getItem(k); }
        o.__tests = StorageManager.getRaw(KEYS.tests); o.__master = StorageManager.getRaw(KEYS.master);
        return JSON.stringify(o);
    });
    const openTest = async (testId, mode) => {
        await page.evaluate((testId) => { showView('records'); recSelectTestGoto(testId); }, testId);
        await sleep(400);
        const btn = { list: '#recViewListBtn', continuous: '#recViewContBtn', seat: '#recViewSeatBtn' }[mode];
        await page.click(btn);
        await sleep(400);
    };
    // モードごとの「取り消し」ボタンの場所(連続入力は、入力済みセルをタップして入力画面を開いてから)
    const cancelSel = (mode, i) => ({ list: '#rec-row-' + i, continuous: '#recContGrid .rec-cont-cell.editing', seat: '#recSeatGrid' }[mode]) + ' .rec-cancel-btn' + (mode === 'seat' ? '[data-cancel-idx="' + i + '"]' : '');
    const openCancel = async (mode, i) => {
        if (mode === 'continuous') { await page.click('#recContGrid .rec-cont-cell[data-cidx="' + i + '"]'); await sleep(250); }
        return cancelSel(mode, i);
    };
    const btnInfo = (sel) => page.evaluate((sel) => {
        const b = document.querySelector(sel); if (!b) return null;
        const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { w: r.width, h: r.height, disabled: b.disabled, text: b.textContent.trim(), borderStyle: cs.borderTopStyle, inAbcBtns: !!b.closest('.rec-abc-btns'), isAbcBtn: b.classList.contains('rec-abc-btn'), hitSelf: hit === b || b.contains(hit) };
    }, sel);

    try {
        // ===== 準備: 成績の「対照」= 発言の乙(B+)を、はじめから入力していない場合の成績 =====
        await seed(NAMES, without(SCORES, 1, 1));
        const G_CONTROL = await gradeSnap();
        await seed(NAMES, SCORES);
        const G_ORIG = await gradeSnap();
        check('準備: 対照(乙の発言なし)と元の成績は、乙の主体性だけ違う', G_CONTROL !== G_ORIG && JSON.parse(G_CONTROL).filter((r, i) => JSON.stringify(r) !== JSON.stringify(JSON.parse(G_ORIG)[i])).length === 1, G_CONTROL + ' / ' + G_ORIG);

        for (const mode of ['list', 'continuous', 'seat']) {
            const M = '[' + { list: 'リスト', continuous: '連続入力', seat: '座席' }[mode] + '] ';
            try {
            await seed(NAMES, SCORES);
            const slots0 = await slotDump();
            const all0 = await recs();
            await openTest(1, mode);

            // ---- ボタンの見た目・大きさ・区別 ----
            const selOk = await openCancel(mode, 1);
            const bi = await btnInfo(selOk);
            check(M + '入力済み(乙B+)の児童に「取り消し」ボタンがあり、押せる', bi && bi.disabled === false, JSON.stringify(bi));
            check(M + 'タップ領域が 44×44px 以上', bi && bi.w >= 44 && bi.h >= 44, bi ? bi.w.toFixed(1) + '×' + bi.h.toFixed(1) : 'なし');
            check(M + '選択肢(A〜C)と区別できる(選択肢のボタンではない・点線の枠・「取り消し」の文字)', bi && !bi.isAbcBtn && !bi.inAbcBtns && bi.borderStyle === 'dashed' && /取り消し/.test(bi.text), JSON.stringify(bi));
            check(M + 'ボタンの中心をタップすると、ボタン自身に当たる(ほかの要素に隠れていない)', bi && bi.hitSelf === true);
            if (mode !== 'continuous') {
                const bUnfilled = await btnInfo(cancelSel(mode, 6));
                check(M + '未入力(庚)の児童は「取り消し」が押せない(薄い)', bUnfilled && bUnfilled.disabled === true, JSON.stringify(bUnfilled));
                const bAbsent = await btnInfo(cancelSel(mode, 5));
                check(M + '欠席中(己)の児童も「取り消し」が押せない', bAbsent && bAbsent.disabled === true, JSON.stringify(bAbsent));
            }
            const P0 = await progress(), CP0 = await contProgress();
            check(M + '取り消す前の進捗は「6 / 7 人入力済み」(欠席の記録も数える。今までどおり)', /^6 \/ 7 人入力済み/.test(P0), P0);

            // ---- 取り消す(本番のクリック) ----
            await page.click(selOk);
            await sleep(500);
            check(M + '乙(発言)の記録が消える(空の殻 {score:""} も残らない)', (await rec(1, 1)) === null, JSON.stringify(await rec(1, 1)));
            const all1 = await recs();
            check(M + 'ほかの児童・ほかの課題の記録は1件も変わらない(乙の発言の1件だけ減る)', JSON.stringify(all1) === JSON.stringify(without(all0, 1, 1)), all1.length + '件');
            check(M + '進捗が「5 / 7 人入力済み」に減る', /^5 \/ 7 人入力済み/.test(await progress()), await progress());
            if (mode === 'continuous') check(M + '連続入力の進捗も 6→5 に減る(取り消した直後にBが自動で入らない)', CP0 === '6 / 7' && (await contProgress()) === '5 / 7', CP0 + ' → ' + await contProgress());
            const t1 = await toast();
            check(M + '確認ダイアログではなく、「元に戻す」つきのトーストが出る(「2番 乙 の「B+」を取り消しました」)', t1.show && t1.undo && /2番 乙 の「B\+」を取り消しました/.test(t1.msg), JSON.stringify(t1));
            const bAfter = await btnInfo(cancelSel(mode, 1).replace('.rec-cont-cell.editing', '.rec-cont-cell'));
            check(M + '取り消した児童の「取り消し」は押せなくなる(連続入力は入力画面が閉じる)', mode === 'continuous' ? bAfter === null : (bAfter && bAfter.disabled === true), JSON.stringify(bAfter));
            check(M + '成績: 乙の主体性が、はじめから入力していない場合と同じ「未評価」になる(ほかは変わらない)', (await gradeSnap()) === G_CONTROL, await gradeSnap());
            check(M + '取り消し点の枠(名簿変更などの写し)・課題・名簿は1文字も変わらない', (await slotDump()) === slots0);

            // ---- 元に戻す ----
            await page.click('#toastUndoBtn');
            await sleep(500);
            const back = await rec(1, 1);
            check(M + '「元に戻す」で、乙の記録が元どおり(id・値・作成日時まで同じ)に戻る', JSON.stringify(back) === JSON.stringify(all0.find(s => s.testId === 1 && s.studentIndex === 1)), JSON.stringify(back));
            check(M + '「元に戻す」で、記録全体も取り消す前と同じ・進捗も 6/7 に戻る', JSON.stringify(await recs()) === JSON.stringify(all0) && /^6 \/ 7 人入力済み/.test(await progress()), await progress());
            check(M + '「元に戻す」で、成績も元と同じ', (await gradeSnap()) === G_ORIG);
            check(M + '「元に戻す」のあと、画面にも入力済み(B+)が戻る', await page.evaluate((mode) => {
                if (mode === 'list') return !!document.querySelector('#rec-row-1 .rec-abc-btn.sel-bplus');
                if (mode === 'continuous') return /B\+/.test(document.querySelector('#recContGrid .rec-cont-cell[data-cidx="1"] .sub-cont-mark').textContent);
                return /B\+/.test(document.querySelectorAll('#recSeatGrid .rec-seat-cell')[1].textContent);
            }, mode));
            check(M + '取り消し・元に戻すのあとも、枠・課題・名簿は変わらない', (await slotDump()) === slots0);

            // ---- 欠席中の児童 ----
            const absentBefore = await rec(1, 5);
            await page.evaluate(() => recCancelABC(5)); // 画面のボタンは押せない(disabled)ので、関数を直接呼んでも取り消せないことを確かめる
            await sleep(300);
            check(M + '欠席中(己)は、取り消せない(欠席の印も、保持している点数Aもそのまま)', JSON.stringify(await rec(1, 5)) === JSON.stringify(absentBefore), JSON.stringify(await rec(1, 5)));
            check(M + '  → 「欠席のため取り消せません」の案内が出る', /欠席のため取り消せません/.test((await toast()).msg), (await toast()).msg);
            check(M + '  → 成績は変わらない(欠席中は未評価のまま)', (await gradeSnap()) === G_ORIG);

            // ---- 未入力の児童・取り消す入力がない ----
            await page.evaluate(() => recCancelABC(6));
            await sleep(300);
            check(M + '未入力(庚)に対して呼んでも、記録を作らない(空の殻を作らない)', (await rec(1, 6)) === null && JSON.stringify(await recs()) === JSON.stringify(all0));

            // ---- 数値入力の課題には出ない・変わらない ----
            await openTest(3, mode);
            const numHas = await page.evaluate((mode) => {
                if (mode === 'continuous') return document.querySelectorAll('#recContGrid .rec-cancel-btn').length;
                return document.querySelectorAll((mode === 'list' ? '#recList' : '#recSeatGrid') + ' .rec-cancel-btn').length;
            }, mode);
            check(M + '数値入力の課題(漢字)には「取り消し」ボタンが出ない(今回は変えない)', numHas === 0, String(numHas));
            await page.evaluate(() => recCancelABC(1));
            await sleep(300);
            check(M + '数値入力の課題では、関数を直接呼んでも記録は消えない', JSON.stringify(await recs()) === JSON.stringify(all0));
            } catch (e) { check(M + '操作中に例外なし(ボタンが無い等)', false, String(e && e.message || e).split('\n')[0]); }
        }

        // ===== 取り消したあと、入力し直せる・連続の取り消し・元に戻せない場合 =====
        await seed(NAMES, SCORES);
        const all2 = await recs();
        await openTest(1, 'list');
        await page.click('#rec-row-1 .rec-cancel-btn');
        await sleep(400);
        await page.click('#rec-row-1 .rec-abc-btn:nth-child(5)'); // 乙に C を入れ直す
        await sleep(400);
        const re = await rec(1, 1);
        check('取り消したあと、同じ児童にCを入れ直せる(通常の入力と同じ記録ができる)', re && re.score === 'C' && re.absent === undefined, JSON.stringify(re));
        await page.click('#toastUndoBtn').catch(() => {});
        await sleep(300);

        await seed(NAMES, SCORES);
        await openTest(1, 'list');
        await page.click('#rec-row-2 .rec-cancel-btn'); // 丙(B)を取り消す
        await sleep(400);
        await page.click('#rec-row-3 .rec-abc-btn:nth-child(1)'); // そのあと丁をAに直す(別の変更)
        await sleep(400);
        const tIn = await toast();
        // 直近のトースト(取り消しのもの)が残っていれば「元に戻す」を押す。競合なら戻さない
        check('別の変更のあとも、取り消しの「元に戻す」はまだ画面にある', tIn.undo && /3番 丙 の「B」/.test(tIn.msg), JSON.stringify(tIn));
        await page.click('#toastUndoBtn'); await sleep(400);
        const r2 = await rec(1, 2), r3 = await rec(1, 3);
        check('取り消したあとに別の変更をした場合、「元に戻す」は書き戻さない(あとの変更を消さない)', r2 === null && r3 && r3.score === 'A', JSON.stringify([r2, r3]));
        check('  → 「そのあとに変更があったため、元に戻せませんでした」と知らせる', /そのあとに変更があったため、元に戻せませんでした/.test((await toast()).msg), (await toast()).msg);

        await seed(NAMES, SCORES);
        await openTest(1, 'list');
        await page.click('#rec-row-0 .rec-cancel-btn');
        await sleep(300);
        await page.click('#rec-row-4 .rec-cancel-btn'); // 続けて別の児童も取り消す
        await sleep(300);
        check('続けて別の児童を取り消せる(甲・戊とも記録が消え、ほかの児童は残る)', (await rec(1, 0)) === null && (await rec(1, 4)) === null && (await recs()).filter(s => s.testId === 1).length === 4);
        const tSecond = await toast();
        check('  → 「元に戻す」は直近の取り消し(戊)の分', tSecond.undo && /5番 戊 の「C」/.test(tSecond.msg), tSecond.msg);
        await page.click('#toastUndoBtn');
        await sleep(400);
        check('  → 戊は元に戻り、甲は取り消したまま', (await rec(1, 4)) && (await rec(1, 4)).score === 'C' && (await rec(1, 0)) === null);

        // ===== 30人・横/縦: カードが重ならない・中身がはみ出さない・ボタンがカードの中・タップ領域 =====
        const N30 = []; for (let i = 0; i < 30; i++) N30.push('児童' + String.fromCharCode(0x30A2 + i) + '田花子');
        const sc30 = [];
        N30.forEach((_, i) => { if (i % 2 === 0) sc30.push(S(1, i, ['A', 'B+', 'B', 'B-', 'C'][i % 5])); });
        await seed(N30, sc30);
        for (const vp of [{ w: 1180, h: 820, n: '横1180x820' }, { w: 820, h: 1180, n: '縦820x1180' }]) {
            await page.setViewport({ width: vp.w, height: vp.h });
            await sleep(300);
            for (const mode of ['list', 'seat']) {
                await openTest(1, mode);
                const g = await page.evaluate((mode) => {
                    const cells = Array.from(document.querySelectorAll(mode === 'list' ? '#recList .rec-row.abc-row' : '#recSeatGrid .rec-seat-cell'));
                    const rects = cells.map(c => c.getBoundingClientRect());
                    let overflow = 0, overlap = 0, small = 0, btnOutside = 0, textCut = 0, textOverBtn = 0;
                    cells.forEach((c, i) => {
                        const cr = rects[i];
                        const b = c.querySelector('.rec-cancel-btn'); const br = b.getBoundingClientRect();
                        if (br.width < 43.5 || br.height < 43.5) small++;
                        if (br.bottom > cr.bottom + 0.5 || br.top < cr.top - 0.5 || br.right > cr.right + 0.5 || br.left < cr.left - 0.5) btnOutside++;
                        Array.from(c.children).forEach(ch => { const r = ch.getBoundingClientRect(); if (r.bottom > cr.bottom + 0.5 || r.top < cr.top - 0.5) overflow++; });
                        if (b.scrollWidth > b.clientWidth + 1) textCut++; // ボタンの文字が、ボタンの枠から切れていない
                        // 座席: 氏名・入力の文字が、取り消しボタンに重ならず、セルの中に収まる(狭いセルでは折り返してボタンを下に置く)
                        c.querySelectorAll('.sub-seat-name, .sub-seat-status, .sub-row-name').forEach(el => {
                            const rg = document.createRange(); rg.selectNodeContents(el); const tr = rg.getBoundingClientRect();
                            if (tr.width && (tr.right > cr.right + 0.5 || tr.left < cr.left - 0.5)) textOverBtn++;
                            if (tr.width && tr.left < br.right - 0.5 && br.left < tr.right - 0.5 && tr.top < br.bottom - 0.5 && br.top < tr.bottom - 0.5) textOverBtn++;
                        });
                        for (let j = i + 1; j < cells.length; j++) { const o = rects[j]; if (cr.left < o.right - 1 && o.left < cr.right - 1 && cr.top < o.bottom - 1 && o.top < cr.bottom - 1) overlap++; }
                    });
                    return { n: cells.length, overflow, overlap, small, btnOutside, textCut, textOverBtn };
                }, mode);
                const M2 = '[' + vp.n + ' ' + (mode === 'list' ? 'リスト' : '座席') + '・30人] ';
                check(M2 + '30人ぶんのカードがあり、どのカードもボタンが 44×44px 以上', g.n === 30 && g.small === 0, JSON.stringify(g));
                check(M2 + 'カードが重ならない・中身がカードからはみ出さない・ボタンがカードの中にある', g.overlap === 0 && g.overflow === 0 && g.btnOutside === 0, JSON.stringify(g));
                check(M2 + '氏名・入力の文字が「取り消し」ボタンに重ならず、ボタンの文字も枠から切れない', g.textOverBtn === 0 && g.textCut === 0, JSON.stringify(g));
            }
            // リストは、最後の児童(30番)まで縦にスクロールして届く(実際のタッチのなぞりで)
            await openTest(1, 'list');
            const cdp = await page.createCDPSession();
            const box = await page.evaluate(() => { const r = document.getElementById('recList').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
            for (let k = 0; k < 6; k++) { await cdp.send('Input.synthesizeScrollGesture', { x: box.x, y: box.y, yDistance: -500, gestureSourceType: 'touch', speed: 1500 }); await sleep(200); }
            const reach = await page.evaluate(() => {
                const list = document.getElementById('recList').getBoundingClientRect();
                const b = document.querySelector('#rec-row-29 .rec-cancel-btn').getBoundingClientRect();
                const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                return { inside: b.top >= list.top - 0.5 && b.bottom <= list.bottom + 0.5, front: hit === document.querySelector('#rec-row-29 .rec-cancel-btn') };
            });
            check('[' + vp.n + '] リスト(30人): 縦になぞると最後の児童(30番)の「取り消し」まで届き、最前面でタップできる', reach.inside && reach.front, JSON.stringify(reach));
            await cdp.detach();
        }
        await page.setViewport({ width: 1180, height: 820 });

        const sw = await page.evaluate(async () => (await (await fetch('./sw.js?nocache=' + Date.now())).text()).match(/CACHE_VERSION = '([^']*)'/)[1]);
        // 版は「この変更を入れた v1.63.0 以上」であること(次の版に上げても、この検査は通り続ける。上げ忘れ=v1.62.0 以下は失敗する)
        const vp3 = String(sw).replace(/^v/, '').split('.').map(Number);
        check('sw.js の CACHE_VERSION が v1.63.0 以上', vp3.length === 3 && vp3.every(n => !isNaN(n)) && (vp3[0] > 1 || (vp3[0] === 1 && (vp3[1] > 63 || (vp3[1] === 63 && vp3[2] >= 0)))), sw);

        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));
    } catch (e) {
        check('テスト実行中に例外なし', false, String(e && e.stack || e));
    }
    await browser.close();
    const failed = results.filter(r => !r.pass).length;
    console.log('\n合計 ' + results.length + ' 件 / 成功 ' + (results.length - failed) + ' / 失敗 ' + failed);
    process.exit(failed ? 1 : 0);
})();
