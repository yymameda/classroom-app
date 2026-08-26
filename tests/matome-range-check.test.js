// 段階7 機械検証: まとめテストの設問別点数入力に範囲外チェックを導入(クランプ廃止)。
//
// 変更内容(index.html):
//   - recValueOutOfRange(v, max) を新設し、recScoreOutOfRange(test, v) はこれに委譲する
//     形に一般化(既存4箇所の呼び出し・挙動は無変更)
//   - recMatomeModalSave: Math.min(Math.max(0,v),pt)によるクランプを廃止し、
//     範囲外の設問は保存せずrange-errorクラスでハイライトする「部分拒否」方式に変更
//     (recSaveAllScoresと同じ方式)。戻り値は範囲外で保存されなかった設問数
//   - recMatomeModalNext/Prev: 戻り値が0より大きい間は次/前の児童へ進ませない
//   - recCloseMatomeModal: 変更なし(従来通り無条件で閉じる。範囲内の設問は
//     保存され、範囲外の設問だけ保存されない)
//   - CSS: .rec-mq-cell input.range-error を追加(既存の.rec-row-score-area
//     input.range-errorと同じ見た目を流用、新規クラスは作らない)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node matome-range-check.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

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
    await new Promise(r => setTimeout(r, 300));

    const REAL_KEYS = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores }));
    async function getKey(k) { return page.evaluate((kk) => StorageManager.getRaw(kk), k); }
    async function setKey(k, v) { await page.evaluate((kk, vv) => { StorageManager.setImmediate(kk, vv); }, k, v); }
    async function restoreKey(k, raw) {
        if (raw === null || raw === undefined) await page.evaluate((kk) => { StorageManager.remove(kk); }, k);
        else await setKey(k, raw);
    }
    const backup = {};
    for (const k of Object.values(REAL_KEYS)) backup[k] = await getKey(k);

    try {
        const now = Date.now();
        const testId = now + 1;

        await page.evaluate((tid) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: [{ name: '検証用A' }, { name: '検証用B' }, { name: '検証用C' }],
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify([
                {
                    id: tid, subject: '算数', testType: 'まとめテスト', category: '複合', name: '範囲外チェック検証',
                    type: 'matome', maxScore: 10, date: '2026-06-01', createdAt: new Date().toISOString(),
                    matomePoints: [5, 5], matomeQuestionTypes: ['知', '思'], matomeQCount: 2
                }
            ]));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify([]));
        }, testId);
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('input'); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((tid) => { window.recSelectTestGoto(tid); }, testId);
        await new Promise(r => setTimeout(r, 150));

        async function openModal(idx) {
            await page.evaluate((i) => { window.recOpenMatomeModal(i); }, idx);
            await new Promise(r => setTimeout(r, 150));
        }
        async function setInputs(v0, v1) {
            await page.evaluate((a, b) => {
                if (a !== null) document.getElementById('rec-mq-0').value = a;
                if (b !== null) document.getElementById('rec-mq-1').value = b;
                window.recUpdateMatomeTotal();
                window._recMqDirty = true;
            }, v0, v1);
        }
        async function inputState() {
            return page.evaluate(() => ({
                v0: document.getElementById('rec-mq-0') ? document.getElementById('rec-mq-0').value : null,
                v1: document.getElementById('rec-mq-1') ? document.getElementById('rec-mq-1').value : null,
                err0: document.getElementById('rec-mq-0') ? document.getElementById('rec-mq-0').classList.contains('range-error') : null,
                err1: document.getElementById('rec-mq-1') ? document.getElementById('rec-mq-1').classList.contains('range-error') : null
            }));
        }
        async function savedRecord(studentIndex) {
            return page.evaluate((tid, si) => StorageManager.get(KEYS.scores, []).find(function(s) { return s.testId === tid && s.studentIndex === si; }), testId, studentIndex);
        }
        // recMatomeStudentIndexはwindowに公開されていないため、モーダルタイトル(「N番 氏名 の...」)
        // の先頭の番号で現在表示中の児童を判定する。
        async function modalStudentNumber() {
            return page.evaluate(() => {
                var t = document.getElementById('recMatomeModalTitle').textContent;
                var m = /^(\d+)番/.exec(t);
                return m ? parseInt(m[1], 10) : null;
            });
        }

        // ================================================================
        // 1. 配点を超える値 → 保存されない・ハイライトされる
        // ================================================================
        await openModal(0);
        await setInputs('3', '99'); // Q1(配点5)=3(範囲内) / Q2(配点5)=99(範囲外)
        let rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        let sc = await savedRecord(0);
        let st = await inputState();
        check('配点超過(99>5): 戻り値が1(1問拒否)', rejectedCount === 1, String(rejectedCount));
        check('配点超過: Q1(範囲内3)は保存される、Q2(範囲外)はundefinedのまま', sc && sc.answers[0] === 3 && sc.answers[1] == null, JSON.stringify(sc));
        check('配点超過: Q2の入力欄にrange-errorが付き、値は書き換えられない(99のまま)', st.err1 === true && st.v1 === '99', JSON.stringify(st));
        check('配点超過: Q1の入力欄にはrange-errorが付かない', st.err0 === false, JSON.stringify(st));

        // ================================================================
        // 2. 負の値 → 保存されない・ハイライトされる
        // ================================================================
        await setInputs('3', '-2');
        rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        sc = await savedRecord(0);
        st = await inputState();
        check('負の値(-2): 戻り値が1', rejectedCount === 1, String(rejectedCount));
        check('負の値: Q2はundefinedのまま保存されない', sc && sc.answers[1] == null, JSON.stringify(sc));
        check('負の値: Q2にrange-errorが付き、値は書き換えられない(-2のまま)', st.err1 === true && st.v1 === '-2', JSON.stringify(st));

        // ================================================================
        // 3. 範囲内の値 → 従来どおり保存される
        // ================================================================
        await setInputs('4', '5');
        rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        sc = await savedRecord(0);
        st = await inputState();
        check('範囲内(4,5): 戻り値が0', rejectedCount === 0, String(rejectedCount));
        check('範囲内: 両方とも保存される(4,5)、score=9', sc && sc.answers[0] === 4 && sc.answers[1] === 5 && sc.score === 9, JSON.stringify(sc));
        check('範囲内: どちらもrange-errorが付かない', st.err0 === false && st.err1 === false, JSON.stringify(st));

        // ================================================================
        // 4. 小数(step=0.1) → 範囲内なら保存される
        // ================================================================
        await setInputs('2.5', '4.7');
        rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        sc = await savedRecord(0);
        check('小数(2.5, 4.7): 範囲内なので両方保存される', rejectedCount === 0 && sc && sc.answers[0] === 2.5 && sc.answers[1] === 4.7, JSON.stringify(sc));

        // ================================================================
        // 5. 空欄 → 従来どおり未入力として扱われる
        // ================================================================
        await setInputs('', '');
        rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        sc = await savedRecord(0);
        st = await inputState();
        check('空欄: 戻り値が0(空欄はエラー扱いしない)', rejectedCount === 0, String(rejectedCount));
        check('空欄: 両方undefinedで保存される(未入力)', sc && sc.answers[0] == null && sc.answers[1] == null, JSON.stringify(sc));
        check('空欄: range-errorは付かない', st.err0 === false && st.err1 === false, JSON.stringify(st));

        // ================================================================
        // 6. 範囲外を修正して再保存 → 正しく保存され、ハイライトが消える
        // ================================================================
        await setInputs('3', '20');
        rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        check('修正前(前提): Q2(20)が範囲外で拒否される', rejectedCount === 1, String(rejectedCount));
        await setInputs(null, '4'); // Q2だけ範囲内に修正(Q1はそのまま)
        rejectedCount = await page.evaluate(() => window.recMatomeModalSave());
        sc = await savedRecord(0);
        st = await inputState();
        check('修正後: 戻り値が0(全問正常)', rejectedCount === 0, String(rejectedCount));
        check('修正後: Q2が正しく保存される(4)', sc && sc.answers[0] === 3 && sc.answers[1] === 4, JSON.stringify(sc));
        check('修正後: Q2のrange-errorが消える', st.err1 === false, JSON.stringify(st));

        // ================================================================
        // 7. 状態遷移: 範囲外がある状態でNextを呼んでも児童が切り替わらないこと
        // ================================================================
        await setInputs('3', '999');
        const beforeNext = await modalStudentNumber();
        await page.evaluate(() => { window.recMatomeModalNext(); });
        await new Promise(r => setTimeout(r, 150));
        const afterNextBlocked = await modalStudentNumber();
        sc = await savedRecord(0);
        check('Next: 範囲外(999)がある状態では表示中の児童番号が変わらない(児童が切り替わらない)', beforeNext === afterNextBlocked && afterNextBlocked === 1, JSON.stringify({ before: beforeNext, after: afterNextBlocked }));
        check('Next: ブロックされても範囲内のQ1(3)は保存される', sc && sc.answers[0] === 3 && sc.answers[1] == null, JSON.stringify(sc));

        // ================================================================
        // 8. Prevも同様にブロックされること
        // ================================================================
        const beforePrev = await modalStudentNumber();
        await page.evaluate(() => { window.recMatomeModalPrev(); });
        await new Promise(r => setTimeout(r, 150));
        const afterPrevBlocked = await modalStudentNumber();
        check('Prev: 範囲外(999)が残っている状態では表示中の児童番号が変わらない', beforePrev === afterPrevBlocked, JSON.stringify({ before: beforePrev, after: afterPrevBlocked }));

        // ================================================================
        // 9. 範囲外を修正してからNextを呼べば、正しく次の児童へ進むこと
        // ================================================================
        await setInputs(null, '4'); // 999→4に修正
        await page.evaluate(() => { window.recMatomeModalNext(); });
        await new Promise(r => setTimeout(r, 150));
        const afterNextOk = await modalStudentNumber();
        sc = await savedRecord(0);
        check('修正後のNext: 児童0の記録が保存される(3,4)', sc && sc.answers[0] === 3 && sc.answers[1] === 4, JSON.stringify(sc));
        check('修正後のNext: 表示中の児童番号が2番(studentIndex=1)に進む', afterNextOk === 2, String(afterNextOk));

        // ================================================================
        // 10. 範囲外がある状態でrecCloseMatomeModalを呼ぶと、範囲内の設問だけ
        //     保存され、モーダルは閉じること
        // ================================================================
        await setInputs('4', '888'); // 児童1に対して: Q1範囲内・Q2範囲外
        await page.evaluate(() => { window.recCloseMatomeModal(); });
        await new Promise(r => setTimeout(r, 150));
        const modalActiveAfterClose = await page.evaluate(() => document.getElementById('recMatomeModal').classList.contains('active'));
        sc = await savedRecord(1);
        check('Close: モーダルが閉じる(activeクラスが外れる)', modalActiveAfterClose === false, String(modalActiveAfterClose));
        check('Close: 範囲内のQ1(4)は保存され、範囲外のQ2は保存されない(undefined)', sc && sc.answers[0] === 4 && sc.answers[1] == null, JSON.stringify(sc));

        // ================================================================
        // 11. 閉じたあと同じ児童のモーダルを開き直すと、範囲内の値は残り、
        //     範囲外だった設問は空欄になっていること
        // ================================================================
        await openModal(1);
        const reopenedState = await inputState();
        check('再オープン: 範囲内だったQ1(4)の値が残っている', reopenedState.v0 === '4', JSON.stringify(reopenedState));
        check('再オープン: 範囲外だったQ2は空欄になっている(保存されなかったため)', reopenedState.v1 === '', JSON.stringify(reopenedState));
        check('再オープン: どちらもrange-errorは付かない(再描画でクラスは初期化される)', reopenedState.err0 === false && reopenedState.err1 === false, JSON.stringify(reopenedState));
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });

        // ================================================================
        // 12. 既存の1学期のまとめテストの点数が変わらないこと(旧クランプ時代の
        //     データを模した既存レコードを開いても書き換わらないことの確認)
        // ================================================================
        // recGetScores()はモジュール内キャッシュ(_scoresCache)を持ち、recSaveScores()経由
        // 以外の直接書き込みでは無効化されない。直接注入した内容を確実に反映させるため
        // reloadしてキャッシュを作り直す(このファイル冒頭のセットアップと同じ手順)。
        await page.evaluate((tid) => {
            var scores = StorageManager.get(KEYS.scores, []);
            scores.push({ id: 999001, studentIndex: 2, testId: tid, score: 9, answers: [4, 5], createdAt: '2026-05-01T00:00:00.000Z' });
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
        }, testId);
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));
        await page.evaluate(() => { window.showView('records'); window.recShowSub('input'); });
        await new Promise(r => setTimeout(r, 150));
        await page.evaluate((tid) => { window.recSelectTestGoto(tid); }, testId);
        await new Promise(r => setTimeout(r, 150));
        await openModal(2);
        const existingState = await inputState();
        check('既存データ: 確定済みの点数(4,5)がそのまま表示される(書き換わらない)', existingState.v0 === '4' && existingState.v1 === '5', JSON.stringify(existingState));
        // 何も変更せず保存しても値が変わらないこと
        const rejectedExisting = await page.evaluate(() => window.recMatomeModalSave());
        const scExisting = await savedRecord(2);
        check('既存データ: 変更せず保存しても値(4,5)・score(9)が変わらない', rejectedExisting === 0 && scExisting.answers[0] === 4 && scExisting.answers[1] === 5 && scExisting.score === 9, JSON.stringify(scExisting));
        await page.evaluate(() => { document.getElementById('recMatomeModal').classList.remove('active'); });

        // ================================================================
        // コンソールエラーの回帰確認
        // ================================================================
        const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
        check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
        const restored = {};
        for (const k of Object.values(REAL_KEYS)) restored[k] = await getKey(k);
        const allRestored = Object.values(REAL_KEYS).every(k => restored[k] === backup[k]);
        check('触れた実データキーがすべて元の値に復元されている', allRestored, JSON.stringify({ restored: Object.keys(REAL_KEYS) }));
        await browser.close();
    }

    const fail = results.filter(r => !r.pass).length;
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail) + '件 / 失敗: ' + fail + '件');
    process.exit(fail > 0 ? 1 : 0);
})();
