// H6: 名簿を保存しても、児童オブジェクトの name・gender 以外の全項目(視力・身長・その他)が残ること。
// (DATA_FLOW_AUDIT.md H6。従来は saveMasterRoster が master.students を {name, gender} だけで
//  作り直していたため、名簿を1文字も変えずに保存しても視力・身長が消えていた)
//
// 並べ替え・途中削除への対応は H4(児童ID)で行う。ここでは「添字位置のまま属性を保持」する挙動のみ検証する。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node roster-preserve.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept()); // 並びが変わる保存の確認ダイアログは承認する

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const backup = await page.evaluate(() => StorageManager.getRaw(KEYS.master));

    const SEED = [
        { name: '甲', gender: '男', visionL: 'A', visionR: 'B', height: 131, weight: 28, memo: { a: 1 } },
        { name: '乙', gender: '女', visionL: 'C', visionR: 'D', height: 128 },
        { name: '丙', gender: '男', visionL: 'B', visionR: 'B', height: 135, extraFlag: true }
    ];
    async function seedAndSave(roster) {
        await page.evaluate((seed) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({
                version: 2, students: seed,
                classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' }
            }));
        }, SEED);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        // 名簿欄は保存済みの名簿から自動で埋まる。roster 指定があれば書き換える(実際の保存ボタンと同じ経路)
        await page.evaluate((lines) => {
            showView('settings');
            if (lines) document.getElementById('masterRoster').value = lines.join('\n');
            saveMasterRoster();
            flushSaveQueue && flushSaveQueue();
        }, roster || null);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        // v1.51.0: 児童ID(studentId)は起動時に自動付与される。属性の保持を比較する対象は studentId 以外の全項目。
        return page.evaluate(() => JSON.parse(StorageManager.getRaw(KEYS.master)).students.map(s => { const c = Object.assign({}, s); delete c.studentId; return c; }));
    }

    try {
        // (1) 名簿を変更せずに保存 → 全項目が残る
        let st = await seedAndSave(null);
        check('変更なしで保存: 全児童の全項目が保存前と一致', JSON.stringify(st) === JSON.stringify(SEED), JSON.stringify(st));
        check('変更なしで保存: 視力・身長が残る', st.length === 3 && st[0].visionL === 'A' && st[0].visionR === 'B' && st[0].height === 131 && st[1].height === 128, JSON.stringify(st.map(s => [s.visionL, s.visionR, s.height])));
        check('変更なしで保存: その他の項目(weight/memo/extraFlag)も残る', st[0].weight === 28 && st[0].memo && st[0].memo.a === 1 && st[2].extraFlag === true, JSON.stringify(st[0]) + ' / ' + JSON.stringify(st[2]));

        // (2) 同じ位置の誤字修正(改名) → 名前だけ更新され、属性は残る
        st = await seedAndSave(['甲,男', '乙乙,女', '丙,男']);
        check('同位置の改名: name が更新される', st[1].name === '乙乙', st[1].name);
        check('同位置の改名: 視力・身長は残る', st[1].visionL === 'C' && st[1].visionR === 'D' && st[1].height === 128, JSON.stringify(st[1]));

        // (3) 性別の修正 → gender が更新され、属性は残る
        st = await seedAndSave(['甲,女', '乙,女', '丙,男']);
        check('性別の修正: gender が更新される', st[0].gender === '女', st[0].gender);
        check('性別の修正: 視力・身長は残る', st[0].visionL === 'A' && st[0].height === 131, JSON.stringify(st[0]));

        // (4) 末尾に転入生を追加 → 既存児童の属性は残り、新児童は name/gender のみ
        st = await seedAndSave(['甲,男', '乙,女', '丙,男', '丁,女']);
        check('末尾追加: 既存3名の属性は残る', st.length === 4 && st[0].height === 131 && st[1].visionL === 'C' && st[2].extraFlag === true, JSON.stringify(st));
        check('末尾追加: 新しい児童は name/gender のみ', JSON.stringify(st[3]) === JSON.stringify({ name: '丁', gender: '女' }), JSON.stringify(st[3]));

        // (5) 性別を空にしても gender は '' で保存される(従来動作を維持)
        st = await seedAndSave(['甲', '乙,女', '丙,男']);
        check('性別を空にした行: gender は空文字(従来動作)', st[0].gender === '' && st[0].height === 131, JSON.stringify(st[0]));
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        await page.evaluate((b) => { if (b === null) StorageManager.remove(KEYS.master); else StorageManager.setImmediate(KEYS.master, b); }, backup);
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== roster-preserve: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
