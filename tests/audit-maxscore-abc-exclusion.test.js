// 段階9-2 機械検証: checkStructuralIntegrity の maxScore 欠損/0 判定に、
// 5段階項目(isABCTest)の除外を追加したことの検証。
//
// 変更内容(index.html):
//   - maxScoreMissing / maxScoreEmptyBreakdown の filter条件に
//     `&& !isABCTest(t.category, t.testType)` を追加(2箇所とも)
//   - 判定はisABCTestを経由(条件式そのものはコピーしない)
//   - numericScoreNoMaxScore は無変更(typeof sc.score === 'number'で
//     ABC評価の文字列スコアは元々除外されており、isABCTestに依存しない)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-maxscore-abc-exclusion.test.js

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
        const students = [{ name: '検証用A' }, { name: '検証用B' }];

        const ID = {
            scoreType: now + 1,     // 小テスト・maxScore=0 → 警告対象(得点型)
            rubric: now + 2,        // ルーブリック・maxScore=0 → 除外(isABCTest)
            descriptive: now + 3,   // 記述問題・maxScore=0 → 除外(isABCTest)
            composition: now + 4,   // 作文・maxScore=0 → 除外(isABCTest)
            attitudeCat: now + 5,   // 小テスト+category=主体性・maxScore=0 → 除外(isABCTest)
            pe: now + 6,            // 実技記録・maxScore=9999 → 従来通り対象外(無変更確認)
            attitudeType: now + 7,  // 授業態度・maxScore=10 → 従来通り対象外(無変更確認)
            matome: now + 8         // まとめテスト・maxScore=0 → 従来通り対象外(無変更確認)
        };

        function T(id, subject, testType, category, maxScore, extra) {
            return Object.assign({ id, subject, category, testType, type: 'standard', maxScore, date: '2026-06-01', createdAt: new Date().toISOString() }, extra || {});
        }

        const tests = [
            T(ID.scoreType,    '国語', '小テスト',     '知識・技能',       0),
            T(ID.rubric,       '国語', 'ルーブリック', '知識・技能',       0),
            T(ID.descriptive,  '国語', '記述問題',     '知識・技能',       0),
            T(ID.composition,  '国語', '作文',         '思考・判断・表現', 0),
            T(ID.attitudeCat,  '国語', '小テスト',     '主体性',           0),
            T(ID.pe,           '体育', '実技記録',     '知識・技能',       9999, { peUnit: '点' }),
            T(ID.attitudeType, '国語', '授業態度',     '主体性',           10),
            T(ID.matome,       '算数', 'まとめテスト', '複合',             0, { type: 'matome' })
        ];

        // numericScoreNoMaxScoreがisABCTestに依存せず引き続き機能することの確認用:
        // ルーブリック(isABCTest=true・maxScore=0)に、本来入らないはずの数値スコアを混入させる。
        const scores = [
            { testId: ID.rubric, studentIndex: 0, score: 42 }
        ];

        await page.evaluate(({ tests, scores, students }) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                students: students,
                classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 }
            }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
        }, { tests, scores, students });

        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 300));

        await page.evaluate(async () => {
            if ('serviceWorker' in navigator) {
                try { await navigator.serviceWorker.ready; } catch (e) {}
            }
        });
        await new Promise(r => setTimeout(r, 300));

        // runAuditDiagnosis() は実装のエントリポイント(window公開済み)をそのまま呼ぶ。
        await page.evaluate(() => { window.runAuditDiagnosis(); });
        await new Promise(r => setTimeout(r, 500));

        const si = await page.evaluate(() => (window._auditDiagnosisLastResult || {}).structuralIntegrity);

        // ================================================================
        // 1. maxScoreMissing: 得点型(小テスト)のみが計上される
        // ================================================================
        check('maxScoreMissingは1件(得点型の小テストのみ)', si && si.maxScoreMissing === 1, JSON.stringify(si && si.maxScoreMissing));

        // ================================================================
        // 2. 5段階項目(ルーブリック/記述問題/作文/category=主体性)は
        //    maxScoreが0でもmaxScoreEmptyBreakdownに出ない
        // ================================================================
        const breakdown = (si && si.maxScoreEmptyBreakdown) || [];
        check('内訳にルーブリックが出ない', !breakdown.some(function(b) { return b.testType === 'ルーブリック'; }), JSON.stringify(breakdown));
        check('内訳に記述問題が出ない', !breakdown.some(function(b) { return b.testType === '記述問題'; }), JSON.stringify(breakdown));
        check('内訳に作文が出ない', !breakdown.some(function(b) { return b.testType === '作文'; }), JSON.stringify(breakdown));
        check('内訳に小テスト(1件)のみが出る(category=主体性の小テストは含まれない)',
            breakdown.length === 1 && breakdown[0].testType === '小テスト' && breakdown[0].count === 1,
            JSON.stringify(breakdown));

        // ================================================================
        // 3. 実技記録・授業態度・まとめテストの扱いが変わらないこと
        //    (もともとmaxScoreMissingに計上されない各ケース。今回の変更で
        //     計上されるようになっていないか=1件のままであることの確認)
        // ================================================================
        check('実技記録(maxScore=9999)・授業態度(maxScore=10)・まとめテスト(type=matome)は影響を受けず、maxScoreMissingは1件のまま',
            si && si.maxScoreMissing === 1, JSON.stringify(si && si.maxScoreMissing));

        // ================================================================
        // 4. numericScoreNoMaxScore の判定が変わっていないこと
        //    (isABCTest=trueのルーブリックにもかかわらず、数値スコアが
        //     混入していれば従来通り検出される)
        // ================================================================
        check('numericScoreNoMaxScoreは1件(isABCTestがtrueのテストでも数値スコア混入は検出される)',
            si && si.numericScoreNoMaxScore === 1, JSON.stringify(si && si.numericScoreNoMaxScoreDetail));
        check('numericScoreNoMaxScoreDetailの対象testIdがルーブリック(ID.rubric)である',
            si && si.numericScoreNoMaxScoreDetail.some(function(d) { return d.testId === ID.rubric; }),
            JSON.stringify(si && si.numericScoreNoMaxScoreDetail));

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
