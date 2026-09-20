// H7の既存矛盾データ検出: 入力形式(得点/5段階)と満点(maxScore)が矛盾する課題を、既存の診断ツール
// (データ出力(📤)の一番下「🔍 監査診断」>「診断を実行」)で一覧表示する。検出と表示だけを行い、データは自動修正しない(読み取り専用)。
//
//   矛盾A: 得点方式(score)なのに満点が0/未設定   例 {category:'主体性', maxScore:0, inputMode:'score'}
//   矛盾B: 5段階(abc5)なのに満点が残っている      例 {category:'知識・技能', maxScore:80, inputMode:'abc5'}
//   対象外: まとめ/単元テスト・実技記録・授業態度(専用の入力方式)。正常な組み合わせ(フラグ無しの旧5段階項目など)は出さない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-inputmode-conflict.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
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
    const backup = await page.evaluate(() => [StorageManager.getRaw(KEYS.master), StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores)]);

    const T = (o) => Object.assign({ subject: '国語', testType: '小テスト', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-06-01' }, o);
    const tests = [
        T({ id: 1, name: '正常-得点', maxScore: 100, inputMode: 'score' }),
        T({ id: 2, name: '正常-5段階', category: '主体性', maxScore: 0, inputMode: 'abc5' }),
        T({ id: 3, name: '矛盾A-主体性', category: '主体性', maxScore: 0, inputMode: 'score' }),
        T({ id: 4, name: '矛盾B-知識', category: '知識・技能', maxScore: 80, inputMode: 'abc5' }),
        T({ id: 5, name: '正常-旧5段階(フラグ無し)', category: '主体性', maxScore: 0 }),
        T({ id: 6, name: '正常-旧振り返り(満点5・フラグ無し)', testType: '振り返り', category: '思考・判断・表現', maxScore: 5 }),
        T({ id: 7, name: '対象外-まとめ', testType: 'まとめテスト', type: 'matome', category: '複合', maxScore: 0, matomePoints: [5, 5] }),
        T({ id: 8, name: '対象外-実技', subject: '体育', testType: '実技記録', maxScore: 9999, peUnit: '点' }),
        T({ id: 9, name: '対象外-授業態度', subject: '体育', testType: '授業態度', category: '主体性', maxScore: 10 }),
        T({ id: 10, name: '矛盾A-知識(旧フラグ無し満点0)', category: '知識・技能', maxScore: 0 })
    ];
    const scores = [
        { id: 1, studentIndex: 0, testId: 3, score: 70 }, { id: 2, studentIndex: 1, testId: 3, score: 55 },
        { id: 3, studentIndex: 0, testId: 4, score: 'B' }
    ];

    try {
        await page.evaluate((tests, scores) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: '甲' }, { name: '乙' }], classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, JSON.stringify(scores));
        }, tests, scores);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        const before = await page.evaluate(() => [StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores)]);

        await page.evaluate(() => {
            window.__clip = null;
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
            showView('settings');
            runAuditDiagnosis();
        });
        await sleep(600);
        const out = await page.evaluate(() => {
            const r = window._auditDiagnosisLastResult;
            const si = r && r.structuralIntegrity;
            return {
                has: !!si,
                count: si && si.inputModeConflicts,
                detail: si && si.inputModeConflictDetail,
                overflow: si && si.inputModeConflictOverflow,
                warn: r && r.anomalies && r.anomalies.warn,
                html: (document.getElementById('audit-result-container') || {}).innerText || ''
            };
        });
        const names = (out.detail || []).map(d => d.name).sort();
        check('診断結果に入力形式の矛盾が3件(矛盾A×2・矛盾B×1)', out.count === 3, 'count=' + out.count + ' names=' + JSON.stringify(names));
        check('矛盾する課題だけが一覧に出る(正常・対象外は出ない)', JSON.stringify(names) === JSON.stringify(['矛盾A-主体性', '矛盾A-知識(旧フラグ無し満点0)', '矛盾B-知識'].sort()), JSON.stringify(names));
        const a = (out.detail || []).find(d => d.name === '矛盾A-主体性') || {};
        const b = (out.detail || []).find(d => d.name === '矛盾B-知識') || {};
        check('矛盾A: 種別(得点なのに満点なし)・満点0・入力済み数値2件が分かる', a.kind === 'score' && a.maxScore === 0 && a.numericScores === 2 && a.testId === 3, JSON.stringify(a));
        check('矛盾B: 種別(5段階なのに満点あり)・満点80・入力済み文字1件が分かる', b.kind === 'abc5' && b.maxScore === 80 && b.stringScores === 1, JSON.stringify(b));
        check('矛盾の一覧に教科・種別・観点・入力形式が含まれる', a.subject === '国語' && a.testType === '小テスト' && a.category === '主体性' && a.inputMode === 'score', JSON.stringify(a));
        check('診断画面に該当課題名と説明が表示される', /矛盾A-主体性/.test(out.html) && /矛盾B-知識/.test(out.html) && /入力形式と満点が矛盾/.test(out.html), out.html.slice(0, 80));
        check('診断画面に「自動では修正しません」の案内がある', /自動では修正しません|自動修正はしません/.test(out.html), '');
        check('注意欄(anomalies.warn)にも件数が出る', (out.warn || []).some(w => /入力形式と満点が矛盾/.test(w) && /3件/.test(w)), JSON.stringify(out.warn));

        // テキスト出力(コピー)にも含まれる
        await page.evaluate(() => { copyAuditResultAsText(); });
        await sleep(200);
        const clip = await page.evaluate(() => window.__clip || '');
        check('テキスト出力に矛盾課題の行が含まれる', /入力形式と満点が矛盾/.test(clip) && /矛盾A-主体性/.test(clip), clip.slice(0, 60));

        // 読み取り専用: 診断でデータは一切変わらない
        const after = await page.evaluate(() => [StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores)]);
        check('読み取り専用: 診断の前後で課題・記録のデータが完全一致(自動修正しない)', before[0] === after[0] && before[1] === after[1], '');

        // 矛盾が無いデータでは0件・「なし」表示
        await page.evaluate((tests) => {
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests.filter(t => [1, 2, 5, 6, 7, 8, 9].indexOf(t.id) !== -1)));
        }, tests);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        const clean = await page.evaluate(() => { showView('settings'); runAuditDiagnosis(); return null; });
        await sleep(600);
        const clean2 = await page.evaluate(() => {
            const r = window._auditDiagnosisLastResult.structuralIntegrity;
            return { count: r.inputModeConflicts, warn: (window._auditDiagnosisLastResult.anomalies.warn || []).some(w => /入力形式と満点が矛盾/.test(w)) };
        });
        check('矛盾が無いデータでは0件で、注意欄にも出ない', clean2.count === 0 && clean2.warn === false, JSON.stringify(clean2));
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        await page.evaluate((b) => {
            ['master', 'tests', 'scores'].forEach((k, i) => { if (b[i] === null) StorageManager.remove(KEYS[k]); else StorageManager.setImmediate(KEYS[k], b[i]); });
        }, backup);
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== audit-inputmode-conflict: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
