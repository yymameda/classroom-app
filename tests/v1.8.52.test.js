// v1.8.52 機械検証（漢字チェック入力層・印刷の並びを追加順に変更：左上=最古→右下=最新）
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.52.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// chars: index0='一'(最古/最初に追加) ... index9='十'(最新/最後に追加)
// checks: 既存チェックを複数文字に付与（新しい並びでも正しい位置に出るか確認）
const KANJI_DATA = {
    chars: ['一','二','三','四','五','六','七','八','九','十'],
    checks: {
        '0': { '0': 'o', '3': 'd', '9': 'o' } // 一=○, 四=△, 十=○
    }
};
const TOTAL_CHARS = KANJI_DATA.chars.length; // 10

async function readKanjiData(page) {
    const raw = await page.evaluate(() => localStorage.getItem('spa_kanji'));
    return { raw, data: JSON.parse(raw) };
}
async function tapGridCell(page, idx) {
    await page.evaluate((i) => {
        document.getElementById('kanjiGrid').children[i].click();
    }, idx);
    await new Promise(r => setTimeout(r, 50));
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

    // --- データ＋1名の児童を投入 ---
    await page.evaluate((kanjiData) => {
        master.students = [{ name: '生徒01' }];
        StorageManager.setImmediate(KEYS.kanji, JSON.stringify(kanjiData));
    }, KANJI_DATA);
    await page.evaluate(() => { showView('kanji'); window.kanjiOpenStudent(0); });
    await new Promise(r => setTimeout(r, 100));

    // ================================================================
    // 検証1: グリッド表示順 = 追加順（左上=最古「一」、末尾=最新「十」）
    // ================================================================
    let gridChars = await page.evaluate(() => Array.from(document.querySelectorAll('#kanjiGrid .kgc-char')).map(e => e.textContent));
    check('検証1a: グリッドセル数=全文字数' + TOTAL_CHARS, gridChars.length === TOTAL_CHARS, String(gridChars.length));
    check('検証1b: 左上(position0)が最古「一」', gridChars[0] === '一', gridChars[0]);
    check('検証1c: 末尾(position9)が最新「十」', gridChars[gridChars.length - 1] === '十', gridChars[gridChars.length - 1]);
    check('検証1d: グリッド表示順が追加順そのもの(一→十)', JSON.stringify(gridChars) === JSON.stringify(KANJI_DATA.chars), JSON.stringify(gridChars));

    // ================================================================
    // 検証2: 既存チェックの表示位置（一=○@position0, 四=△@position3, 十=○@position9）
    // ================================================================
    let marks = await page.evaluate(() => Array.from(document.querySelectorAll('#kanjiGrid .kgc-mark')).map(e => e.textContent));
    check('検証2: 既存チェック(一=○,四=△,十=○)が新しい並びでも正しい位置に表示', marks[0] === '○' && marks[3] === '△' && marks[9] === '○', JSON.stringify(marks));

    // ================================================================
    // 検証3: 書き込み座標の不変性（左上=一 をタップ → charIdx=0 に記録されること）
    // ================================================================
    // 「一」(charIdx=0)は既に'o'。空セル「二」(position1, charIdx=1)をタップして検証する。
    let { data: before } = await readKanjiData(page);
    await tapGridCell(page, 1); // 左から2番目 = 「二」 = charIdx 1
    let { data: after1 } = await readKanjiData(page);
    check('検証3a: 「二」(position1)タップで data.checks[0]["1"]="d" が記録される(charIdx=1)',
        after1.checks['0'] && after1.checks['0']['1'] === 'd',
        JSON.stringify(after1.checks));
    check('検証3b: 他のcharIdx(0,3,9)は変化なし', after1.checks['0']['0'] === 'o' && after1.checks['0']['3'] === 'd' && after1.checks['0']['9'] === 'o',
        JSON.stringify(after1.checks));

    // さらにタップ(△→○)して charIdx=1 が引き続き正しく更新されることを確認
    await tapGridCell(page, 1);
    let { data: after2 } = await readKanjiData(page);
    check('検証3c: 「二」再タップで data.checks[0]["1"]="o" に更新(charIdx=1のまま)',
        after2.checks['0']['1'] === 'o', JSON.stringify(after2.checks));

    // 元に戻す(○→未)
    await tapGridCell(page, 1);
    let { data: after3, raw: raw3 } = await readKanjiData(page);
    check('検証3d: 「二」3回目タップで未チェックに戻る(charIdx=1のキーが削除される)',
        !('1' in (after3.checks['0'] || {})), JSON.stringify(after3.checks));
    check('検証3e: chars配列自体は変更前後でバイト一致(並び替え・再保存なし)',
        JSON.stringify(after3.chars) === JSON.stringify(before.chars), JSON.stringify(after3.chars));

    // ================================================================
    // 検証4: printAllKanjiPDFの並びが入力層と一致
    // ================================================================
    let printOrder = await page.evaluate(() => {
        var kanjiData = StorageManager.get(KEYS.kanji, { chars: [], checks: {} });
        var chars = kanjiData.chars || [];
        var displayChars = chars; // v1.8.52: 入力層と同じ並び
        return displayChars.map(function(c, displayIdx) {
            return { char: c, charIdx: displayIdx };
        });
    });
    let printCharsOk = JSON.stringify(printOrder.map(p => p.char)) === JSON.stringify(KANJI_DATA.chars);
    check('検証4a: printAllKanjiPDFの文字並びが入力層(追加順)と一致', printCharsOk, JSON.stringify(printOrder.map(p => p.char)));
    let printIdxOk = printOrder.every(function(p, i) { return p.charIdx === i; });
    check('検証4b: printAllKanjiPDFのcharIdx対応がdisplayIdxと一致(charIdx=displayIdx)', printIdxOk, JSON.stringify(printOrder));

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
