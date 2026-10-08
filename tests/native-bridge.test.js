// v1.65.0: iPad アプリ版(Kizashi・WKWebView で包んだ別リポジトリのアプリ)の中での動き。
//   Kizashi は window.webkit.messageHandlers.kizashi(返事つき)と window.kizashiApp(版の情報)を用意する。
//   このテストでは、それを偽物で用意して、Kizashi の中と同じ条件を作る。
//   A. Web版(偽物なし): ネイティブと判定しない・Service Worker を登録する・版は sw.js から(今までどおり)
//   B. Kizashi の中: Service Worker を登録しない・版はアプリの情報から・出力(バックアップ・暗号化・PDF)は
//      ネイティブへ渡す(共有/キャンセル/失敗の通知)・PDF の「全ページを見る」はプレビューへ
//   C. バックアップの往復: Kizashi の中で書き出したファイルを、Web版の画面(ファイル選択 → 復元)で復元できる。
//      Web版で書き出したファイルを、Kizashi の中の画面で復元できる(どちらも中身が一致する)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node native-bridge.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$|spa_backup_meta$|spa_undo_|spa_roster_snapshot|spa_roster_txn)/;
const KZ_INFO = { appVersion: '1.0.0', appBuild: '1', webVersion: 'v9.99.9', webCommit: 'abc1234' };
const swVersion = (fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8').match(/CACHE_VERSION\s*=\s*'([^']+)'/) || [])[1];

// Kizashi の中と同じ条件: 返事つきの messageHandlers.kizashi と版の情報。送られた内容は __kzMsgs に残す。
function installFakeNative(info) {
    window.__kzMsgs = [];
    window.__kzReply = { ok: true, completed: true };
    window.webkit = { messageHandlers: { kizashi: { postMessage: function(m) {
        window.__kzMsgs.push(m);
        if (window.__kzReply === 'reject') return Promise.reject(new Error('native failed'));
        return Promise.resolve(window.__kzReply);
    } } } };
    window.kizashiApp = info;
}

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-bridge-'));
    const consoleErrors = [];
    async function openPage(native) {
        const ctx = await browser.createBrowserContext(); // 別の保存領域(Service Worker・localStorage を分ける)
        const page = await ctx.newPage();
        if (native) await page.evaluateOnNewDocument(installFakeNative, KZ_INFO);
        await page.evaluateOnNewDocument(() => { window.__spaSkipPfMigration = true; });
        page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; const t = msg.text(); if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push((native ? '[native] ' : '[web] ') + t); } });
        page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
        page.on('dialog', d => d.accept());
        await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
        await sleep(800);
        return { ctx, page };
    }
    const toastHas = (page, t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 3000, polling: 50 }, t).then(() => true).catch(() => false);
    const waitToastGone = (page) => page.waitForFunction(() => { const b = document.getElementById('toast'); return !b || !b.classList.contains('show'); }, { timeout: 8000, polling: 100 }).catch(() => {});
    const dumpApp = (page) => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (a, b) => Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).filter(k => !NOISE.test(k) && a[k] !== b[k]);
    async function seed(page, tag) {
        await page.evaluate((tag) => {
            const students = [1, 2, 3].map(i => ({ name: '児童' + tag + i, kana: 'じどう' + i, gender: i % 2 ? 'M' : 'F', studentId: 'stu_' + tag + '_' + i }));
            storageVerifiedWrite(KEYS.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 2, teacher: '先生' + tag, termSystem: 3, term2Start: '09-01', term3Start: '01-01' }, students: students, lastSync: '2026-10-01T00:00:00.000Z' }));
            storageVerifiedWrite(KEYS.tests, JSON.stringify([{ id: 1, subject: '算数', name: '小テスト' + tag, category: '知識・技能', maxScore: 100, date: '2026-10-01', term: '2' }]));
            storageVerifiedWrite(KEYS.forgotten_items, JSON.stringify(['ハンカチ' + tag, 'ノート"引用"\\改行\n']));
            localStorage.setItem('pf_setting', JSON.stringify({ year: 2026, className: '5年2組' + tag }));
            masterLoadFailed = false; loadMaster();
        }, tag);
    }
    async function openBackupModalAndWait(page) {
        await page.evaluate(() => openBackupModal());
        await sleep(200);
    }
    async function restoreViaUi(page, file, password) {
        await openBackupModalAndWait(page);
        const input = await page.$('#restoreFile');
        await input.uploadFile(file);
        await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#backupModal button')).find(x => x.textContent.indexOf('バックアップから復元') !== -1); b.click(); });
        if (password) {
            await page.waitForFunction(() => document.getElementById('dec-password-area').style.display === 'block', { timeout: 3000 });
            await page.evaluate((p) => { document.getElementById('dec-pass').value = p; }, password);
            await page.click('#btn-dec-confirm');
        }
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
        await sleep(1500);
    }

    // ================= A. Web版(今までどおり) =================
    const web = await openPage(false);
    check('A1 Web版ではネイティブと判定しない', await web.page.evaluate(() => typeof kzIsNative === 'function' && kzIsNative() === false));
    const webSw = await web.page.evaluate(async () => { for (let i = 0; i < 30; i++) { const r = await navigator.serviceWorker.getRegistration(); if (r && r.active) return true; await new Promise(r => setTimeout(r, 200)); } return false; });
    check('A2 Web版は Service Worker を登録する', webSw);
    await web.page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
    const webVer = await web.page.$eval('#ver-disp', el => el.textContent).catch(() => '');
    check('A3 Web版の版表示は sw.js の CACHE_VERSION(Kizashi の表記なし)', webVer === swVersion, webVer + ' / ' + swVersion);
    check('A4 Web版には版の情報(kizashiApp)が無い', await web.page.evaluate(() => typeof window.kizashiApp === 'undefined'));

    // ================= B. Kizashi の中 =================
    const nat = await openPage(true);
    const np = nat.page;
    check('B1 Kizashi の中ではネイティブと判定する', await np.evaluate(() => typeof kzIsNative === 'function' && kzIsNative() === true));
    await sleep(1500);
    const natSw = await np.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
    check('B2 Kizashi の中では Service Worker を登録しない', natSw === false);
    const natVer = await np.$eval('#ver-disp', el => el.textContent).catch(() => '');
    check('B3 版表示はアプリの情報(Web の版・Kizashi の版・コミット)', natVer.indexOf('v9.99.9') !== -1 && natVer.indexOf('Kizashi 1.0.0') !== -1 && natVer.indexOf('abc1234') !== -1, natVer);

    // B4 バックアップ(JSON)の保存ボタン → ネイティブの共有シートへ
    await seed(np, 'N');
    await openBackupModalAndWait(np);
    await np.evaluate(() => { const b = Array.from(document.querySelectorAll('#backupModal button')).find(x => x.textContent.indexOf('全データを保存') !== -1); b.click(); });
    await np.waitForFunction(() => window.__kzMsgs.length >= 1, { timeout: 5000 }).catch(() => {});
    const m1 = await np.evaluate(() => window.__kzMsgs[0] || null);
    check('B4a バックアップの保存はネイティブへ action=share で渡す', !!m1 && m1.action === 'share', m1 && m1.action);
    check('B4b ファイル名・種類は Web版と同じ', !!m1 && /^classroom_backup_\d{4}\.json$/.test(m1.fileName) && m1.mimeType === 'application/json', m1 && (m1.fileName + ' ' + m1.mimeType));
    const natJsonText = m1 ? Buffer.from(m1.base64, 'base64').toString('utf8') : '';
    const natExpected = await np.evaluate(() => JSON.stringify(window.buildBackupObject(), null, 2));
    // 書き出しの日時と、書き出したあとに更新される最終バックアップ日時(spa_backup_meta)は比べない
    const stripDates = (s) => { try { const o = JSON.parse(s); delete o.exportDate; delete o.exportDateLocal; [o.data, o.rawLocalStorage].forEach(l => { if (l) delete l.spa_backup_meta; }); return JSON.stringify(o); } catch (e) { return 'X'; } };
    check('B4c 渡した中身は Web版の書き出しと同じ JSON(base64 で欠けない・日本語や改行も同じ)', stripDates(natJsonText) === stripDates(natExpected) && natJsonText.indexOf('ハンカチN') !== -1);
    check('B4d 共有の完了を通知する', await toastHas(np, '共有シートを開きました'));
    const meta1 = await np.evaluate(() => StorageManager.get(KEYS.backup_meta, null));
    check('B4e 最終バックアップ日時を記録する(Web版と同じ)', !!meta1 && !!meta1.lastExportAt && (Date.now() - new Date(meta1.lastExportAt).getTime()) < 60000);
    const natBackupFile = path.join(tmp, 'native-export.json');
    fs.writeFileSync(natBackupFile, Buffer.from(m1 ? m1.base64 : '', 'base64'));

    // B5 キャンセル / B6 失敗
    await waitToastGone(np);
    const r5 = await np.evaluate(async () => { window.__kzReply = { ok: true, completed: false }; return await universalShare(new Blob(['a,b'], { type: 'text/csv' }), 'x.csv'); });
    check('B5 共有シートを閉じたときは「キャンセル」を通知する(戻り値は Web版と同じ true)', r5 === true && await toastHas(np, 'キャンセル'));
    await waitToastGone(np);
    const r6 = await np.evaluate(async () => { window.__kzReply = 'reject'; return await universalShare(new Blob(['a,b'], { type: 'text/csv' }), 'x.csv'); });
    check('B6 ネイティブで失敗したときは失敗を通知して false', r6 === false && await toastHas(np, '失敗'));
    await waitToastGone(np);
    const r6b = await np.evaluate(async () => { window.__kzReply = { ok: false, error: 'disk full' }; return await universalShare(new Blob(['a'], { type: 'text/plain' }), 'x.txt'); });
    check('B6b ネイティブが ok:false を返したときも失敗を通知して false', r6b === false && await toastHas(np, 'disk full'));
    await np.evaluate(() => { window.__kzReply = { ok: true, completed: true }; window.__kzMsgs = []; });

    // B7 暗号化バックアップ
    await waitToastGone(np);
    await openBackupModalAndWait(np);
    await np.click('#btn-enc-export');
    await np.evaluate(() => { document.getElementById('enc-pass1').value = 'pass1234'; document.getElementById('enc-pass2').value = 'pass1234'; });
    await np.click('#btn-enc-confirm');
    await np.waitForFunction(() => window.__kzMsgs.length >= 1, { timeout: 8000 }).catch(() => {});
    const m7 = await np.evaluate(() => window.__kzMsgs[0] || null);
    check('B7a 暗号化バックアップもネイティブへ(.enc)', !!m7 && m7.action === 'share' && /\.enc$/.test(m7.fileName), m7 && m7.fileName);
    const encFile = path.join(tmp, 'native-export.enc');
    fs.writeFileSync(encFile, Buffer.from(m7 ? m7.base64 : '', 'base64'));
    const encDecrypted = m7 ? await np.evaluate(async (b64) => { const text = atob(b64); return await decryptData(text, 'pass1234'); }, m7.base64).catch(e => 'ERR ' + e.message) : '';
    check('B7b 暗号化バックアップは同じパスワードで元の JSON に戻る', stripDates(encDecrypted) === stripDates(natExpected));

    // B8 PDF: 結果ダイアログの「全ページを見る」→ プレビュー、「保存 / 共有」→ 共有シート
    await np.evaluate(() => { window.__kzMsgs = []; window.__pdfDone = htmlPagesToPdf(['<div style="width:794px;height:400px;font-size:30px;">ページ1</div>', '<div style="width:794px;height:400px;">ページ2</div>'], { fileName: 'テスト出力.pdf' }); });
    await np.waitForSelector('#pdfResOpenBtn', { timeout: 20000 }).catch(() => {});
    const openLabel = await np.$eval('#pdfResOpenBtn', el => el.textContent).catch(() => '');
    check('B8a Kizashi の中では「別のタブで開く」を「全ページを見る」にする', openLabel.indexOf('全ページを見る') !== -1, openLabel);
    await np.click('#pdfResOpenBtn').catch(() => {});
    await np.waitForFunction(() => window.__kzMsgs.length >= 1, { timeout: 5000 }).catch(() => {});
    const m8 = await np.evaluate(() => window.__kzMsgs[0] || null);
    check('B8b 「全ページを見る」はネイティブのプレビューへ(PDF の中身)', !!m8 && m8.action === 'preview' && m8.mimeType === 'application/pdf' && m8.fileName === 'テスト出力.pdf' && Buffer.from(m8.base64, 'base64').slice(0, 5).toString() === '%PDF-', m8 && (m8.action + ' ' + m8.fileName));
    check('B8c プレビューのあとも結果ダイアログは開いたまま', await np.evaluate(() => !!document.getElementById('pdfResultOverlay')));
    await np.click('#pdfResShareBtn').catch(() => {});
    await np.waitForFunction(() => window.__kzMsgs.length >= 2, { timeout: 5000 }).catch(() => {});
    const m8s = await np.evaluate(() => window.__kzMsgs[1] || null);
    check('B8d 「保存 / 共有」はネイティブの共有シートへ', !!m8s && m8s.action === 'share' && m8s.fileName === 'テスト出力.pdf' && Buffer.from(m8s.base64, 'base64').slice(0, 5).toString() === '%PDF-');
    check('B8e PDF の処理が完了する', await np.evaluate(() => window.__pdfDone.then(v => v === true)));

    // ================= C. バックアップの往復 =================
    // C1 Kizashi で書き出したファイル → Web版の画面で復元
    const natState = await dumpApp(np);
    await seed(web.page, 'W');
    await restoreViaUi(web.page, natBackupFile);
    const webAfter = await dumpApp(web.page);
    const d1 = diffKeys(natState, webAfter);
    check('C1 Kizashi で書き出したバックアップを Web版で復元すると、Kizashi と同じデータになる', d1.length === 0 && webAfter[await web.page.evaluate(() => KEYS.master)].indexOf('児童N1') !== -1, d1.slice(0, 5).join(','));
    check('C1b 復元の取り消し点(自動退避)が作られている', await web.page.evaluate(() => { const s = srUndoStatus(srSlotForKind('backup-restore').id); return !!s && s.available === true; }));

    // C2 Web版で書き出したファイル → Kizashi の画面で復元(Web版の書き出しは Kizashi の偽物の外で作る)
    await seed(web.page, 'X');
    const webJson = await web.page.evaluate(() => JSON.stringify(window.buildBackupObject(), null, 2));
    const webFile = path.join(tmp, 'web-export.json');
    fs.writeFileSync(webFile, webJson);
    const webState = await dumpApp(web.page);
    await restoreViaUi(np, webFile);
    const natAfter = await dumpApp(np);
    const d2 = diffKeys(webState, natAfter);
    check('C2 Web版で書き出したバックアップを Kizashi で復元すると、Web版と同じデータになる', d2.length === 0 && natAfter[await np.evaluate(() => KEYS.master)].indexOf('児童X1') !== -1, d2.slice(0, 5).join(','));
    check('C2b Kizashi でも復元の取り消し点(自動退避)が作られている', await np.evaluate(() => { const s = srUndoStatus(srSlotForKind('backup-restore').id); return !!s && s.available === true; }));

    // C3 Kizashi の暗号化バックアップ → Web版でパスワードを入れて復元
    await seed(web.page, 'Y');
    await restoreViaUi(web.page, encFile, 'pass1234');
    const webAfterEnc = await dumpApp(web.page);
    const d3 = diffKeys(natState, webAfterEnc);
    check('C3 Kizashi の暗号化バックアップを Web版で復元できる', d3.length === 0, d3.slice(0, 5).join(','));

    check('Z コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    const pass = results.filter(r => r.pass).length, fail = results.length - pass;
    console.log('\n=== native-bridge: ' + pass + ' passed, ' + fail + ' failed ===');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
