// v1.8.54 機械検証（漢字チェック旧バックアップキーの削除：cleanupOldKanjiBackups）
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.54_cleanup.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

const KEY_V1851 = 'spa_kanji_backup_v1851';
const KEY_V1853 = 'spa_kanji_backup_v1853_order';

// 正しい62字順序（既に正しい順序＝migrateKanjiOrderはno-opとなり、cleanupのみを単独で検証できる）
const CORRECT_ORDER = '像経情象絶厚賞状喜解容技術適許可複構桜銅破修復眼停祖準備貿易際潔質報告属確識因造似限留現接応勢河歴史幹招句常序武士資査性非総'.split('');
const KANJI_DATA = {
    chars: CORRECT_ORDER.slice(),
    checks: { '0': { '0': 'o', '61': 'd' } }
};
const KANJI_RAW = JSON.stringify(KANJI_DATA);

async function getRaw(page, key) {
    return await page.evaluate((k) => localStorage.getItem(k), key);
}
async function setRaw(page, key, value) {
    await page.evaluate((args) => {
        if (args.value === null) localStorage.removeItem(args.key);
        else StorageManager.setImmediate(args.key, args.value);
    }, { key, value });
}
async function reload(page) {
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
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

    // ================================================================
    // ケース1: 対象2キーが両方存在 → 削除実行、両キーが消え、spa_kanji本体は完全に不変
    // ================================================================
    await setRaw(page, 'spa_kanji', KANJI_RAW);
    await setRaw(page, KEY_V1851, JSON.stringify({ chars: ['一','二'], checks: {} }));
    await setRaw(page, KEY_V1853, JSON.stringify({ chars: ['三','四'], checks: {} }));
    await reload(page);

    let kanji1 = await getRaw(page, 'spa_kanji');
    let v1851_1 = await getRaw(page, KEY_V1851);
    let v1853_1 = await getRaw(page, KEY_V1853);
    check('検証1a: spa_kanji_backup_v1851が削除される', v1851_1 === null, String(v1851_1));
    check('検証1b: spa_kanji_backup_v1853_orderが削除される', v1853_1 === null, String(v1853_1));
    check('検証1c: spa_kanji本体は完全に不変', kanji1 === KANJI_RAW, kanji1);

    // ================================================================
    // ケース2: 対象キーが無い状態 → 何もしない(冪等性)、spa_kanji不変
    // ================================================================
    await reload(page);
    let kanji2 = await getRaw(page, 'spa_kanji');
    let v1851_2 = await getRaw(page, KEY_V1851);
    let v1853_2 = await getRaw(page, KEY_V1853);
    check('検証2a: 対象キーが無い状態で再実行しても何も起きない(spa_kanji_backup_v1851は存在しない)', v1851_2 === null, String(v1851_2));
    check('検証2b: 対象キーが無い状態で再実行しても何も起きない(spa_kanji_backup_v1853_orderは存在しない)', v1853_2 === null, String(v1853_2));
    check('検証2c: 冪等実行後もspa_kanji本体は不変', kanji2 === KANJI_RAW, kanji2);

    // ================================================================
    // ケース3: 片方だけ存在 → 存在する方だけ削除、spa_kanji不変
    // ================================================================
    await setRaw(page, 'spa_kanji', KANJI_RAW);
    await setRaw(page, KEY_V1851, JSON.stringify({ chars: ['五'], checks: {} }));
    // KEY_V1853は設定しない（既に存在しないはず）
    await reload(page);

    let kanji3 = await getRaw(page, 'spa_kanji');
    let v1851_3 = await getRaw(page, KEY_V1851);
    let v1853_3 = await getRaw(page, KEY_V1853);
    check('検証3a: 存在するspa_kanji_backup_v1851のみ削除される', v1851_3 === null, String(v1851_3));
    check('検証3b: 元々存在しないspa_kanji_backup_v1853_orderも存在しないまま', v1853_3 === null, String(v1853_3));
    check('検証3c: 片方のみ削除でもspa_kanji本体は完全に不変', kanji3 === KANJI_RAW, kanji3);

    // ================================================================
    // ケース4: 他のキー(成績・出欠等のダミー)を置いた状態で実行 → それらが一切変化しない
    // ================================================================
    const DUMMY_DATA = {
        spa_scores: JSON.stringify([{ id: 1, score: 80 }]),
        spa_attendance: JSON.stringify({ '2026-06-15': { '0': 'present' } }),
        spa_karte_recs: JSON.stringify([{ stuIdx: 0, text: 'テスト記録' }])
    };
    for (const [k, v] of Object.entries(DUMMY_DATA)) {
        await setRaw(page, k, v);
    }
    await setRaw(page, 'spa_kanji', KANJI_RAW);
    await setRaw(page, KEY_V1851, JSON.stringify({ chars: ['六'], checks: {} }));
    await setRaw(page, KEY_V1853, JSON.stringify({ chars: ['七'], checks: {} }));
    await reload(page);

    let kanji4 = await getRaw(page, 'spa_kanji');
    let v1851_4 = await getRaw(page, KEY_V1851);
    let v1853_4 = await getRaw(page, KEY_V1853);
    check('検証4a: 両バックアップキーが削除される(他キー混在時)', v1851_4 === null && v1853_4 === null, JSON.stringify({ v1851: v1851_4, v1853: v1853_4 }));
    check('検証4b: spa_kanji本体は完全に不変(他キー混在時)', kanji4 === KANJI_RAW, kanji4);

    let dummyAfter = {};
    for (const k of Object.keys(DUMMY_DATA)) {
        dummyAfter[k] = await getRaw(page, k);
    }
    check('検証4c: 他のキー(成績・出欠・カルテ)が一切変化しない', JSON.stringify(dummyAfter) === JSON.stringify(DUMMY_DATA),
        'before=' + JSON.stringify(DUMMY_DATA) + ' after=' + JSON.stringify(dummyAfter));

    // 後始end: ダミーキーをクリーンアップ
    for (const k of Object.keys(DUMMY_DATA)) {
        await setRaw(page, k, null);
    }

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
