// v1.19.0 出席集計一本化・段階0: 統合前後で数値が変わらないことを確認するためのスナップショット取得
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node attendance-snapshot.js [出力先パス] [--update]
//   引数なし: 既存の attendance-snapshot.json（省略時）と4経路を比較し、PASS/FAILのみ出力する。
//             一致してもファイルは書き換えない（capturedAtも変化しない）。
//   --update: 比較結果によらず基準ファイルを上書きする。既存の _note キーは保持される。
//             基準ファイルが存在しない場合は --update の有無によらず初回取得として書き出す。
//
// 何を記録するか（出欠に関わる4経路）:
//   1. 画面（👤カルテ「見る」サマリータブ）: #karteSummaryContent の innerHTML
//   2. 出力センター・子ども向けPDF: kvBuildChildPage が生成するHTML（htmlPagesToPdf差し替えで横取り）
//   3. 出力センター・先生用PDF: kvBuildTeacherPage が生成するHTML（同上）
//   4. 一括PDF（出席簿画面の「一括PDF出力」）: printAllKarte('attendance') が生成するHTML（同上）
//
// 固定データは10種類の出欠ステータス（○×／チソチソ忌停休校）を月をまたいで1件ずつ配置する。
// ロジック切り出しはせず、index.htmlを実際にブラウザで動かして値を取得する（tests/README.mdの方針に準拠）。
//
// ── このスナップショットの位置づけ（段階0完了時点の注記） ──────────
// ・tests/attendance-snapshot.json は「段階0時点＝統合前の現行挙動」を固定したもの。
// ・段階1（kvBuildChildPage/kvBuildTeacherPageをcalcAttendanceStatsの新プロパティに置換）
//   では数値が変わらない想定のため、この基準と一致することが正常。
// ・段階2（renderKarteSummaryを置換）ではtotal・rateが新定義（忌停・休校を分母から除外）
//   により変わるため、この基準との不一致が正常。この時点で --update を付けて再実行し、
//   tests/attendance-snapshot.json の基準を更新すること。
// ・更新を忘れると、正しい変更が「不一致」として検出され続ける点に注意。

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

// 引数解析: --update フラグと、任意の出力先パス上書きを分離する
const rawArgs = process.argv.slice(2);
const shouldUpdate = rawArgs.indexOf('--update') >= 0;
const pathArg = rawArgs.filter(function(a) { return a !== '--update'; })[0];
const outPath = pathArg || path.join(__dirname, 'attendance-snapshot.json');

// 比較・保存の対象とする4経路（出欠に関わるキーのみ。consoleErrors/capturedAt/_noteは比較対象外）
const SNAPSHOT_KEYS = ['screenSummaryHtml', 'kvChildPageHtml', 'kvTeacherPageHtml', 'printAllKarteAttendanceHtml'];

// 2つの文字列が最初に異なる位置を返す（一致なら-1）
function firstDiffIndex(a, b) {
    var len = Math.min(a.length, b.length);
    for (var i = 0; i < len; i++) {
        if (a[i] !== b[i]) return i;
    }
    return a.length === b.length ? -1 : len;
}

const masterData = {
    students: [{ name: 'スナップショット太郎' }],
    classInfo: { year: 2026, grade: 3, class: 1, teacher: 'スナップ教員' }
};

// 10種のステータスを月をまたいで1件ずつ配置
const attData = {
    '2026-04-06': { '0': '○' },
    '2026-04-07': { '0': '×' },
    '2026-04-08': { '0': '／' },
    '2026-04-09': { '0': 'チ' },
    '2026-04-10': { '0': 'ソ' },
    '2026-05-11': { '0': 'チソ' },
    '2026-05-12': { '0': '忌' },
    '2026-05-13': { '0': '停' },
    '2026-05-14': { '0': '休' },
    '2026-05-15': { '0': '校' }
};

async function main() {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    await page.evaluate((m, a) => {
        StorageManager.setImmediate('spa_master', JSON.stringify(m));
        StorageManager.setImmediate('spa_attendance', JSON.stringify(a));
    }, masterData, attData);
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    const snapshot = {};

    // ── 1. 画面（見るモード・サマリータブ） ──────────────────
    snapshot.screenSummaryHtml = await page.evaluate(() => {
        showView('karte');
        kvSetMode('view');
        selectKarteStudent(0);
        var el = document.getElementById('karteSummaryContent');
        return el ? el.innerHTML : null;
    });

    // ── 2・3. 出力センター（子ども向け／先生用PDF） ──────────────
    async function captureKvPrint(designValue) {
        return await page.evaluate((design) => {
            return new Promise((resolve) => {
                showView('karte');
                kvSetMode('output'); // karteViewInit() が走り、kvPrintBtn等が初期化される
                // 対象児童を1名だけ選択
                document.querySelectorAll('.kv-student-chk').forEach(function(c) { c.checked = (c.value === '0'); });
                // セクションは出欠のみON（他は未設定データのため影響なし）
                ['kvSec_grades','kvSec_life','kvSec_parent','kvSec_health','kvSec_learning','kvSec_kanji','kvSec_forgotten'].forEach(function(id) {
                    var el = document.getElementById(id); if (el) el.checked = false;
                });
                var attCk = document.getElementById('kvSec_attendance'); if (attCk) attCk.checked = true;
                // デザイン選択
                document.querySelectorAll('input[name="kvDesign"]').forEach(function(r) { r.checked = (r.value === design); });

                window.__kvCaptured = null;
                window.htmlPagesToPdf = function(pageHtmls) {
                    window.__kvCaptured = pageHtmls[0];
                    return Promise.resolve(true);
                };
                kvPrint();
                setTimeout(function() { resolve(window.__kvCaptured); }, 200);
            });
        }, designValue);
    }

    snapshot.kvChildPageHtml = await captureKvPrint('child');
    snapshot.kvTeacherPageHtml = await captureKvPrint('teacher');

    // ── 4. 一括PDF（printAllKarte） ─────────────────────
    snapshot.printAllKarteAttendanceHtml = await page.evaluate(() => {
        return new Promise((resolve) => {
            window.__pakCaptured = null;
            window.htmlPagesToPdf = function(pageHtmls) {
                window.__pakCaptured = pageHtmls[0];
                return Promise.resolve(true);
            };
            printAllKarte('attendance');
            setTimeout(function() { resolve(window.__pakCaptured); }, 200);
        });
    });

    snapshot.consoleErrors = consoleErrors;

    const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;

    // 基準ファイルが無い場合は --update の指定に関わらず初回取得として書き出す
    if (!existing) {
        snapshot.capturedAt = new Date().toISOString();
        fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
        console.log('基準ファイルが存在しなかったため、初回取得として書き出しました: ' + outPath);
        SNAPSHOT_KEYS.forEach(function(k) {
            console.log('  ' + k + ': ' + (snapshot[k] ? snapshot[k].length + '文字' : '(取得失敗)'));
        });
        if (consoleErrors.length) console.log('consoleErrors:', consoleErrors);
        await browser.close();
        return;
    }

    const mismatches = SNAPSHOT_KEYS.filter(function(k) { return existing[k] !== snapshot[k]; });

    if (!shouldUpdate) {
        if (mismatches.length === 0) {
            console.log('PASS: 4経路とも基準と一致しました（' + outPath + '）。ファイルは書き換えていません。');
        } else {
            console.log('FAIL: ' + mismatches.length + '経路が基準と不一致です（' + outPath + '）。ファイルは書き換えていません。');
            mismatches.forEach(function(k) {
                var a = existing[k] || '';
                var b = snapshot[k] || '';
                var diffAt = firstDiffIndex(a, b);
                console.log('  --- ' + k + ' ---');
                console.log('    基準の文字数: ' + a.length + ' / 今回取得の文字数: ' + b.length);
                if (diffAt >= 0) {
                    console.log('    最初に異なる位置: ' + diffAt + '文字目');
                    console.log('    基準     : …' + a.slice(Math.max(0, diffAt - 30), diffAt + 30) + '…');
                    console.log('    今回取得 : …' + b.slice(Math.max(0, diffAt - 30), diffAt + 30) + '…');
                }
            });
            process.exitCode = 1;
        }
        if (consoleErrors.length) console.log('consoleErrors:', consoleErrors);
        await browser.close();
        return;
    }

    // --update指定: 比較結果によらず基準を更新する。既存の _note キーは保持する。
    var ordered = {};
    if (existing._note !== undefined) ordered._note = existing._note;
    SNAPSHOT_KEYS.forEach(function(k) { ordered[k] = snapshot[k]; });
    ordered.consoleErrors = snapshot.consoleErrors;
    ordered.capturedAt = new Date().toISOString();

    fs.writeFileSync(outPath, JSON.stringify(ordered, null, 2));
    console.log('--update指定: 基準を更新しました: ' + outPath);
    console.log(mismatches.length === 0
        ? '  (内容は更新前の基準と同一でした。capturedAtのみ更新)'
        : '  更新されたキー: ' + mismatches.join(', '));
    if (consoleErrors.length) console.log('consoleErrors:', consoleErrors);

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
