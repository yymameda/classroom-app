// v1.8.51 機械検証（コミット③: 児童選択タイル化＋△数表示・アクセント）
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.51_commit3.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- 新形式（フラット）テストデータ ----
// 児童0: △あり(st-resubmit) / 児童1: 全完了(st-done) / 児童2: 一部未チェック(neutral) / 児童3: 未チェックのみ / 児童4: 完全未着手
const NEW_KANJI_DATA = {
    chars: ['一','二','三','四','五','六','七','八','九','十','百','千','万','億','円','銭','分','厘','毛','糸','忽','微'],
    checks: {
        '0': { '0': 'o', '1': 'd', '9': 'o', '21': 'd' }, // unchecked=18, retry=2 -> st-resubmit
        '1': (function() { var o = {}; for (let i = 0; i < 22; i++) o[String(i)] = 'o'; return o; })(), // unchecked=0, retry=0 -> st-done
        '2': { '5': 'o', '6': 'o' }, // unchecked=20, retry=0 -> neutral
        '3': {}, // unchecked=22, retry=0 -> neutral
        '4': { '0': 'd' } // unchecked=21, retry=1 -> st-resubmit
    }
};
const TOTAL_CHARS = NEW_KANJI_DATA.chars.length; // 22

async function openStudent(page, si) {
    await page.evaluate((idx) => window.kanjiOpenStudent(idx), si);
    await new Promise(r => setTimeout(r, 50));
}
async function backToList(page) {
    await page.evaluate(() => window.kanjiBackToList());
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

    // --- 新形式データ＋5人の児童を投入 ---
    await page.evaluate((kanjiData) => {
        const students = [];
        for (let i = 1; i <= 5; i++) students.push({ name: '児童テスト氏名' + String(i).padStart(2, '0') });
        master.students = students;
        StorageManager.setImmediate(KEYS.kanji, JSON.stringify(kanjiData));
    }, NEW_KANJI_DATA);
    await page.evaluate(() => showView('kanji'));
    await new Promise(r => setTimeout(r, 100));

    // ================================================================
    // タイル基本構造：5タイル、各タイルに番号・氏名・未/△表示
    // ================================================================
    let tiles = await page.evaluate(() => Array.from(document.querySelectorAll('#kanjiTileGrid .kanji-tile-cell')).map(c => ({
        num: c.querySelector('.kanji-tile-num').textContent.trim(),
        name: c.querySelector('.kanji-tile-name').textContent.trim(),
        marks: Array.from(c.querySelectorAll('.kanji-tile-marks span')).map(s => s.textContent.trim()),
        classList: Array.from(c.classList)
    })));

    check('検証: タイル数=児童数(5)', tiles.length === 5, String(tiles.length));
    check('検証: タイル1の番号="1"', tiles[0] && tiles[0].num === '1', JSON.stringify(tiles[0] && tiles[0].num));
    check('検証: タイル1の氏名が5文字に切り詰められている', tiles[0] && tiles[0].name === '児童テスト氏名'.substring(0, 5), JSON.stringify(tiles[0] && tiles[0].name));

    // ================================================================
    // 未チェック数・△数が実データと一致
    // ================================================================
    const expected = [0, 1, 2, 3, 4].map(si => {
        const stuChecks = NEW_KANJI_DATA.checks[String(si)] || {};
        let unchecked = 0, retry = 0;
        for (let ci = 0; ci < TOTAL_CHARS; ci++) {
            const v = stuChecks[String(ci)];
            if (v === 'd') retry++;
            else if (!v) unchecked++;
        }
        return { unchecked: '未' + unchecked, retry: '△' + retry };
    });
    let countsOk = true, countsDetail = [];
    for (let i = 0; i < 5; i++) {
        const m = tiles[i] ? tiles[i].marks : [];
        if (m[0] !== expected[i].unchecked || m[1] !== expected[i].retry) {
            countsOk = false;
            countsDetail.push({ i, actual: m, expected: expected[i] });
        }
    }
    check('検証: 各タイルの未チェック数・△数が実データと一致', countsOk, JSON.stringify({ detail: countsDetail, tiles: tiles.map(t => t.marks), expected }));

    // ================================================================
    // アクセント表示：△>0 -> st-resubmit / unchecked=0 -> st-done / それ以外 neutral
    // ================================================================
    check('検証: 児童0(△2件)はst-resubmitクラス', tiles[0].classList.indexOf('st-resubmit') >= 0, JSON.stringify(tiles[0].classList));
    check('検証: 児童1(全完了・△0)はst-doneクラス', tiles[1].classList.indexOf('st-done') >= 0, JSON.stringify(tiles[1].classList));
    check('検証: 児童2(未チェックあり・△0)はst-resubmit/st-doneどちらも持たない', tiles[2].classList.indexOf('st-resubmit') === -1 && tiles[2].classList.indexOf('st-done') === -1, JSON.stringify(tiles[2].classList));
    check('検証: 児童3(全未チェック)はst-resubmit/st-doneどちらも持たない', tiles[3].classList.indexOf('st-resubmit') === -1 && tiles[3].classList.indexOf('st-done') === -1, JSON.stringify(tiles[3].classList));
    check('検証: 児童4(△1件のみ、unchecked>0)はst-resubmitクラス(st-doneより優先)', tiles[4].classList.indexOf('st-resubmit') >= 0 && tiles[4].classList.indexOf('st-done') === -1, JSON.stringify(tiles[4].classList));

    // ================================================================
    // タップ領域サイズ：44pt以上
    // ================================================================
    let tileSize = await page.evaluate(() => {
        const cell = document.querySelector('#kanjiTileGrid .kanji-tile-cell');
        const r = cell.getBoundingClientRect();
        return { width: r.width, height: r.height };
    });
    check('検証: タイルの高さが44px以上', tileSize.height >= 44, JSON.stringify(tileSize));

    // ================================================================
    // 動線：タイルタップ→入力層→一覧へ戻る
    // ================================================================
    await page.evaluate(() => {
        document.querySelector('#kanjiTileGrid .kanji-tile-cell').click();
    });
    await new Promise(r => setTimeout(r, 50));
    let afterTap = await page.evaluate(() => ({
        title: document.getElementById('kanjiStudentTitle') ? document.getElementById('kanjiStudentTitle').textContent : '',
        listVisible: document.getElementById('kanjiListWrap') ? getComputedStyle(document.getElementById('kanjiListWrap')).display !== 'none' : null
    }));
    check('検証: タイルタップで入力層へ遷移(タイトルに氏名)', afterTap.title.indexOf('児童テスト氏名01') >= 0, JSON.stringify(afterTap));

    await backToList(page);
    let afterBack = await page.evaluate(() => document.querySelectorAll('#kanjiTileGrid .kanji-tile-cell').length);
    check('検証: 一覧へ戻るとタイルグリッドが再表示される(5件)', afterBack === 5, String(afterBack));

    // ================================================================
    // openStudent 経由の動線（既存関数）も問題なく動作
    // ================================================================
    await openStudent(page, 1);
    let title2 = await page.evaluate(() => document.getElementById('kanjiStudentTitle').textContent);
    check('検証: kanjiOpenStudent(1)で児童テスト氏名02の入力層へ遷移', title2.indexOf('児童テスト氏名02') >= 0, title2);
    await backToList(page);

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
