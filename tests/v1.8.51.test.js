// v1.8.51 機械検証（コミット①: 漢字チェック units→フラット構造への移行ロジック）
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.51.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- 旧形式テストデータ（複数単元・複数児童・境界跨ぎを含む） ----
// units配列は古い→新しい順 = [A, B, C]（C単元が最新）
const OLD_KANJI_DATA = {
    units: [
        { name: 'A単元', chars: ['一','二','三','四','五','六','七','八','九','十'],
          checks: { '0': { '0': 'o', '1': 'd', '9': 'o' }, '2': { '5': 'd' } } },
        { name: 'B単元', chars: ['百','千','万','億'],
          checks: { '0': { '2': 'o' }, '1': { '0': 'd', '3': 'o' } } },
        { name: 'C単元', chars: ['円','銭','分','厘','毛','糸','忽','微'],
          checks: { '0': { '0': 'd' }, '3': { '7': 'o', '0': 'd' } } }
    ]
};
const TOTAL_CHARS = 10 + 4 + 8; // 22

// ---- 旧表示順（v1.8.50 kjBuildFlatItems と同じ：units末尾→先頭、各単元内は0→末尾） ----
function buildOldFlatItems(data) {
    const units = data.units || [];
    const items = [];
    for (let ui = units.length - 1; ui >= 0; ui--) {
        const chars = units[ui].chars || [];
        for (let ci = 0; ci < chars.length; ci++) {
            items.push({ unit: units[ui], charIdx: ci, char: chars[ci] });
        }
    }
    return items;
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
        if (msg.type() === 'error') {
            const loc = msg.location() || {};
            consoleErrors.push({ text: msg.text(), url: loc.url || '' });
        }
    });
    page.on('pageerror', err => consoleErrors.push({ text: 'PAGEERROR: ' + err.message, url: '' }));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    // --- 旧形式データを投入してリロード（DOMContentLoadedで移行が走る） ---
    await page.evaluate((oldData) => {
        StorageManager.setImmediate(KEYS.kanji, JSON.stringify(oldData));
        localStorage.removeItem('spa_kanji_backup_v1851');
    }, OLD_KANJI_DATA);
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    let { raw: rawAfter, data: dataAfter } = await page.evaluate(() => ({
        raw: localStorage.getItem('spa_kanji'),
        data: JSON.parse(localStorage.getItem('spa_kanji'))
    }));

    // ================================================================
    // 検証7-1: 移行の無損失検証
    // ================================================================
    const oldItems = buildOldFlatItems(OLD_KANJI_DATA);
    const n = oldItems.length;

    check('検証7-1a: 新形式は units キーを持たない', !('units' in dataAfter), JSON.stringify(Object.keys(dataAfter)));
    check('検証7-1b: chars配列の長さが旧総文字数と一致', Array.isArray(dataAfter.chars) && dataAfter.chars.length === TOTAL_CHARS,
        'chars.length=' + (dataAfter.chars && dataAfter.chars.length));

    // 期待値: newIdx = n-1-i, newChars[newIdx] = oldItems[i].char
    let charsOk = true, charsDetail = [];
    for (let i = 0; i < n; i++) {
        const newIdx = n - 1 - i;
        if (dataAfter.chars[newIdx] !== oldItems[i].char) {
            charsOk = false;
            charsDetail.push({ i, newIdx, expected: oldItems[i].char, actual: dataAfter.chars[newIdx] });
        }
    }
    check('検証7-1c: chars配列が旧表示順の逆順で格納されている', charsOk, JSON.stringify(charsDetail));

    // 期待値: 全児童×全文字でチェック値が一致
    const studentKeys = {};
    OLD_KANJI_DATA.units.forEach(u => Object.keys(u.checks || {}).forEach(k => studentKeys[k] = true));
    Object.keys(dataAfter.checks || {}).forEach(k => studentKeys[k] = true);

    let checksOk = true, checksDetail = [];
    for (let i = 0; i < n; i++) {
        const newIdx = n - 1 - i;
        const item = oldItems[i];
        Object.keys(studentKeys).forEach(stuKey => {
            const oldVal = (item.unit.checks[stuKey] || {})[String(item.charIdx)] || '';
            const newVal = ((dataAfter.checks[stuKey] || {})[String(newIdx)]) || '';
            if (oldVal !== newVal) {
                checksOk = false;
                checksDetail.push({ stuKey, i, newIdx, oldVal, newVal });
            }
        });
    }
    check('検証7-1d: 全児童×全文字でチェック値（○/△/未）が完全一致', checksOk, JSON.stringify(checksDetail));

    // ================================================================
    // 検証7-2: バックアップ検証
    // ================================================================
    let backupRaw = await page.evaluate(() => localStorage.getItem('spa_kanji_backup_v1851'));
    check('検証7-2: バックアップキーに旧形式データが保持されている',
        backupRaw === JSON.stringify(OLD_KANJI_DATA), 'backup=' + backupRaw);

    // ================================================================
    // 検証7-3: 冪等性検証（再リロードで何も壊れない）
    // ================================================================
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
    let raw2 = await page.evaluate(() => localStorage.getItem('spa_kanji'));
    let backupRaw2 = await page.evaluate(() => localStorage.getItem('spa_kanji_backup_v1851'));
    check('検証7-3a: 2回目の移行でも spa_kanji が変化しない', raw2 === rawAfter, raw2);
    check('検証7-3b: 2回目の移行でも バックアップが変化しない', backupRaw2 === backupRaw, backupRaw2);

    // ================================================================
    // 検証: 表示順の整合性（逆順読みで v1.8.50 と同じ最新が上の順になるか）
    // ================================================================
    const reversedChars = dataAfter.chars.slice().reverse();
    const expectedDisplayOrder = oldItems.map(it => it.char);
    check('検証: chars逆順読みが旧表示順（最新単元=C単元の先頭文字「円」が先頭）と一致',
        JSON.stringify(reversedChars) === JSON.stringify(expectedDisplayOrder),
        'reversed[0]=' + reversedChars[0] + ' expected[0]=' + expectedDisplayOrder[0]);

    // ================================================================
    // コンソールエラーなし
    // ================================================================
    const realErrors = consoleErrors.filter(e => e.url.indexOf('favicon') === -1);
    check('コンソールエラーなし（favicon 404除く）', realErrors.length === 0, JSON.stringify(realErrors));

    await browser.close();

    console.log('---');
    const failed = results.filter(r => !r.pass);
    console.log('TOTAL ' + results.length + ' / PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
    if (failed.length) {
        console.log('FAILED:');
        failed.forEach(r => console.log('  - ' + r.name + (r.detail ? ' :: ' + r.detail : '')));
        process.exit(1);
    }
})();
