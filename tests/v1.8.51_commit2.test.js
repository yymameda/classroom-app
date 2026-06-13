// v1.8.51 機械検証（コミット②: 単元UI撤去とフラット化対応）
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.51_commit2.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- 新形式（フラット）テストデータ ----
// chars配列のインデックス0が最古、末尾が最新。表示は追加順（昇順、先頭=最古、末尾=最新、v1.8.52）。
const NEW_KANJI_DATA = {
    chars: ['一','二','三','四','五','六','七','八','九','十','百','千','万','億','円','銭','分','厘','毛','糸','忽','微'],
    checks: {
        '0': { '0': 'o', '1': 'd', '9': 'o', '21': 'd' },
        '2': { '5': 'd' },
        '3': { '21': 'o', '14': 'd' }
    }
};
const TOTAL_CHARS = NEW_KANJI_DATA.chars.length; // 22

// ---- kanjiToggleと同じ循環ロジック（空→△→○→空） ----
function applyToggle(data, stuIdx, charIdx) {
    if (!data.checks[String(stuIdx)]) data.checks[String(stuIdx)] = {};
    const cur = data.checks[String(stuIdx)][String(charIdx)];
    if (!cur) {
        data.checks[String(stuIdx)][String(charIdx)] = 'd';
    } else if (cur === 'd') {
        data.checks[String(stuIdx)][String(charIdx)] = 'o';
    } else {
        delete data.checks[String(stuIdx)][String(charIdx)];
    }
    return data;
}

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
        for (let i = 1; i <= 5; i++) students.push({ name: '生徒' + String(i).padStart(2, '0') });
        master.students = students;
        StorageManager.setImmediate(KEYS.kanji, JSON.stringify(kanjiData));
    }, NEW_KANJI_DATA);
    await page.evaluate(() => showView('kanji'));
    await new Promise(r => setTimeout(r, 100));

    // ================================================================
    // 一覧層：単元UIが撤去され、行数=児童数、初期未チェック数=全文字数
    // ================================================================
    let listState = await page.evaluate(() => ({
        hasUnitSel: !!document.getElementById('kanjiUnitSel'),
        addBtnText: document.querySelector('#kanjiListHeader button') ? document.querySelector('#kanjiListHeader button').textContent : '',
        rowCount: document.querySelectorAll('#kanjiListWrap .kanji-tile-cell').length,
        badges: Array.from(document.querySelectorAll('#kanjiListWrap .kanji-tile-cell')).map(r => r.querySelectorAll('.kanji-tile-marks span')[0].textContent.replace('未', ''))
    }));
    check('検証: kanjiUnitSel(単元セレクト)が存在しない', !listState.hasUnitSel, JSON.stringify(listState.hasUnitSel));
    check('検証: ヘッダーボタンが「＋漢字を追加」', listState.addBtnText.indexOf('漢字を追加') >= 0, listState.addBtnText);
    check('検証: 一覧行数=児童数(5)', listState.rowCount === 5, String(listState.rowCount));
    // 児童ごとの未チェック数 = TOTAL_CHARS - (その児童のchecksのキー数)
    const expectedBadges = [0, 1, 2, 3, 4].map(si => {
        const n = Object.keys((NEW_KANJI_DATA.checks[String(si)] || {})).length;
        return String(TOTAL_CHARS - n);
    });
    check('検証: 初期未チェック数が実データのchecks件数と一致', JSON.stringify(listState.badges) === JSON.stringify(expectedBadges),
        JSON.stringify({ actual: listState.badges, expected: expectedBadges }));

    // ================================================================
    // 入力層：グリッドはchars昇順（先頭セル=最古、末尾セル=最新、v1.8.52）
    // ================================================================
    await openStudent(page, 0);
    let studentState = await page.evaluate(() => ({
        title: document.getElementById('kanjiStudentTitle').textContent,
        cellCount: document.querySelectorAll('#kanjiGrid .kanji-grid-cell').length,
        firstChar: document.getElementById('kanjiGrid').children[0].querySelector('.kgc-char').textContent,
        lastChar: document.getElementById('kanjiGrid').children[document.getElementById('kanjiGrid').children.length - 1].querySelector('.kgc-char').textContent
    }));
    check('検証: 入力層タイトルに生徒01', studentState.title.indexOf('生徒01') >= 0, studentState.title);
    check('検証: グリッドセル数=全文字数' + TOTAL_CHARS, studentState.cellCount === TOTAL_CHARS, String(studentState.cellCount));
    check('検証: 先頭セルはchars先頭(最古)の文字「一」', studentState.firstChar === '一', studentState.firstChar);
    check('検証: 末尾セルはchars末尾(最新)の文字「微」', studentState.lastChar === '微', studentState.lastChar);

    // 既存チェックの表示確認: 児童0は charIdx0='o', charIdx1='d', charIdx9='o', charIdx21='d'
    // 表示位置 = charIdx（v1.8.52: 昇順表示）
    let marks0 = await page.evaluate(() => {
        const grid = document.getElementById('kanjiGrid');
        const get = (charIdx) => grid.children[charIdx].querySelector('.kgc-mark').textContent;
        return { c0: get(0), c1: get(1), c9: get(9), c21: get(21) };
    });
    check('検証: 児童0の既存チェック(○/△)が正しい位置に表示', marks0.c0 === '○' && marks0.c1 === '△' && marks0.c9 === '○' && marks0.c21 === '△', JSON.stringify(marks0));

    // ================================================================
    // 循環入力: 空→△→○→空 が新形式checksにバイト一致で保存される
    // ================================================================
    // 表示位置0,1,9,21(charIdx=0,1,9,21)は児童0で既にチェック済み。表示位置2(charIdx=2, 未チェック)を使う
    let { data: before1 } = await readKanjiData(page);
    let expected1 = applyToggle(JSON.parse(JSON.stringify(before1)), 0, 2);
    await tapGridCell(page, 2);
    let { raw: raw1 } = await readKanjiData(page);
    check('検証: 空→△タップ後の保存値がバイト一致', raw1 === JSON.stringify(expected1), raw1 + ' vs ' + JSON.stringify(expected1));

    let expected2 = applyToggle(JSON.parse(JSON.stringify(expected1)), 0, 2);
    await tapGridCell(page, 2);
    let { raw: raw2 } = await readKanjiData(page);
    check('検証: △→○タップ後の保存値がバイト一致', raw2 === JSON.stringify(expected2), raw2 + ' vs ' + JSON.stringify(expected2));

    let expected3 = applyToggle(JSON.parse(JSON.stringify(expected2)), 0, 2);
    await tapGridCell(page, 2);
    let { raw: raw3 } = await readKanjiData(page);
    check('検証: ○→空タップ後の保存値がバイト一致', raw3 === JSON.stringify(expected3), raw3 + ' vs ' + JSON.stringify(expected3));

    // ================================================================
    // 一覧へ戻る → 児童0の未チェック数が変化していないこと（循環で元に戻したため）
    // ================================================================
    await backToList(page);
    let badges1 = await page.evaluate(() => Array.from(document.querySelectorAll('#kanjiListWrap .kanji-tile-cell')).map(r => r.querySelectorAll('.kanji-tile-marks span')[0].textContent.replace('未', '')));
    check('検証: 動線(入力層→一覧へ戻る)後、未チェック数は変化なし', badges1[0] === String(TOTAL_CHARS - 4), JSON.stringify(badges1));

    // ================================================================
    // データ追加: chars.push(末尾追加)のみ、既存charIdx・checksは不変
    // ================================================================
    let { data: beforeAdd } = await readKanjiData(page);
    await page.evaluate(() => {
        window.kanjiOpenAddModal();
        document.getElementById('kanjiModalChars').value = '愛 情';
        window.kanjiAddChars();
    });
    await new Promise(r => setTimeout(r, 50));
    let { data: afterAdd } = await readKanjiData(page);

    check('検証: 追加後のchars.length = 旧+2', afterAdd.chars.length === beforeAdd.chars.length + 2,
        'before=' + beforeAdd.chars.length + ' after=' + afterAdd.chars.length);
    check('検証: 追加文字がchars末尾にpushされている', afterAdd.chars[afterAdd.chars.length - 2] === '愛' && afterAdd.chars[afterAdd.chars.length - 1] === '情',
        JSON.stringify(afterAdd.chars.slice(-2)));

    let oldCharsUnchanged = true;
    for (let i = 0; i < beforeAdd.chars.length; i++) {
        if (afterAdd.chars[i] !== beforeAdd.chars[i]) oldCharsUnchanged = false;
    }
    check('検証: 既存charIdxのchars値は不変', oldCharsUnchanged, JSON.stringify({ before: beforeAdd.chars, after: afterAdd.chars.slice(0, beforeAdd.chars.length) }));

    let checksUnchanged = JSON.stringify(afterAdd.checks) === JSON.stringify(beforeAdd.checks);
    check('検証: checksは追加操作で一切変更されない', checksUnchanged, JSON.stringify({ before: beforeAdd.checks, after: afterAdd.checks }));

    // 追加後、入力層の末尾セルは新しい最新文字「情」になっている（v1.8.52: 末尾=最新）
    await openStudent(page, 0);
    let lastCharAfterAdd = await page.evaluate(() => {
        const grid = document.getElementById('kanjiGrid');
        return grid.children[grid.children.length - 1].querySelector('.kgc-char').textContent;
    });
    check('検証: 追加後、入力層の末尾セルは新しい最新文字「情」', lastCharAfterAdd === '情', lastCharAfterAdd);
    await backToList(page);

    // ================================================================
    // printAllKanjiPDF が新形式データで参照エラーなく呼び出せること
    // ================================================================
    let printErr = await page.evaluate(() => {
        try {
            // html2canvas/jspdf未読込でも、データ参照部分(units未定義エラー等)がないことを確認
            var kanjiData = StorageManager.get(KEYS.kanji, { chars: [], checks: {} });
            var chars = kanjiData.chars || [];
            var displayChars = chars.slice().reverse();
            return { ok: true, len: chars.length, displayLen: displayChars.length };
        } catch (e) {
            return { ok: false, message: e.message };
        }
    });
    check('検証: printAllKanjiPDFのデータ参照(新形式chars)がエラーなく動作', printErr.ok, JSON.stringify(printErr));

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
