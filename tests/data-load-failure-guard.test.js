// loadMaster()/pf_loadAll() の読み込み失敗握りつぶし対策(v1.24.0想定)の機械検証。
//
// 修正前は、spa_master(名簿)やpf_records_年度(体力テスト記録)のJSONが壊れていても
// console.errorのみで教員には無通知のまま起動が続き、その後の保存操作(saveMaster/
// pf_saveAll)で壊れたデータの上に空データが上書き保存され、復旧不能になっていた。
//
// この修正で以下の2点を保証する:
//   ① 読み込み失敗時にrecoveryBar/トーストで教員に通知する
//   ② その後の保存操作を止め、localStorage内の壊れた生データを上書きしない
// ②が本命。①が出ても②が効いていなければ、次に保存ボタンを押した瞬間に
// 壊れたバックアップが完全に失われる(復旧の可能性が消える)ため。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node data-load-failure-guard.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 900 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        const text = msg.text();
        // loadMaster()/pf_loadAll()のcatch内console.error()は、このテストが
        // 意図的に発生させている読み込みエラーのログなので対象外とする。
        if (text.indexOf('master load error') !== -1) return;
        if (text.indexOf('SyntaxError') !== -1 && text.indexOf('JSON') !== -1) return;
        consoleErrors.push(text + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });

    async function getRawLS(k) { return page.evaluate((kk) => localStorage.getItem(kk), k); }
    async function restoreRawLS(k, raw) {
        if (raw === null || raw === undefined) {
            await page.evaluate((kk) => { localStorage.removeItem(kk); }, k);
        } else {
            await page.evaluate((kk, vv) => { StorageManager.setImmediate(kk, vv); }, k, raw);
        }
    }

    // ================================================================
    // 1. loadMaster() / saveMaster(): 壊れた名簿JSONを守れているか
    // ================================================================
    const masterKey = await page.evaluate(() => KEYS.master);
    const masterBackup = await getRawLS(masterKey);

    try {
        const CORRUPT_MASTER = '{ "students": [ this is not valid json !!!';

        const r1 = await page.evaluate((kk, corrupt) => {
            StorageManager.setImmediate(kk, corrupt);
            loadMaster();
            var bar = document.getElementById('recoveryBar');
            return {
                masterLoadFailed: masterLoadFailed,
                barVisible: bar ? (bar.style.display === 'block') : null,
                barText: bar ? bar.textContent : null,
                studentsIsArray: Array.isArray(master.students)
            };
        }, masterKey, CORRUPT_MASTER);

        check('【名簿】① loadMaster(): 壊れたJSONを読んでもmasterLoadFailedフラグが立つ',
            r1.masterLoadFailed === true, JSON.stringify(r1));
        check('【名簿】① loadMaster(): recoveryBarが表示され「読み込みに失敗」の警告文が出る(教員が気づける)',
            r1.barVisible === true && /読み込みに失敗/.test(r1.barText || ''), JSON.stringify(r1));
        check('(前提確認) 壊れたJSONを読んだ後もmaster.studentsは配列のまま(既存の正規化ガード自体は健在)',
            r1.studentsIsArray === true, JSON.stringify(r1));

        const rawBeforeSave = await getRawLS(masterKey);
        const r2 = await page.evaluate(() => {
            saveMaster();
            var el = document.getElementById('toastMsg');
            return { toastMsg: el ? el.textContent : null };
        });
        const rawAfterSave = await getRawLS(masterKey);

        check('【名簿】②(本命) saveMaster()を呼んでもlocalStorage内の壊れた生データが1バイトも変化しない(上書き防止)',
            rawAfterSave === CORRUPT_MASTER && rawAfterSave === rawBeforeSave,
            JSON.stringify({ rawBeforeSave, rawAfterSave, expected: CORRUPT_MASTER }));
        check('【名簿】② saveMaster()は「保存を中止した」ことをトーストで教員に伝える',
            /保存を中止/.test(r2.toastMsg || ''), JSON.stringify(r2));

    } finally {
        await restoreRawLS(masterKey, masterBackup);
        await page.evaluate(() => { masterLoadFailed = false; });
    }

    // ================================================================
    // 2. pf_loadAll() / pf_saveAll(): 壊れた体力テスト記録JSONを守れているか
    // ================================================================
    const pfRecordsKey = await page.evaluate(() => pf_storageKey());
    const pfRosterKey = await page.evaluate(() => pf_rosterKey());
    const pfRecordsBackup = await getRawLS(pfRecordsKey);
    const pfRosterBackup = await getRawLS(pfRosterKey);

    try {
        const CORRUPT_PF = '{ "1": { broken json here';

        const r3 = await page.evaluate((kk, corrupt) => {
            localStorage.setItem(kk, corrupt);
            pf_loadFailed = false;
            pf_loadAll();
            return { pf_loadFailed: pf_loadFailed };
        }, pfRecordsKey, CORRUPT_PF);

        check('【体力テスト】① pf_loadAll(): 壊れたJSONを読んでもpf_loadFailedフラグが立つ',
            r3.pf_loadFailed === true, JSON.stringify(r3));

        const toastAfterLoad = await page.evaluate(() => {
            var el = document.getElementById('toastMsg');
            return el ? el.textContent : null;
        });
        check('【体力テスト】① pf_loadAll(): 読み込み失敗をトーストで教員に伝える',
            /読み込みに失敗/.test(toastAfterLoad || ''), JSON.stringify({ toastAfterLoad }));

        const rawBeforeSave = await getRawLS(pfRecordsKey);
        const r4 = await page.evaluate(() => {
            pf_saveAll();
            var el = document.getElementById('toastMsg');
            return { toastMsg: el ? el.textContent : null };
        });
        const rawAfterSave = await getRawLS(pfRecordsKey);

        check('【体力テスト】②(本命) pf_saveAll()を呼んでもlocalStorage内の壊れた生データが1バイトも変化しない(上書き防止)',
            rawAfterSave === CORRUPT_PF && rawAfterSave === rawBeforeSave,
            JSON.stringify({ rawBeforeSave, rawAfterSave, expected: CORRUPT_PF }));
        check('【体力テスト】② pf_saveAll()は「保存を中止した」ことをトーストで教員に伝える',
            /保存を中止/.test(r4.toastMsg || ''), JSON.stringify(r4));

    } finally {
        await restoreRawLS(pfRecordsKey, pfRecordsBackup);
        await restoreRawLS(pfRosterKey, pfRosterBackup);
        await page.evaluate(() => { pf_loadFailed = false; });
    }

    check('検証中にコンソールエラーなし(このテストが意図的に発生させた読み込みエラーを除く)',
        consoleErrors.length === 0, JSON.stringify(consoleErrors));

    await browser.close();

    const fail = results.filter(function(r) { return !r.pass; });
    console.log('\n合計: ' + results.length + '件 / 成功: ' + (results.length - fail.length) + '件 / 失敗: ' + fail.length + '件');
    if (fail.length > 0) process.exit(1);
})();
