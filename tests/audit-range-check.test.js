// 段階0.5/0.6 機械検証: checkStructuralIntegrity の範囲外スコア検出 +
// 監査結果画面へのバージョン表示（成績入力形式統一プロジェクト、段階1着手前の事前診断用）
//
// 検証項目:
//   1. 負の点数を持つレコードが検出される
//   2. maxScore超過レコードが検出される。ただし maxScore===9999(実技記録の
//      「変換不要」マーカー)は完全一致で除外され、誤検出しないこと
//   3. maxScore欠損/0(まとめテストの0は除く)なのに数値スコアが入っている
//      レコードが検出される
//   4. 内訳(detail)にstudentIndexのみが含まれ、氏名フィールドが含まれないこと。
//      監査結果の描画HTMLにも実際の氏名文字列が現れないこと
//   5. window.runAuditDiagnosis()(実装のエントリポイント)を実際に呼んで
//      検証する（ロジックの抜き出し・ハードコピーはしない）
//   6. (段階0.6) 監査結果「1. データ量サマリー」に、実際に配信されている
//      sw.jsのCACHE_VERSIONと一致するバージョンが表示されること
//      （ハードコードした期待値ではなく、sw.jsから動的に読み取って比較する）
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-range-check.test.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const swSrc = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const swVerMatch = swSrc.match(/CACHE_VERSION\s*=\s*'([^']+)'/);
const EXPECTED_VERSION = swVerMatch ? swVerMatch[1] : null;

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

    const REAL_KEYS = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, submissions: KEYS.submissions_data }));
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
        // 氏名は実データと紛れないよう識別しやすいダミー名にする(HTMLに漏れていないことの検証用)。
        const students = [{ name: '検証用A' }, { name: '検証用B' }, { name: '検証用C' }, { name: '検証用D' }, { name: '検証用E' }];

        const ID = { normal: now + 1, negative: now + 2, overMax: now + 3, marker9999: now + 4, noMax: now + 5, matome: now + 6, cScore: now + 7 };

        function T(id, subject, testType, maxScore, extra) {
            return Object.assign({ id, subject, category: '知識・技能', testType, type: 'standard', maxScore, date: '2026-06-01', createdAt: new Date().toISOString() }, extra || {});
        }

        const tests = [
            T(ID.normal, '国語', '小テスト', 100),
            T(ID.negative, '国語', '小テスト', 100),
            T(ID.overMax, '国語', '小テスト', 50),
            T(ID.marker9999, '体育', '実技記録', 9999, { peUnit: '点' }),
            T(ID.noMax, '算数', '授業課題', 0),
            T(ID.matome, '算数', 'まとめテスト', 0, { type: 'matome' }),
            // 段階3: B-1(score='C')・B-5('late')の陳腐化した警告が削除されたことを、
            // 実際にその状況を作った上で確認する(C評価・lateステータスとも0件だから
            // 出ない、では検証にならないため)。
            T(ID.cScore, '国語', 'ルーブリック', 0, { category: '主体性' })
        ];

        const scores = [
            { testId: ID.normal, studentIndex: 0, score: 80 },      // 正常
            { testId: ID.negative, studentIndex: 1, score: -5 },    // 負の点数
            { testId: ID.overMax, studentIndex: 2, score: 70 },     // maxScore=50超過
            { testId: ID.marker9999, studentIndex: 3, score: 50000 }, // maxScore=9999は完全一致で除外されるべき
            { testId: ID.noMax, studentIndex: 4, score: 30 },       // maxScore=0なのに数値スコア
            { testId: ID.matome, studentIndex: 4, score: 12 },      // まとめテストのmaxScore=0は正常(除外対象)
            { testId: ID.cScore, studentIndex: 0, score: 'C' }      // B-1警告(削除対象)を発生させる材料
        ];

        const submissions = [
            { id: 'audit-range-late-1', assignmentId: 'audit-range-fake-assign', studentIndex: 0, status: 'late' } // B-5警告(削除対象)を発生させる材料
        ];

        await page.evaluate(({ tests, scores, students, submissions }) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: students,
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
            StorageManager.setImmediate(KEYS.submissions_data, JSON.stringify(submissions));
        }, { tests, scores, students, submissions });

        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));

        // appVersion(#ver-disp と同じ値)は Service Worker への postMessage 往復で
        // 非同期に確定する。navigator.serviceWorker.ready を待ってから余裕を持たせることで、
        // 固定待機時間だけに頼らず版取得のタイミングを揃える。
        await page.evaluate(async () => {
            if ('serviceWorker' in navigator) {
                try { await navigator.serviceWorker.ready; } catch (e) {}
            }
        });
        await new Promise(r => setTimeout(r, 300));

        // runAuditDiagnosis() は実装のエントリポイント(window公開済み)をそのまま呼ぶ。
        // 内部はsetTimeout(50ms)後に結果を確定するため、余裕を見て待つ。
        await page.evaluate(() => { window.runAuditDiagnosis(); });
        await new Promise(r => setTimeout(r, 500));

        const si = await page.evaluate(() => (window._auditDiagnosisLastResult || {}).structuralIntegrity);
        const anomalies = await page.evaluate(() => (window._auditDiagnosisLastResult || {}).anomalies);
        const meta = await page.evaluate(() => (window._auditDiagnosisLastResult || {}).meta);
        const scoreTypes = await page.evaluate(() => (window._auditDiagnosisLastResult || {}).scoreTypes);
        const submissionStatus = await page.evaluate(() => (window._auditDiagnosisLastResult || {}).submissionStatus);
        const html = await page.evaluate(() => {
            var el = document.getElementById('audit-result-container');
            return el ? el.innerHTML : '';
        });

        // ---- 1. 負の点数 ----
        check('負の点数が1件検出される', si && si.negativeScores === 1, JSON.stringify(si && si.negativeScoreDetail));
        check('負の点数の内訳に studentIndex=1・score=-5 が含まれる',
            si && si.negativeScoreDetail.some(function(d) { return d.studentIndex === 1 && d.score === -5; }),
            JSON.stringify(si && si.negativeScoreDetail));
        check('負の点数の内訳に氏名フィールドが含まれない(studentIndexのみ)',
            si && si.negativeScoreDetail.every(function(d) { return !('name' in d); }),
            JSON.stringify(si && si.negativeScoreDetail));

        // ---- 2. maxScore超過(9999マーカー除外) ----
        check('maxScore超過が1件検出される(9999マーカーは含まない)', si && si.overMaxScores === 1, JSON.stringify(si && si.overMaxScoreDetail));
        check('maxScore超過の内訳が testId/score/maxScore とも一致する',
            si && si.overMaxScoreDetail.some(function(d) { return d.testId === ID.overMax && d.score === 70 && d.maxScore === 50; }),
            JSON.stringify(si && si.overMaxScoreDetail));
        check('maxScore=9999のレコード(score=50000)はmaxScore超過として検出されない(完全一致除外)',
            si && !si.overMaxScoreDetail.some(function(d) { return d.testId === ID.marker9999; }),
            JSON.stringify(si && si.overMaxScoreDetail));

        // ---- 3. maxScore欠損/0なのに数値スコアあり ----
        check('maxScore欠損/0なのに数値スコアが1件検出される', si && si.numericScoreNoMaxScore === 1, JSON.stringify(si && si.numericScoreNoMaxScoreDetail));
        check('まとめテスト(type=matome)のmaxScore=0は誤検出されない',
            si && !si.numericScoreNoMaxScoreDetail.some(function(d) { return d.testId === ID.matome; }),
            JSON.stringify(si && si.numericScoreNoMaxScoreDetail));

        // ---- collectAnomalies への反映 ----
        check('collectAnomaliesのcriticalに負の点数とmaxScore超過が含まれる',
            anomalies && anomalies.critical.some(function(m) { return m.indexOf('負の点数') >= 0; })
                && anomalies.critical.some(function(m) { return m.indexOf('maxScore を超過') >= 0; }),
            JSON.stringify(anomalies && anomalies.critical));
        check('collectAnomaliesのwarnにmaxScore欠損/0の数値スコアが含まれる',
            anomalies && anomalies.warn.some(function(m) { return m.indexOf('maxScore 欠損/0なのに数値スコア') >= 0; }),
            JSON.stringify(anomalies && anomalies.warn));

        // ---- 段階3: B-1(score='C')・B-5('late')の陳腐化した警告が削除されていること ----
        // まずデータが本当に存在すること(=削除対象の状況を実際に作れていること)を確認してから、
        // その状況下でも警告文言が出ないことを確認する(0件だから出ない、という偽陰性を防ぐ)。
        check('(前提) score=\'C\'のレコードが実際に1件存在する', scoreTypes && scoreTypes.abc.C === 1, JSON.stringify(scoreTypes && scoreTypes.abc));
        check('(前提) \'late\'ステータスの提出記録が実際に1件存在する', submissionStatus && submissionStatus.byStatus.late === 1, JSON.stringify(submissionStatus && submissionStatus.byStatus));
        check('B-1警告(score=\'C\'...)がcollectAnomaliesのinfoに含まれない',
            anomalies && !anomalies.info.some(function(m) { return m.indexOf('B-1') >= 0; }), JSON.stringify(anomalies && anomalies.info));
        check('B-5警告(\'late\'ステータス...)がcollectAnomaliesのinfoに含まれない',
            anomalies && !anomalies.info.some(function(m) { return m.indexOf('B-5') >= 0; }), JSON.stringify(anomalies && anomalies.info));

        // ---- UI描画(iPadの実運用画面と同じHTML) ----
        check('監査結果HTMLに「負の点数」の行が描画される', html.indexOf('負の点数') >= 0, '');
        check('監査結果HTMLに「maxScore超過(9999マーカーは除外)」の行が描画される', html.indexOf('maxScore超過') >= 0, '');
        check('監査結果HTMLに「maxScore欠損/0なのに数値スコアあり」の行が描画される', html.indexOf('100点満点扱いの危険') >= 0, '');
        check('監査結果HTMLに氏名(検証用A〜E)が含まれない',
            ['検証用A', '検証用B', '検証用C', '検証用D', '検証用E'].every(function(n) { return html.indexOf(n) < 0; }), '');
        check('監査結果HTML(画面表示)にB-1/B-5の警告文言が含まれない', html.indexOf('B-1') < 0 && html.indexOf('B-5') < 0, '');

        // ---- 段階0.6: データ量サマリーへのバージョン表示 ----
        check('sw.jsからCACHE_VERSIONを読み取れる(テスト自体の前提)', !!EXPECTED_VERSION, 'EXPECTED_VERSION=' + EXPECTED_VERSION);
        check('collectMeta().appVersionが配信中のsw.jsのCACHE_VERSIONと一致する(SW居座りしていない)',
            meta && meta.appVersion === EXPECTED_VERSION, 'meta.appVersion=' + (meta && meta.appVersion) + ' / expected=' + EXPECTED_VERSION);
        check('監査結果HTMLに「診断実行時のバージョン」の行が描画される', html.indexOf('診断実行時のバージョン') >= 0, '');
        check('監査結果HTMLのバージョン表示に実際のCACHE_VERSION文字列が含まれる',
            EXPECTED_VERSION && html.indexOf(EXPECTED_VERSION) >= 0, 'expected=' + EXPECTED_VERSION);
    } finally {
        for (const k of Object.values(REAL_KEYS)) await restoreKey(k, backup[k]);
    }

    let allRestored = true;
    const restoreDetail = {};
    for (const k of Object.values(REAL_KEYS)) {
        const cur = await getKey(k);
        restoreDetail[k] = (cur === backup[k]);
        if (cur !== backup[k]) allRestored = false;
    }
    check('触れた実データキーがすべて元の値に復元されている', allRestored, JSON.stringify(restoreDetail));

    const realErrors = consoleErrors.filter(e => e.indexOf('favicon.ico') === -1);
    check('検証中にコンソールエラーなし(favicon.ico除く)', realErrors.length === 0, realErrors.join(' | '));

    await browser.close();

    const fail = results.filter(r => !r.pass).length;
    console.log('\n===== 結果: PASS ' + (results.length - fail) + ' / FAIL ' + fail + ' / 合計 ' + results.length + ' =====');
    process.exit(fail > 0 ? 1 : 0);
})();
