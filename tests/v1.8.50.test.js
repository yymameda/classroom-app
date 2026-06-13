// v1.8.50 機械検証: 漢字チェックの二層構造化
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.50.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- 入力層の8列フラット化（kjBuildFlatItemsと同じロジック：新しい単元→古い単元の順） ----
function buildFlatItems(data) {
    const units = data.units || [];
    const items = [];
    for (let ui = units.length - 1; ui >= 0; ui--) {
        const chars = units[ui].chars || [];
        for (let ci = 0; ci < chars.length; ci++) {
            items.push({ unitIdx: ui, charIdx: ci, char: chars[ci] });
        }
    }
    return items;
}

// ---- kanjiToggleと同じ循環ロジック（空→△→○→空）を適用 ----
function applyToggle(data, unitIdx, stuIdx, charIdx) {
    const unit = data.units[unitIdx];
    if (!unit.checks[String(stuIdx)]) unit.checks[String(stuIdx)] = {};
    const cur = unit.checks[String(stuIdx)][String(charIdx)];
    if (!cur) {
        unit.checks[String(stuIdx)][String(charIdx)] = 'd';
    } else if (cur === 'd') {
        unit.checks[String(stuIdx)][String(charIdx)] = 'o';
    } else {
        delete unit.checks[String(stuIdx)][String(charIdx)];
    }
    return data;
}

// ---- 単元データ（境界跨ぎを発生させる構成） ----
// A単元(10字)・B単元(4字)・C単元(8字)。units配列は古い→新しい順 = [A, B, C]。
// flat化(新しい単元が先頭)すると: C(8字)→row0全体, B(4字)→row1の0-3列, A(10字の先頭4字)→row1の4-7列, A(残り6字)→row2
const KANJI_DATA = {
    units: [
        { name: 'A単元', chars: ['一','二','三','四','五','六','七','八','九','十'], checks: {} },
        { name: 'B単元', chars: ['百','千','万','億'], checks: {} },
        { name: 'C単元', chars: ['円','銭','分','厘','毛','糸','忽','微'], checks: {} }
    ]
};
const TOTAL_CHARS = 10 + 4 + 8; // 22

async function gridCell(page, idx) {
    return page.evaluateHandle((i) => document.getElementById('kanjiGrid').children[i], idx);
}
async function tapGridCell(page, idx) {
    await page.evaluate((i) => {
        document.getElementById('kanjiGrid').children[i].click();
    }, idx);
    await new Promise(r => setTimeout(r, 50));
}
async function readKanjiData(page) {
    const raw = await page.evaluate(() => localStorage.getItem('spa_kanji'));
    return { raw, data: JSON.parse(raw) };
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

    // --- 初期データ投入: 5人 + 漢字データ ---
    await page.evaluate((kanjiData) => {
        const students = [];
        for (let i = 1; i <= 5; i++) students.push({ name: '生徒' + String(i).padStart(2, '0') });
        master.students = students;
        StorageManager.setImmediate(KEYS.kanji, JSON.stringify(kanjiData));
    }, KANJI_DATA);
    await page.evaluate(() => showView('kanji'));
    await new Promise(r => setTimeout(r, 100));

    // ================================================================
    // 検証5/6: 一覧層の表示確認
    // ================================================================
    let listState = await page.evaluate(() => ({
        listHeader: getComputedStyle(document.getElementById('kanjiListHeader')).display,
        studentHeader: getComputedStyle(document.getElementById('kanjiStudentHeader')).display,
        listWrap: getComputedStyle(document.getElementById('kanjiListWrap')).display,
        studentWrap: getComputedStyle(document.getElementById('kanjiStudentWrap')).display,
        rowCount: document.querySelectorAll('#kanjiListWrap .kanji-list-row').length
    }));
    check('検証5: 初期表示は一覧層', listState.listHeader !== 'none' && listState.studentHeader === 'none'
        && listState.listWrap !== 'none' && listState.studentWrap === 'none' && listState.rowCount === 5,
        JSON.stringify(listState));

    // ================================================================
    // 検証2: 累計未チェック数（初期状態は全員 全文字数分）
    // ================================================================
    let badges0 = await page.evaluate(() => {
        const rows = document.querySelectorAll('#kanjiListWrap .kanji-list-row');
        return Array.from(rows).map(r => r.querySelector('td:nth-child(3) span').textContent.trim());
    });
    check('検証2: 初期状態の累計未チェック数は全員' + TOTAL_CHARS, badges0.every(b => b === String(TOTAL_CHARS)), JSON.stringify(badges0));

    // ================================================================
    // 検証5: 一覧→児童選択→入力層へ遷移
    // ================================================================
    await page.evaluate(() => {
        document.querySelectorAll('#kanjiListWrap .kanji-list-row')[0].click();
    });
    await new Promise(r => setTimeout(r, 50));
    let studentState = await page.evaluate(() => ({
        listHeader: getComputedStyle(document.getElementById('kanjiListHeader')).display,
        studentHeader: getComputedStyle(document.getElementById('kanjiStudentHeader')).display,
        listWrap: getComputedStyle(document.getElementById('kanjiListWrap')).display,
        studentWrap: getComputedStyle(document.getElementById('kanjiStudentWrap')).display,
        title: document.getElementById('kanjiStudentTitle').textContent,
        cellCount: document.querySelectorAll('#kanjiGrid .kanji-grid-cell').length
    }));
    check('検証5: 一覧行タップ→入力層(児童0)へ遷移', studentState.listHeader === 'none' && studentState.studentHeader !== 'none'
        && studentState.listWrap === 'none' && studentState.studentWrap !== 'none'
        && studentState.title.indexOf('生徒01') >= 0 && studentState.cellCount === TOTAL_CHARS,
        JSON.stringify(studentState));

    // ================================================================
    // 検証3: 最新回（最後に追加した単元=C単元）が最上段に来ること
    // ================================================================
    let firstCell = await page.evaluate(() => {
        const c = document.getElementById('kanjiGrid').children[0];
        return { char: c.querySelector('.kgc-char').textContent };
    });
    check('検証3: 入力層の最上段先頭セルは最新単元(C単元)の先頭文字「円」', firstCell.char === '円', JSON.stringify(firstCell));

    // ================================================================
    // 検証4: 各セルが44pt以上
    // ================================================================
    let cellRect = await page.evaluate(() => {
        const r = document.getElementById('kanjiGrid').children[0].getBoundingClientRect();
        return { width: r.width, height: r.height };
    });
    check('検証4: グリッドセルが44pt以上', cellRect.width >= 44 && cellRect.height >= 44, JSON.stringify(cellRect));

    // ================================================================
    // 検証7: グリッド位置→(unitIdx, charIdx)マッピング（単元境界跨ぎ）
    // ----------------------------------------------------------------
    // flat順: idx0-7=C単元(unitIdx2) charIdx0-7 / idx8-11=B単元(unitIdx1) charIdx0-3
    //         / idx12-21=A単元(unitIdx0) charIdx0-9
    // row1(2行目) = idx8-15 は B単元(cols0-3) と A単元(cols4-7) の境界跨ぎ行。
    //   idx12 (row1,col4) → A単元(unitIdx0) charIdx0
    //   idx11 (row1,col3) → B単元(unitIdx1) charIdx3
    // ================================================================
    // 児童0(si=0)で idx12 をタップ → A単元 checks["0"]["0"] = 'd' のみ更新
    await tapGridCell(page, 12);
    let { data: d7a } = await readKanjiData(page);
    let u0c0 = ((d7a.units[0].checks || {})['0'] || {})['0'];
    let u1Empty = !d7a.units[1].checks || !d7a.units[1].checks['0'] || Object.keys(d7a.units[1].checks['0']).length === 0;
    let u2Empty = !d7a.units[2].checks || !d7a.units[2].checks['0'] || Object.keys(d7a.units[2].checks['0']).length === 0;
    check('検証7a: グリッド境界行(row1,col4)=idx12タップ→A単元(unitIdx0) charIdx0のみ更新',
        u0c0 === 'd' && u1Empty && u2Empty,
        JSON.stringify({ u0c0, u1: d7a.units[1].checks, u2: d7a.units[2].checks }));

    // 児童0(si=0)で idx11 をタップ → B単元 checks["0"]["3"] = 'd' のみ追加、A単元の更新は維持される
    await tapGridCell(page, 11);
    let { data: d7b } = await readKanjiData(page);
    let u0c0_after = ((d7b.units[0].checks || {})['0'] || {})['0'];
    let u1c3 = ((d7b.units[1].checks || {})['0'] || {})['3'];
    let u0OtherKeys = Object.keys((d7b.units[0].checks || {})['0'] || {});
    let u1OtherKeys = Object.keys((d7b.units[1].checks || {})['0'] || {});
    check('検証7b: グリッド境界行(row1,col3)=idx11タップ→B単元(unitIdx1) charIdx3のみ追加、A単元側は不変',
        u1c3 === 'd' && u0c0_after === 'd' && u0OtherKeys.length === 1 && u0OtherKeys[0] === '0'
        && u1OtherKeys.length === 1 && u1OtherKeys[0] === '3',
        JSON.stringify({ u0c0_after, u1c3, u0OtherKeys, u1OtherKeys }));

    // ================================================================
    // 検証2(続): 児童0の累計未チェック数が 22-2=20 になっていること
    // ================================================================
    await backToList(page);
    let badges1 = await page.evaluate(() => {
        const rows = document.querySelectorAll('#kanjiListWrap .kanji-list-row');
        return Array.from(rows).map(r => r.querySelector('td:nth-child(3) span').textContent.trim());
    });
    check('検証2: △2件入力後、児童0の累計未チェック数は' + (TOTAL_CHARS - 2), badges1[0] === String(TOTAL_CHARS - 2), JSON.stringify(badges1));
    check('検証5: 入力層→「一覧へ戻る」で一覧層に戻る', badges1.length === 5, JSON.stringify(badges1));

    // ================================================================
    // 検証1: データ形式バイト一致（循環 空→△→○→空 が既存仕様どおりに保存されること）
    // ================================================================
    await page.evaluate(() => {
        document.querySelectorAll('#kanjiListWrap .kanji-list-row')[2].click(); // 児童2(si=2)
    });
    await new Promise(r => setTimeout(r, 50));

    // 1回目タップ: 空→△('d')
    let { data: before1 } = await readKanjiData(page);
    let expected1 = applyToggle(JSON.parse(JSON.stringify(before1)), 2, 2, 0); // idx0 = C単元(unitIdx2) charIdx0
    await tapGridCell(page, 0);
    let { raw: raw1 } = await readKanjiData(page);
    check('検証1a: 空→△タップ後の保存値がバイト一致', raw1 === JSON.stringify(expected1), raw1 + ' vs ' + JSON.stringify(expected1));

    // 2回目タップ: △→○('o')
    let expected2 = applyToggle(JSON.parse(JSON.stringify(expected1)), 2, 2, 0);
    await tapGridCell(page, 0);
    let { raw: raw2 } = await readKanjiData(page);
    check('検証1b: △→○タップ後の保存値がバイト一致', raw2 === JSON.stringify(expected2), raw2 + ' vs ' + JSON.stringify(expected2));

    // 3回目タップ: ○→空（キー削除）
    let expected3 = applyToggle(JSON.parse(JSON.stringify(expected2)), 2, 2, 0);
    await tapGridCell(page, 0);
    let { raw: raw3 } = await readKanjiData(page);
    check('検証1c: ○→空タップ後の保存値がバイト一致', raw3 === JSON.stringify(expected3), raw3 + ' vs ' + JSON.stringify(expected3));

    // ================================================================
    // 検証6: 全体フロー（一覧→児童選択→循環入力→一覧へ戻る）でコンソールエラーなし
    // ================================================================
    await backToList(page);
    let finalListState = await page.evaluate(() => ({
        listHeader: getComputedStyle(document.getElementById('kanjiListHeader')).display,
        rowCount: document.querySelectorAll('#kanjiListWrap .kanji-list-row').length
    }));
    check('検証6: 全体フロー後、一覧層が正常表示', finalListState.listHeader !== 'none' && finalListState.rowCount === 5, JSON.stringify(finalListState));

    const realErrors = consoleErrors.filter(e => e.url.indexOf('favicon') === -1);
    check('検証6: コンソールエラーなし（favicon 404除く）', realErrors.length === 0, JSON.stringify(realErrors));

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
