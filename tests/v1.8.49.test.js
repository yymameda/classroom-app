// v1.8.49 機械検証: 連続入力モード モードレス化(出席簿準拠) + lateOnDue締切連動
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node v1.8.49.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const DUE_DATE = '2026-06-12';

// ローカル時刻でのタイムスタンプ（タイムゾーン依存をNode側に閉じる）
const ON_DUE_TS      = new Date(2026, 5, 12, 10, 0, 0).getTime(); // 期限当日 10:00
const NEXT_DAY_TS    = new Date(2026, 5, 13, 10, 0, 0).getTime(); // 期限翌日 10:00
const BOUNDARY_TS    = new Date(2026, 5, 12,  8, 0, 0).getTime(); // 期限当日 朝8:00（日付境界チェック）

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

// ---- ページ操作ヘルパー ----
async function setMockDate(page, ts) {
    await page.evaluate((fixed, enable) => {
        if (!window.__RealDate) window.__RealDate = Date;
        if (!enable) { window.Date = window.__RealDate; return; }
        const RealDate = window.__RealDate;
        class MockDate extends RealDate {
            constructor(...args) {
                if (args.length === 0) return new RealDate(fixed);
                return new RealDate(...args);
            }
            static now() { return fixed; }
        }
        window.Date = MockDate;
    }, ts || 0, ts !== null && ts !== undefined);
}

// 課題日付を設定し、提出データを空にして提出物入力タブを初期化する
async function setup(page, assignDate) {
    await setMockDate(page, null);
    await page.evaluate((d) => {
        const assigns = StorageManager.get(KEYS.submissions_assignments, []);
        if (assigns.length) {
            assigns[0].date = d;
            StorageManager.setImmediate(KEYS.submissions_assignments, JSON.stringify(assigns));
        }
        StorageManager.setImmediate(KEYS.submissions_data, JSON.stringify([]));
        showView('submissions');
    }, assignDate);
    await new Promise(r => setTimeout(r, 100));
    await page.evaluate(() => {
        const sel = document.getElementById('subInputAssignSel');
        sel.value = '1';
        sel.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 100));
    await page.evaluate(() => document.getElementById('subViewContBtn').click());
    await new Promise(r => setTimeout(r, 50));
}

async function tapCell(page, idx) {
    await page.click('#subContGrid .sub-cont-cell[data-cidx="' + idx + '"]');
    await new Promise(r => setTimeout(r, 50));
}
async function modalSelect(page, dataS) {
    await page.click('#subStatusModal .att-status-opt[data-s="' + dataS + '"]');
    await new Promise(r => setTimeout(r, 50));
}
async function getModalLateToggle(page) {
    return page.evaluate(() => document.getElementById('subModalLateToggle').checked);
}
async function setModalLateToggle(page, val) {
    await page.evaluate((v) => {
        const t = document.getElementById('subModalLateToggle');
        if (t.checked !== v) t.click();
    }, val);
}
async function clickListStatusBtn(page, idx, status) {
    await page.evaluate(() => document.getElementById('subViewListBtn').click());
    await new Promise(r => setTimeout(r, 50));
    await page.click('#subListWrap .sub-input-row[data-idx="' + idx + '"] .sub-status-btn[data-status="' + status + '"]');
    await new Promise(r => setTimeout(r, 50));
}
// 表示切替（subFlushAutoSave発火）→ 500msデバウンス完了後にlocalStorageを読む
async function flushAndRead(page) {
    await page.evaluate(() => {
        const cont = document.getElementById('subViewContBtn');
        const list = document.getElementById('subViewListBtn');
        if (cont.classList.contains('active')) list.click(); else cont.click();
    });
    await new Promise(r => setTimeout(r, 700));
    return page.evaluate(() => localStorage.getItem('spa_submissions_data'));
}
async function flushAndGetRec(page, idx) {
    const raw = await flushAndRead(page);
    const arr = JSON.parse(raw || '[]');
    return arr.find(r => r.studentIndex === idx) || null;
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

    // --- 初期データ投入: 38人 + 1課題 ---
    await page.evaluate((dueDate) => {
        const students = [];
        for (let i = 1; i <= 38; i++) students.push({ name: '生徒' + String(i).padStart(2, '0') });
        master.students = students;
        const assign = { id: 1, subject: '国語', name: 'テスト課題', date: dueDate, createdAt: new Date().toISOString() };
        StorageManager.setImmediate(KEYS.submissions_assignments, JSON.stringify([assign]));
        StorageManager.setImmediate(KEYS.submissions_data, JSON.stringify([]));
    }, DUE_DATE);
    await page.evaluate(() => showView('submissions'));
    await page.waitForSelector('#subInputAssignSel');

    // ================================================================
    // 検証1: lateOnDue値検証
    // ================================================================
    // 1a: 当日タップ(空セル○) → false
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await tapCell(page, 0);
    let rec = await flushAndGetRec(page, 0);
    check('検証1a: 当日タップ(空セル○) lateOnDue=false', rec && rec.lateOnDue === false, JSON.stringify(rec));

    // 1b: Dateモック翌日タップ(空セル○) → true
    await setup(page, DUE_DATE);
    await setMockDate(page, NEXT_DAY_TS);
    await tapCell(page, 0);
    rec = await flushAndGetRec(page, 0);
    check('検証1b: 翌日タップ(空セル○) lateOnDue=true', rec && rec.lateOnDue === true, JSON.stringify(rec));

    // 1c: 提出日なし課題 → 常にfalse
    await setup(page, '');
    await setMockDate(page, NEXT_DAY_TS);
    await tapCell(page, 0);
    rec = await flushAndGetRec(page, 0);
    check('検証1c: 提出日なし課題 lateOnDue=false', rec && rec.lateOnDue === false, JSON.stringify(rec));

    // ================================================================
    // 検証2: 欠席遷移検証（同一セッション内、idx0/1/2で並行検証）
    // ================================================================
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    // idx0: 当日「欠席」にする（タップ→○提出、再タップ→モーダル→欠）
    await tapCell(page, 0);
    await tapCell(page, 0);
    await modalSelect(page, 'absent');
    // idx1: 当日「未提出」にする（タップ→○提出、再タップ→モーダル→×）
    await tapCell(page, 1);
    await tapCell(page, 1);
    await modalSelect(page, 'missing');
    // idx2: 当日は入力なし

    await setMockDate(page, NEXT_DAY_TS);
    // idx0: 翌日、モーダル→○提出（欠席からの上書き：lateOnDue=false 期待）
    await tapCell(page, 0);
    await modalSelect(page, 'submitted');
    // idx1: 翌日、モーダル→○提出（未提出からの上書き：lateOnDue=true 期待）
    await tapCell(page, 1);
    await modalSelect(page, 'submitted');
    // idx2: 翌日、空セルタップ→○提出（入力なしからの記録：lateOnDue=true 期待）
    await tapCell(page, 2);

    await page.evaluate(() => document.getElementById('subViewListBtn').click());
    await new Promise(r => setTimeout(r, 700));
    let arr2 = JSON.parse(await page.evaluate(() => localStorage.getItem('spa_submissions_data')) || '[]');
    let rec0 = arr2.find(r => r.studentIndex === 0);
    let rec1 = arr2.find(r => r.studentIndex === 1);
    let rec2 = arr2.find(r => r.studentIndex === 2);
    check('検証2a: 当日「欠席」→翌日○提出(モーダル) lateOnDue=false', rec0 && rec0.lateOnDue === false && rec0.status === 'submitted', JSON.stringify(rec0));
    check('検証2b: 当日「未提出」→翌日○提出(モーダル) lateOnDue=true', rec1 && rec1.lateOnDue === true && rec1.status === 'submitted', JSON.stringify(rec1));
    check('検証2c: 当日入力なし→翌日○提出(空セル) lateOnDue=true', rec2 && rec2.lateOnDue === true && rec2.status === 'submitted', JSON.stringify(rec2));

    // ================================================================
    // 検証3: データ形式バイト一致
    // ================================================================
    // 3a: リスト表示経由(○) vs 空セルタップ経由(○)
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await clickListStatusBtn(page, 5, 'submitted');
    let result3aList = await flushAndRead(page);

    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await tapCell(page, 5);
    let result3aCont = await flushAndRead(page);

    check('検証3a: バイト一致(リスト ○ vs 空セルタップ ○)', result3aList === result3aCont, result3aList + ' vs ' + result3aCont);

    // 3b: リスト表示経由(△) vs モーダル経由(△)
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await clickListStatusBtn(page, 8, 'resubmit');
    let result3bList = await flushAndRead(page);

    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await tapCell(page, 8);       // 空セル→○提出
    await tapCell(page, 8);       // 再タップ→モーダル
    await modalSelect(page, 'resubmit'); // △選択（トグルは初期値false=非遅れのまま）
    let result3bCont = await flushAndRead(page);

    check('検証3b: バイト一致(リスト △ vs モーダル △)', result3bList === result3bCont, result3bList + ' vs ' + result3bCont);

    // ================================================================
    // 検証4: 日付境界（ローカル朝8:00で当日チェック=false）
    // ================================================================
    await setup(page, DUE_DATE);
    await setMockDate(page, BOUNDARY_TS);
    await tapCell(page, 0);
    rec = await flushAndGetRec(page, 0);
    check('検証4: ローカル朝8:00 当日タップ lateOnDue=false', rec && rec.lateOnDue === false, JSON.stringify(rec));

    // ================================================================
    // 追加検証: 「空欄に戻す」でabsent/レコードがクリアされること
    // ================================================================
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await tapCell(page, 3);              // 空セル→○提出
    await tapCell(page, 3);              // 再タップ→モーダル
    await modalSelect(page, '');         // 空欄に戻す
    let raw = await flushAndRead(page);
    let arrClear = JSON.parse(raw || '[]');
    let recClear = arrClear.find(r => r.studentIndex === 3);
    let row3Class = await page.evaluate(() => {
        const row = document.querySelector('#subListWrap .sub-input-row[data-idx="3"]');
        return row ? row.className : null;
    });
    check('追加検証: 空欄に戻す後はレコードが存在しない', !recClear, JSON.stringify(recClear));
    check('追加検証: 空欄に戻す後はabsent/has-statusクラスなし', row3Class !== null && row3Class.trim() === 'sub-input-row', row3Class);

    // ================================================================
    // 追加①: モーダル「⏰提出遅れ」トグル（OFF/ON）
    // ================================================================
    // OFF: 翌日タップ(自動でlate=true)→モーダルでトグルOFF→○再選択→false
    await setup(page, DUE_DATE);
    await setMockDate(page, NEXT_DAY_TS);
    await tapCell(page, 0);   // 空セル→○提出（自動でlateOnDue=true）
    await tapCell(page, 0);   // 再タップ→モーダル（トグル初期値=true想定）
    let toggleInitOff = await getModalLateToggle(page);
    await setModalLateToggle(page, false);
    await modalSelect(page, 'submitted');
    rec = await flushAndGetRec(page, 0);
    check('追加①-OFF: モーダル初期トグル=true(自動判定)', toggleInitOff === true, String(toggleInitOff));
    check('追加①-OFF: トグルOFF→○再選択 lateOnDue=false', rec && rec.lateOnDue === false, JSON.stringify(rec));

    // ON: 翌日タップ(自動でlate=true)→モーダルでトグルONのまま→○再選択→true
    await setup(page, DUE_DATE);
    await setMockDate(page, NEXT_DAY_TS);
    await tapCell(page, 1);
    await tapCell(page, 1);
    let toggleInitOn = await getModalLateToggle(page);
    await modalSelect(page, 'submitted'); // トグルはONのまま
    rec = await flushAndGetRec(page, 1);
    check('追加①-ON: モーダル初期トグル=true(自動判定)', toggleInitOn === true, String(toggleInitOn));
    check('追加①-ON: トグルONのまま○再選択 lateOnDue=true', rec && rec.lateOnDue === true, JSON.stringify(rec));

    // ================================================================
    // 追加②: 欠席の児童に再度「欠」を選択→absent維持
    // ================================================================
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await tapCell(page, 2);            // 空セル→○提出
    await tapCell(page, 2);            // 再タップ→モーダル
    await modalSelect(page, 'absent'); // 欠席化
    await tapCell(page, 2);            // 再タップ→モーダル（curStatus=absent）
    await modalSelect(page, 'absent'); // 再度「欠」を選択
    rec = await flushAndGetRec(page, 2);
    check('追加②: 欠席児童に再度「欠」→absent維持', rec && rec.absent === true && rec.status === 'missing', JSON.stringify(rec));

    // ================================================================
    // 追加③: 締切日に○提出(late=false)→翌日モーダルを開く→トグルOFF初期化
    //         →そのまま△選択→lateOnDue=false維持
    // ================================================================
    await setup(page, DUE_DATE);
    await setMockDate(page, ON_DUE_TS);
    await tapCell(page, 4);   // 当日: 空セル→○提出（lateOnDue=false）
    await setMockDate(page, NEXT_DAY_TS);
    await tapCell(page, 4);   // 翌日: 再タップ→モーダル
    let toggleC = await getModalLateToggle(page);
    await modalSelect(page, 'resubmit'); // トグルに触れず△選択
    rec = await flushAndGetRec(page, 4);
    check('追加③: 締切日○提出後、翌日モーダルのトグル初期値=false（保存済み状態を維持）', toggleC === false, String(toggleC));
    check('追加③: トグルに触れず△選択 lateOnDue=false維持', rec && rec.status === 'resubmit' && rec.lateOnDue === false, JSON.stringify(rec));

    // ================================================================
    // 検証5: 全体フロー再テスト（新タップ体系）
    // ================================================================
    await setup(page, DUE_DATE);
    await setMockDate(page, null);

    // 空セルタップ×3 → ○記録
    await tapCell(page, 0);
    await tapCell(page, 1);
    await tapCell(page, 2);
    let marks = await page.evaluate(() => {
        const get = (i) => document.querySelector('#subContGrid .sub-cont-cell[data-cidx="' + i + '"] .sub-cont-mark').textContent;
        return { c0: get(0), c1: get(1), c2: get(2) };
    });
    check('検証5: 空セルタップ→○記録(0,1,2)', marks.c0 === '○' && marks.c1 === '○' && marks.c2 === '○', JSON.stringify(marks));

    // idx0: 再タップ→モーダル→△
    await tapCell(page, 0);
    await modalSelect(page, 'resubmit');
    // idx1: 再タップ→モーダル→×
    await tapCell(page, 1);
    await modalSelect(page, 'missing');
    // idx2: 再タップ→モーダル→欠
    await tapCell(page, 2);
    await modalSelect(page, 'absent');
    marks = await page.evaluate(() => {
        const get = (i) => document.querySelector('#subContGrid .sub-cont-cell[data-cidx="' + i + '"] .sub-cont-mark').textContent;
        return { c0: get(0), c1: get(1), c2: get(2) };
    });
    check('検証5: モーダル経由で△/×/欠に変更', marks.c0 === '△' && marks.c1 === '×' && marks.c2 === '欠', JSON.stringify(marks));

    // idx0: 再タップ→モーダル→空欄に戻す
    await tapCell(page, 0);
    await modalSelect(page, '');
    let mark0 = await page.evaluate(() => document.querySelector('#subContGrid .sub-cont-cell[data-cidx="0"] .sub-cont-mark').textContent);
    check('検証5: 空欄に戻す→マーク消去', mark0 === '', JSON.stringify(mark0));

    // 進捗カウンタ確認（idx1, idx2が入力済み = 2/38）
    let progress = await page.evaluate(() => document.getElementById('subContProgress').textContent);
    check('検証5: 進捗カウンタ表示', /^\d+ \/ 38$/.test(progress), progress);

    // 残り全員を○で埋めて完了トースト確認
    for (let i = 0; i < 38; i++) {
        const filled = await page.evaluate((idx) => {
            const cell = document.querySelector('#subContGrid .sub-cont-cell[data-cidx="' + idx + '"]');
            return cell.className.indexOf('st-') !== -1;
        }, i);
        if (!filled) await tapCell(page, i);
    }
    await new Promise(r => setTimeout(r, 100));
    let toast = await page.evaluate(() => ({ text: document.getElementById('toast').textContent, cls: document.getElementById('toast').className }));
    check('検証5: 全員入力完了トースト表示', toast.text.indexOf('全員入力完了') >= 0 && toast.text.indexOf('38 / 38') >= 0, JSON.stringify(toast));

    // 表示切替（リスト/座席表/連続入力）の往復
    await page.evaluate(() => document.getElementById('subViewListBtn').click());
    await new Promise(r => setTimeout(r, 100));
    let listDisp = await page.evaluate(() => getComputedStyle(document.getElementById('subListWrap')).display);
    await page.evaluate(() => document.getElementById('subViewSeatBtn').click());
    await new Promise(r => setTimeout(r, 100));
    let seatCells = await page.evaluate(() => document.querySelectorAll('#subSeatGrid .sub-seat-cell').length);
    await page.evaluate(() => document.getElementById('subViewContBtn').click());
    await new Promise(r => setTimeout(r, 100));
    let contDisp = await page.evaluate(() => getComputedStyle(document.getElementById('subContinuousWrap')).display);
    check('検証5: 表示切替（リスト/座席表/連続入力）が正常に動作', listDisp !== 'none' && seatCells > 0 && contDisp !== 'none',
        JSON.stringify({ listDisp, seatCells, contDisp }));

    // コンソールエラーチェック（favicon 404除く）
    const realErrors = consoleErrors.filter(e => e.url.indexOf('favicon') === -1);
    check('検証5: コンソールエラーなし（favicon 404除く）', realErrors.length === 0, JSON.stringify(realErrors));

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
