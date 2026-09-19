// H6: 名簿を保存しても、児童オブジェクトの name・gender 以外の全項目(視力・身長・その他)が残ること。
// (DATA_FLOW_AUDIT.md H6。従来は saveMasterRoster が master.students を {name, gender} だけで作り直していたため、
//  名簿を1文字も変えずに保存しても視力・身長が消えていた)
//
// v1.52.0(H4 段階3)で名簿編集はリスト編集UIに変わった。ここでは実際の画面操作(タップ・入力)で、
// 改名・性別の修正・末尾への転入を保存しても属性が残ること、名簿を変えずに保存しても何も変わらないことを検証する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node roster-preserve.test.js

const puppeteer = require('puppeteer-core');
const ui = require('./helpers/roster-ui');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = ui.sleep;

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    let dialogs = 0;
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => { dialogs++; d.accept(); });

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const backup = await page.evaluate(() => StorageManager.getRaw(KEYS.master));

    const SEED = [
        { name: '甲', gender: '男', visionL: 'A', visionR: 'B', height: 131, weight: 28, memo: { a: 1 }, studentId: 'stu_seed0001' },
        { name: '乙', gender: '女', visionL: 'C', visionR: 'D', height: 128, studentId: 'stu_seed0002' },
        { name: '丙', gender: '男', visionL: 'B', visionR: 'B', height: 135, extraFlag: true, studentId: 'stu_seed0003' }
    ];
    const strip = (s) => { const c = Object.assign({}, s); delete c.studentId; return c; };
    async function open() {
        await page.evaluate((seed) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                version: 2, students: seed,
                classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' }
            }));
        }, SEED);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await ui.openSettings(page);
    }
    const stored = () => page.evaluate(() => JSON.parse(StorageManager.getRaw(KEYS.master)).students);

    try {
        // (1) 名簿を変更せずに保存 → 何も変わらない(再読み込みもしない)
        await open();
        await page.evaluate(() => { window.__noReload = 1; });
        const before = await stored();
        await ui.clickSave(page);
        check('変更なしで保存: 「変更はありません」と通知され、再読み込みされない', await ui.toastHas(page, '変更はありません') && await page.evaluate(() => window.__noReload === 1), '');
        let st = await stored();
        check('変更なしで保存: 全児童の全項目(視力・身長・weight・memo・extraFlag・studentId)が1バイトも変わらない', JSON.stringify(st) === JSON.stringify(before) && JSON.stringify(st) === JSON.stringify(SEED), JSON.stringify(st.map(strip)));

        // (2) 同じ位置の改名 → 名前だけ更新され、属性は残る
        await open();
        await ui.setName(page, 1, '乙乙');
        await ui.clickSave(page); await ui.waitReload(page);
        st = await stored();
        check('同位置の改名: name が更新され、視力・身長・他の項目は残る', st[1].name === '乙乙' && st[1].visionL === 'C' && st[1].visionR === 'D' && st[1].height === 128 && st[0].height === 131 && st[0].memo && st[0].memo.a === 1 && st[2].extraFlag === true, JSON.stringify(st[1]));
        check('同位置の改名: 児童IDは変わらない', st.every((s, i) => s.studentId === SEED[i].studentId), JSON.stringify(st.map(s => s.studentId)));

        // (3) 性別の修正 → gender が更新され、属性は残る
        await open();
        await ui.setGender(page, 0, '女');
        await ui.clickSave(page); await ui.waitReload(page);
        st = await stored();
        check('性別の修正: gender が更新され、視力・身長は残る', st[0].gender === '女' && st[0].visionL === 'A' && st[0].height === 131 && st[0].weight === 28, JSON.stringify(st[0]));

        // (4) 末尾に転入生を追加(最後の行の「＋」) → 既存児童の属性は残り、新児童は name/gender/studentId のみ
        await open();
        await ui.act(page, 'insert', 2);
        await ui.setName(page, 3, '丁');
        await ui.setGender(page, 3, '女');
        await ui.clickSave(page); await ui.waitReload(page);
        st = await stored();
        check('末尾追加: 既存3名の属性は残る', st.length === 4 && st[0].height === 131 && st[1].visionL === 'C' && st[2].extraFlag === true, JSON.stringify(st.map(strip)));
        check('末尾追加: 新しい児童は name/gender と自動付与の studentId だけ', JSON.stringify(Object.keys(st[3]).sort()) === JSON.stringify(['gender', 'name', 'studentId']) && st[3].name === '丁' && st[3].gender === '女' && /^stu_[a-z0-9]{8}$/.test(st[3].studentId), JSON.stringify(st[3]));

        // (5) 性別を「—」(空)にしても gender は '' で保存され、属性は残る
        await open();
        await ui.setGender(page, 0, '');
        await ui.clickSave(page); await ui.waitReload(page);
        st = await stored();
        check('性別を空にした行: gender は空文字で保存され、属性は残る', st[0].gender === '' && st[0].height === 131 && st[0].memo && st[0].memo.a === 1, JSON.stringify(st[0]));
        check('確認ダイアログは一度も使われない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        await page.evaluate((b) => { if (b === null) StorageManager.remove(KEYS.master); else StorageManager.setImmediate(KEYS.master, b); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== roster-preserve: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
