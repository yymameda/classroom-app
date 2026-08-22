// v1.19.0 出席集計一本化・段階0: calcAttendanceStats 拡張の機械検証
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node attendance-stats.test.js
//
// 検証内容:
//   - 10種類のステータス（○×／チソチソ忌停休校）を月をまたいで配置した固定データでの
//     calcAttendanceStats() の戻り値を全プロパティ検証
//   - byMonthGrouped に early が含まれること（printAllKarteのattMonths非対称の解消）
//   - 対象生徒に出欠データが1件もない場合（total=0 → rate=null）
//   - byCode / byMonth が従来どおりであること（非破壊確認）

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

// 10種のステータスを月をまたいで1件ずつ配置（idx=0）。idx=1は出欠データなし。
const attData = {
    '2026-04-06': { '0': '○' },
    '2026-04-07': { '0': '×' },
    '2026-04-08': { '0': '／' },
    '2026-04-09': { '0': 'チ' },
    '2026-04-10': { '0': 'ソ' },
    '2026-05-11': { '0': 'チソ' },
    '2026-05-12': { '0': '忌' },
    '2026-05-13': { '0': '停' },
    '2026-05-14': { '0': '休' },
    '2026-05-15': { '0': '校' },
    // 未知コード（データ破損想定）。idx=2にのみ付与。
    '2026-06-01': { '2': '?' }
};

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    await page.evaluate((a) => {
        StorageManager.setImmediate('spa_attendance', JSON.stringify(a));
    }, attData);
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    // ================================================================
    // ケース1: 10種類のステータスを持つ生徒（idx=0）
    // ================================================================
    const stats0 = await page.evaluate(() => {
        var att = StorageManager.get('spa_attendance', {});
        return calcAttendanceStats(0, att);
    });

    check('present = 4（○チソチソ）', stats0.present === 4, stats0.present);
    check('absent = 2（×／）', stats0.absent === 2, stats0.absent);
    check('late = 2（チ・チソ）', stats0.late === 2, stats0.late);
    check('early = 2（ソ・チソ）', stats0.early === 2, stats0.early);
    check('excused = 2（忌・停）', stats0.excused === 2, stats0.excused);
    check('noSchool = 2（休・校）', stats0.noSchool === 2, stats0.noSchool);
    check('other = 0', stats0.other === 0, stats0.other);
    check('total = 6（10日 − excused2 − noSchool2 − other0）', stats0.total === 6, stats0.total);
    check('rate = 67（Math.round(4/6*100)）', stats0.rate === 67, stats0.rate);

    check('byCode従来どおり（○×／チソチソ忌停休校が各1）',
        stats0.byCode['○'] === 1 && stats0.byCode['×'] === 1 && stats0.byCode['／'] === 1 &&
        stats0.byCode['チ'] === 1 && stats0.byCode['ソ'] === 1 && stats0.byCode['チソ'] === 1 &&
        stats0.byCode['忌'] === 1 && stats0.byCode['停'] === 1 && stats0.byCode['休'] === 1 && stats0.byCode['校'] === 1,
        stats0.byCode);

    check('byMonth従来どおり（4月5件・5月5件、コード別）',
        stats0.byMonth['2026-04'] && Object.keys(stats0.byMonth['2026-04']).length === 5 &&
        stats0.byMonth['2026-05'] && Object.keys(stats0.byMonth['2026-05']).length === 5,
        stats0.byMonth);

    check('byMonthGroupedにearlyが含まれる（4月: ソ1件→early1、5月: チソ1件→early1）',
        stats0.byMonthGrouped['2026-04'].early === 1 && stats0.byMonthGrouped['2026-05'].early === 1,
        stats0.byMonthGrouped);

    check('byMonthGrouped 4月分の内訳（present3=○チソ, absent2=×／, late1=チ, early1=ソ, excused0, noSchool0, total5）',
        stats0.byMonthGrouped['2026-04'].present === 3 &&
        stats0.byMonthGrouped['2026-04'].absent === 2 &&
        stats0.byMonthGrouped['2026-04'].late === 1 &&
        stats0.byMonthGrouped['2026-04'].early === 1 &&
        stats0.byMonthGrouped['2026-04'].excused === 0 &&
        stats0.byMonthGrouped['2026-04'].noSchool === 0 &&
        stats0.byMonthGrouped['2026-04'].total === 5,
        stats0.byMonthGrouped['2026-04']);

    check('byMonthGrouped 5月分の内訳（present1=チソ, absent0, late1, early1, excused2=忌停, noSchool2=休校, total1）',
        stats0.byMonthGrouped['2026-05'].present === 1 &&
        stats0.byMonthGrouped['2026-05'].absent === 0 &&
        stats0.byMonthGrouped['2026-05'].late === 1 &&
        stats0.byMonthGrouped['2026-05'].early === 1 &&
        stats0.byMonthGrouped['2026-05'].excused === 2 &&
        stats0.byMonthGrouped['2026-05'].noSchool === 2 &&
        stats0.byMonthGrouped['2026-05'].total === 1,
        stats0.byMonthGrouped['2026-05']);

    // ================================================================
    // ケース2: 出欠データが1件もない生徒（idx=1）→ total=0, rate=null
    // ================================================================
    const stats1 = await page.evaluate(() => {
        var att = StorageManager.get('spa_attendance', {});
        return calcAttendanceStats(1, att);
    });
    check('データなし: total=0', stats1.total === 0, stats1.total);
    check('データなし: rate=null', stats1.rate === null, stats1.rate);
    check('データなし: present/absent/late/early/excused/noSchool/otherも全て0',
        stats1.present === 0 && stats1.absent === 0 && stats1.late === 0 && stats1.early === 0 &&
        stats1.excused === 0 && stats1.noSchool === 0 && stats1.other === 0,
        stats1);
    check('データなし: byCode/byMonthは空オブジェクト',
        Object.keys(stats1.byCode).length === 0 && Object.keys(stats1.byMonth).length === 0,
        stats1);

    // ================================================================
    // ケース3: 未知のステータス文字列を持つ生徒（idx=2）→ otherに計上、分母に入らない
    // ================================================================
    const stats2 = await page.evaluate(() => {
        var att = StorageManager.get('spa_attendance', {});
        return calcAttendanceStats(2, att);
    });
    check('未知コード: other=1', stats2.other === 1, stats2.other);
    check('未知コード: total=0（未知コードは分母に入らない）', stats2.total === 0, stats2.total);
    check('未知コード: rate=null', stats2.rate === null, stats2.rate);
    check('未知コード: byCodeには生カウントとして残る', stats2.byCode['?'] === 1, stats2.byCode);

    console.log('consoleErrors:', consoleErrors);

    await browser.close();

    const failed = results.filter(r => !r.pass);
    console.log('\n=== 結果: ' + (results.length - failed.length) + '/' + results.length + ' PASS ===');
    if (failed.length) {
        console.log('FAILED:');
        failed.forEach(f => console.log('  - ' + f.name));
        process.exit(1);
    }
})();
