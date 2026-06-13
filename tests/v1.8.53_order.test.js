// v1.8.53 機械検証（漢字チェック chars配列の並び順修正：migrateKanjiOrder）
// 設計: 「文字そのもの」をキーに各児童の○/△対応を作り、
//       chars配列を正しい62字順序に置き換えた上で、文字をキーに新しいcharIdxへ付け替える。
//       これにより、逆順だけでなく任意の並び（順列）からでも正しい順序に復元できる。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.53_order.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- バックアップPDFで確認された正しい順序（①→②→③連結、62字） ----
const CORRECT_ORDER = '像経情象絶厚賞状喜解容技術適許可複構桜銅破修復眼停祖準備貿易際潔質報告属確識因造似限留現接応勢河歴史幹招句常序武士資査性非総'.split('');
const N = CORRECT_ORDER.length; // 62

function swap(arr, i, j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }

async function getKanji(page) {
    const raw = await page.evaluate(() => localStorage.getItem('spa_kanji'));
    return { raw, data: raw ? JSON.parse(raw) : null };
}
async function getBackup(page) {
    return await page.evaluate(() => localStorage.getItem('spa_kanji_backup_v1853_order'));
}
async function setKanjiAndReload(page, kanjiData) {
    await page.evaluate((d) => {
        localStorage.removeItem('spa_kanji_backup_v1853_order');
        StorageManager.setImmediate(KEYS.kanji, JSON.stringify(d));
    }, kanjiData);
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
    // ケースA: 完全な逆順データ → 正しい62字順序に並べ替え、checksは文字基準で対応保存
    // ================================================================
    const REVERSED = CORRECT_ORDER.slice().reverse();
    // 逆順index: 0='総'(correct側index61), 1='非'(correct側index60), 30='際'(correct側index31), 61='像'(correct側index0)
    const REVERSED_DATA = {
        chars: REVERSED,
        checks: {
            '0': { '0': 'o', '1': 'd', '61': 'o' }, // 総=○, 非=△, 像=○
            '1': { '30': 'd' },                      // 潔=△ (REVERSED[30]=CORRECT_ORDER[31]='潔')
            '2': { '61': 'd', '0': 'o', '30': 'o' }  // 像=△, 総=○, 潔=○
        }
    };

    await setKanjiAndReload(page, REVERSED_DATA);
    let { raw: rawA, data: dataA } = await getKanji(page);
    let backupA = await getBackup(page);

    check('検証A1: 完全な逆順データ → chars配列が正しい62字順序と一致',
        JSON.stringify(dataA.chars) === JSON.stringify(CORRECT_ORDER),
        'chars[0..4]=' + JSON.stringify(dataA.chars.slice(0, 5)));

    check('検証A2: 児童0 総=○ → newIdx=correct.indexOf("総")=61 に保存',
        dataA.checks['0'] && dataA.checks['0'][String(CORRECT_ORDER.indexOf('総'))] === 'o', JSON.stringify(dataA.checks['0']));
    check('検証A3: 児童0 非=△ → newIdx=correct.indexOf("非")=60 に保存',
        dataA.checks['0'] && dataA.checks['0'][String(CORRECT_ORDER.indexOf('非'))] === 'd', JSON.stringify(dataA.checks['0']));
    check('検証A4: 児童0 像=○ → newIdx=correct.indexOf("像")=0 に保存',
        dataA.checks['0'] && dataA.checks['0'][String(CORRECT_ORDER.indexOf('像'))] === 'o', JSON.stringify(dataA.checks['0']));
    check('検証A5: 児童1 潔=△ → newIdx=correct.indexOf("潔")=31 に保存',
        dataA.checks['1'] && dataA.checks['1'][String(CORRECT_ORDER.indexOf('潔'))] === 'd', JSON.stringify(dataA.checks['1']));
    check('検証A6: 児童2 像=△,総=○,潔=○ が文字基準で正しいnewIdxに保存',
        dataA.checks['2'] &&
        dataA.checks['2'][String(CORRECT_ORDER.indexOf('像'))] === 'd' &&
        dataA.checks['2'][String(CORRECT_ORDER.indexOf('総'))] === 'o' &&
        dataA.checks['2'][String(CORRECT_ORDER.indexOf('潔'))] === 'o',
        JSON.stringify(dataA.checks['2']));

    check('検証A7: 並べ替え前のデータがspa_kanji_backup_v1853_orderに保存されている',
        backupA === JSON.stringify(REVERSED_DATA), 'backup=' + backupA);

    // 「文字→○/△」対応の無損失確認（順序非依存）
    function buildCharCheckMap(chars, checks) {
        const map = {};
        Object.keys(checks).forEach(stuKey => {
            Object.keys(checks[stuKey] || {}).forEach(idxStr => {
                const idx = parseInt(idxStr, 10);
                const ch = chars[idx];
                if (!map[stuKey]) map[stuKey] = {};
                map[stuKey][ch] = checks[stuKey][idxStr];
            });
        });
        return map;
    }
    function normalizeMap(map) {
        const out = {};
        Object.keys(map).sort().forEach(stuKey => {
            const sub = {};
            Object.keys(map[stuKey]).sort().forEach(ch => { sub[ch] = map[stuKey][ch]; });
            out[stuKey] = sub;
        });
        return JSON.stringify(out);
    }
    const beforeMapA = buildCharCheckMap(REVERSED_DATA.chars, REVERSED_DATA.checks);
    const afterMapA = buildCharCheckMap(dataA.chars, dataA.checks);
    check('検証A8: 「文字→○/△」の対応が全児童で完全一致（無損失）',
        normalizeMap(beforeMapA) === normalizeMap(afterMapA),
        'before=' + normalizeMap(beforeMapA) + ' after=' + normalizeMap(afterMapA));

    // ================================================================
    // ケースB: 逆順ではない「部分シャッフル」データ → 正しい62字順序に並べ替え
    // ================================================================
    const SHUFFLED = CORRECT_ORDER.slice();
    swap(SHUFFLED, 0, 10);
    swap(SHUFFLED, 5, 50);
    swap(SHUFFLED, 20, 40);
    swap(SHUFFLED, 61, 30);
    // SHUFFLED[0]='容'(correct[10]), [10]='像'(correct[0])
    // SHUFFLED[5]='幹'(correct[50]), [50]='厚'(correct[5])
    // SHUFFLED[20]='似'(correct[40]), [40]='破'(correct[20])
    // SHUFFLED[61]='際'(correct[30]), [30]='総'(correct[61])
    // SHUFFLED[15]='可'(correct[15], 入れ替えなし)
    check('前提: SHUFFLEDはCORRECT_ORDERと異なり、かつ完全な逆順でもない',
        JSON.stringify(SHUFFLED) !== JSON.stringify(CORRECT_ORDER) &&
        JSON.stringify(SHUFFLED) !== JSON.stringify(CORRECT_ORDER.slice().reverse()),
        'SHUFFLED[0..2]=' + JSON.stringify(SHUFFLED.slice(0, 3)));

    const SHUFFLED_DATA = {
        chars: SHUFFLED,
        checks: {
            '0': { '0': 'o', '10': 'd', '30': 'o', '61': 'd' }, // 容=○, 像=△, 総=○, 際=△
            '1': { '15': 'd' }                                   // 可=△（入れ替えなしの位置）
        }
    };
    const beforeMapB = buildCharCheckMap(SHUFFLED_DATA.chars, SHUFFLED_DATA.checks);

    await setKanjiAndReload(page, SHUFFLED_DATA);
    let { raw: rawB, data: dataB } = await getKanji(page);
    let backupB = await getBackup(page);

    check('検証B1: 部分シャッフルデータ → chars配列が正しい62字順序と一致',
        JSON.stringify(dataB.chars) === JSON.stringify(CORRECT_ORDER),
        'chars[0..4]=' + JSON.stringify(dataB.chars.slice(0, 5)));

    check('検証B2: 児童0 容=○,像=△,総=○,際=△ が文字基準で正しいnewIdxに保存',
        dataB.checks['0'] &&
        dataB.checks['0'][String(CORRECT_ORDER.indexOf('容'))] === 'o' &&
        dataB.checks['0'][String(CORRECT_ORDER.indexOf('像'))] === 'd' &&
        dataB.checks['0'][String(CORRECT_ORDER.indexOf('総'))] === 'o' &&
        dataB.checks['0'][String(CORRECT_ORDER.indexOf('際'))] === 'd',
        JSON.stringify(dataB.checks['0']));

    check('検証B3: 児童1 可=△（入れ替えなしの文字）も正しいnewIdxに保存',
        dataB.checks['1'] && dataB.checks['1'][String(CORRECT_ORDER.indexOf('可'))] === 'd',
        JSON.stringify(dataB.checks['1']));

    const afterMapB = buildCharCheckMap(dataB.chars, dataB.checks);
    check('検証B4: 「文字→○/△」の対応が全児童で完全一致（無損失）',
        normalizeMap(beforeMapB) === normalizeMap(afterMapB),
        'before=' + normalizeMap(beforeMapB) + ' after=' + normalizeMap(afterMapB));

    check('検証B5: 並べ替え前のデータがspa_kanji_backup_v1853_orderに保存されている',
        backupB === JSON.stringify(SHUFFLED_DATA), 'backup=' + backupB);

    // ================================================================
    // ケースC: 冪等性 - 正しい順序になった後、再リロードで何も変化しない
    // ================================================================
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
    let { raw: rawC } = await getKanji(page);
    let backupC = await getBackup(page);
    check('検証C1: 正しい順序になった後、再リロードでspa_kanjiが変化しない(冪等性)', rawC === rawB, rawC);
    // 並べ替えバックアップは次回起動でcleanupされる(作成後、最低1回は保険として残る)
    check('検証C2: 正しい順序になった後の再リロードで、前回作成されたバックアップはcleanupにより削除される', backupC === null, 'backupC=' + String(backupC));

    // ================================================================
    // ケースD: 文字集合が一致しないデータ（62字だが知らない文字を含む）→ 何もしない
    // ================================================================
    const UNKNOWN_CHAR_DATA = {
        chars: CORRECT_ORDER.slice(),
        checks: { '0': { '5': 'o' } }
    };
    UNKNOWN_CHAR_DATA.chars[5] = '雪'; // correct[5]='厚' を未知の文字'雪'に置き換え（62字のまま）

    await setKanjiAndReload(page, UNKNOWN_CHAR_DATA);
    let { data: dataD } = await getKanji(page);
    let backupD = await getBackup(page);
    check('検証D1: 知らない文字を含む62字データはchars・checksが変化しない',
        JSON.stringify(dataD) === JSON.stringify(UNKNOWN_CHAR_DATA), JSON.stringify(dataD.chars.slice(0, 6)));
    check('検証D2: 知らない文字を含む62字データはバックアップキーが作成されない', backupD === null, String(backupD));

    // ================================================================
    // ケースE: 62字に満たないデータ（61字）→ 何もしない
    // ================================================================
    const TOO_FEW_DATA = {
        chars: CORRECT_ORDER.slice(0, 61), // 最後の1字「総」を欠落
        checks: { '0': { '0': 'o' } }
    };

    await setKanjiAndReload(page, TOO_FEW_DATA);
    let { data: dataE } = await getKanji(page);
    let backupE = await getBackup(page);
    check('検証E1: 61字（62字未満）データはchars・checksが変化しない',
        JSON.stringify(dataE) === JSON.stringify(TOO_FEW_DATA), 'chars.length=' + dataE.chars.length);
    check('検証E2: 61字データはバックアップキーが作成されない', backupE === null, String(backupE));

    // ================================================================
    // ケースF: 既に正しい62字順序 → 何もしない
    // ================================================================
    const ALREADY_CORRECT_DATA = {
        chars: CORRECT_ORDER.slice(),
        checks: { '0': { '0': 'o', '61': 'd' } }
    };

    await setKanjiAndReload(page, ALREADY_CORRECT_DATA);
    let { data: dataF } = await getKanji(page);
    let backupF = await getBackup(page);
    check('検証F1: 既に正しい62字順序ならchars不変',
        JSON.stringify(dataF.chars) === JSON.stringify(ALREADY_CORRECT_DATA.chars), JSON.stringify(dataF.chars.slice(0, 3)));
    check('検証F2: 既に正しい62字順序ならchecksも不変',
        JSON.stringify(dataF.checks) === JSON.stringify(ALREADY_CORRECT_DATA.checks), JSON.stringify(dataF.checks));
    check('検証F3: 既に正しい62字順序ならバックアップキーが作成されない', backupF === null, String(backupF));

    // ================================================================
    // コンソールエラーなし（warning/logは許容、error/pageerrorのみ確認）
    // ================================================================
    const realErrors = consoleErrors.filter(e => e.url.indexOf('favicon') === -1 && e.text.indexOf('migrateKanjiOrder') === -1 && e.text.indexOf('migrateKanjiToFlat') === -1);
    check('コンソールエラーなし（favicon 404・migrate系の想定エラーログ除く）', realErrors.length === 0, JSON.stringify(realErrors));

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
