// v1.63.1: 5段階(A〜C)の「取消」ボタンを足しても、1児童あたりの行の高さ・リスト全体の高さ・座席のタイルが v1.62.0 と変わらないことの回帰テスト。
//   背景(iPad 実機の指摘 v1.63.0): 取り消しの専用の行(44px)を足したため、カードが 92→126px になり、27人が1画面に収まらなくなった。
//   v1.63.1 は「欠席ボタンの隣」に欠席ボタンと同じ大きさ(38×24)で並べ、高さは v1.62.0 のまま。
//
//   比べ方: v1.62.0 のコード(取り消しの無い版)で採取した値(abc-row-height.pin.json)と、今のコードの実測が一致すること。
//     対象: 27人・30人 × 5つの画面サイズ(iPad Air 横/縦・iPad 10世代・iPad mini・iPad Pro 13) × リスト・連続入力・座席。
//     リスト=1行の高さ(カード・見出し行・氏名・A〜Cの行)・リスト全体の高さ(内容/表示)・全部見える人数
//     連続入力=マスの高さ・全体の高さ・入力画面(入力済みのマスを開いた状態)の高さ
//     座席=タイルの高さ・氏名／値／番号の行の高さ(折り返すと増える)・段数
//   さらに、同じ画面で「入力済み・欠席中・未入力」が混ざっても高さが変わらないこと(状態で高さが動かない)。
//
// 採取(v1.62.0 のコードを別ポートで配信して): CAPTURE=1 BASE_URL=http://localhost:8131/index.html node abc-row-height.test.js
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node abc-row-height.test.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const CAPTURE = process.env.CAPTURE === '1';
const PIN_PATH = path.join(__dirname, 'abc-row-height.pin.json');
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SIZES = [['iPad Air 横 1180x820', 1180, 820], ['iPad Air 縦 820x1180', 820, 1180], ['iPad 10世代 横 1080x810', 1080, 810], ['iPad mini 横 1133x744', 1133, 744], ['iPad Pro13 横 1366x1024', 1366, 1024]];
const NAMES = ['山田太郎', '佐藤花', '鈴木一郎', '田中美咲', '高橋', '伊藤大和', '渡辺', '中村さくら', '小林陽菜', '加藤', '吉田悠真', '山本', '佐々木花子', '松本', '井上', '木村', '林', '斎藤', '清水', '山口', '池田', '橋本', '阿部', '石川', '山崎', '中島', '前田', '藤田', '岡田', '後藤'];

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, seating: KEYS.seating }));

    // state: 'mixed'=入力済み・欠席中(点数あり/なし)・未入力が混ざる / 'empty'=全員未入力 / 'full'=全員入力済み
    async function seed(n, state) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            const names = d.names.slice(0, d.n);
            put(K.master, { version: 2, students: names.map(x => ({ name: x })), classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, [{ id: 1, subject: '国語', testType: '小テスト', name: '発言', category: '主体性', type: 'standard', maxScore: 0, inputMode: 'abc5', date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }]);
            const sc = [];
            names.forEach((_, i) => {
                const v = ['A', 'B+', 'B', 'B-', 'C'][i % 5];
                if (d.state === 'full') sc.push({ id: 100 + i, studentIndex: i, testId: 1, score: v, createdAt: 'x' });
                if (d.state === 'mixed') {
                    if (i % 3 === 0) sc.push({ id: 100 + i, studentIndex: i, testId: 1, score: v, createdAt: 'x' });
                    if (i === 4) sc.push({ id: 900, studentIndex: 4, testId: 1, score: '', absent: true, createdAt: 'x' });
                    if (i === 6) sc.push({ id: 901, studentIndex: 6, testId: 1, score: 'A', absent: true, createdAt: 'x' });
                }
            });
            put(K.scores, sc);
            const seat = {}; names.forEach((_, i) => { seat[Math.floor(i / 6) + '-' + (i % 6)] = i; }); put(K.seating, seat);
        }, K, { n, state, names: NAMES });
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(500);
    }

    // 1つの画面サイズ・1つのモードの実測
    async function measure(w, h, mode) {
        await page.setViewport({ width: w, height: h });
        await sleep(250);
        await page.evaluate(() => { showView('records'); recSelectTestGoto(1); });
        await sleep(350);
        await page.evaluate((m) => recSetViewMode(m), mode);
        await sleep(350);
        const base = await page.evaluate((mode) => {
            const R = e => e.getBoundingClientRect();
            const q = (root, sel) => Array.from(root.querySelectorAll(sel));
            const distinct = a => Array.from(new Set(a.map(x => Math.round(x * 10) / 10))).sort((a, b) => a - b);
            const ret = {};
            if (mode === 'list') {
                const list = document.getElementById('recList'), lr = R(list);
                const cards = q(list, '.rec-row');
                ret.n = cards.length;
                ret.rowH = distinct(cards.map(c => R(c).height));
                ret.hdH = distinct(cards.map(c => R(c.querySelector('.rec-row-hd')).height));
                ret.nameH = distinct(cards.map(c => R(c.querySelector('.sub-row-name')).height));
                ret.btnsH = distinct(cards.map(c => R(c.querySelector('.rec-abc-btns')).height));
                ret.listScrollH = list.scrollHeight; ret.listClientH = list.clientHeight;
                window.__cutNames = cards.map(c => c.querySelector('.sub-row-name')).filter(e => e.textContent.length <= 4 && e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent);
                window.__nameW = Math.round(cards[0].querySelector('.sub-row-name').clientWidth);
                ret.fullyVisible = cards.filter(c => { const r = R(c); return r.top >= lr.top - 0.5 && r.bottom <= lr.bottom + 0.5; }).length;
            } else if (mode === 'continuous') {
                const wrap = document.getElementById('recContWrap'), grid = document.getElementById('recContGrid');
                const cells = q(grid, '.rec-cont-cell');
                ret.n = cells.length;
                ret.cellH = distinct(cells.map(c => R(c).height));
                ret.gridH = Math.round(R(grid).height * 10) / 10;
                ret.wrapScrollH = wrap.scrollHeight; ret.wrapClientH = wrap.clientHeight;
            } else {
                const wrap = document.getElementById('recSeatWrap'), grid = document.getElementById('recSeatGrid');
                const cells = q(grid, '.rec-seat-cell');
                ret.n = cells.length;
                ret.cellH = distinct(cells.map(c => R(c).height));
                ret.numH = distinct(cells.map(c => R(c.querySelector('.sub-seat-num')).height));
                ret.nameH = distinct(cells.map(c => R(c.querySelector('.sub-seat-name')).height));
                ret.statusH = distinct(cells.map(c => R(c.querySelector('.sub-seat-status')).height));
                ret.tops = distinct(q(grid, '.sub-seat-cell').map(c => R(c).top)).length; // 段数
                ret.gridH = Math.round(R(grid).height * 10) / 10;
                ret.wrapScrollH = wrap.scrollHeight; ret.wrapClientH = wrap.clientHeight;
            }
            return ret;
        }, mode);
        if (mode === 'continuous') {
            // 入力済みのマス(1番)を開いた状態の高さ(入力画面。取り消しのボタンを足しても高さが変わらない)
            const sel = '#recContGrid .rec-cont-cell[data-cidx="0"]';
            const ok = await page.$(sel);
            if (ok) {
                await page.click(sel); await sleep(250);
                base.expandedH = await page.evaluate(() => { const c = document.querySelector('#recContGrid .rec-cont-cell.editing'); return c ? Math.round(c.getBoundingClientRect().height * 10) / 10 : null; });
                base.gridHExpanded = await page.evaluate(() => Math.round(document.getElementById('recContGrid').getBoundingClientRect().height * 10) / 10);
            }
        }
        return base;
    }

    try {
        const pin = CAPTURE ? {} : JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
        const now = {};
        for (const n of [27, 30]) {
            await seed(n, 'mixed');
            for (const [nm, w, h] of SIZES) {
                for (const mode of ['list', 'continuous', 'seat']) {
                    const key = n + '人|' + nm + '|' + mode;
                    now[key] = await measure(w, h, mode);
                    if (!CAPTURE && mode === 'list') {
                        // 見出し行に「取消」を足したあとも、4文字以下の氏名は省略されない(氏名の幅を確保する)。値は pin には入れない(v1.62.0 は幅が広い)
                        const cut = await page.evaluate(() => ({ cut: window.__cutNames, w: window.__nameW }));
                        check('[' + n + '人 ' + nm + ' リスト] 4文字以下の氏名が省略されない(氏名の表示幅 ' + cut.w + 'px)', cut.cut.length === 0, cut.cut.join(' '));
                    }
                    if (!CAPTURE) check('[' + n + '人 ' + nm + ' ' + { list: 'リスト', continuous: '連続入力', seat: '座席' }[mode] + '] 高さが v1.62.0 と一致(' + Object.keys(now[key]).filter(k => k !== 'n').join('・') + ')',
                        JSON.stringify(now[key]) === JSON.stringify(pin[key]), '今=' + JSON.stringify(now[key]) + ' / v1.62.0=' + JSON.stringify(pin[key]));
                }
            }
        }
        if (CAPTURE) {
            fs.writeFileSync(PIN_PATH, JSON.stringify(now, null, 1));
            console.log('採取しました: ' + Object.keys(now).length + ' 件 → ' + PIN_PATH);
        } else {
            // 状態で高さが動かない(今のコードだけの性質): 全員入力済み・全員未入力でも、混在のときと同じ高さ
            for (const state of ['empty', 'full']) {
                await seed(27, state);
                for (const [nm, w, h] of [SIZES[0], SIZES[1], SIZES[3]]) {
                    for (const mode of ['list', 'seat']) {
                        const m = await measure(w, h, mode);
                        const ref = now['27人|' + nm + '|' + mode];
                        const keys = mode === 'list' ? ['rowH', 'hdH', 'nameH', 'btnsH', 'listScrollH'] : ['cellH', 'numH', 'nameH', 'statusH', 'tops', 'gridH'];
                        check('[27人 ' + nm + ' ' + (mode === 'list' ? 'リスト' : '座席') + '・' + (state === 'empty' ? '全員未入力' : '全員入力済み') + '] 入力の状態が変わっても高さが変わらない',
                            keys.every(k => JSON.stringify(m[k]) === JSON.stringify(ref[k])), JSON.stringify(keys.map(k => [k, m[k], ref[k]])));
                    }
                }
            }
            check('リスト(30人): 1行の高さの下限(min-height)が v1.62.0 と同じ 86px', await page.evaluate(() => { const r = document.querySelector('#recList .rec-row.abc-row'); return r && getComputedStyle(r).minHeight; }) === '86px');
            const sw = await page.evaluate(async () => (await (await fetch('./sw.js?nocache=' + Date.now())).text()).match(/CACHE_VERSION = '([^']*)'/)[1]);
            // 版は「この変更を入れた v1.63.1 以上」であること(次の版に上げても、この検査は通り続ける。上げ忘れ=v1.63.0 以下は失敗する)
            const vp = String(sw).replace(/^v/, '').split('.').map(Number);
            check('sw.js の CACHE_VERSION が v1.63.1 以上', vp.length === 3 && vp.every(n => !isNaN(n)) && (vp[0] > 1 || (vp[0] === 1 && (vp[1] > 63 || (vp[1] === 63 && vp[2] >= 1)))), sw);
            check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.join(' | '));
        }
    } catch (e) {
        check('テスト実行中に例外なし', false, String(e && e.stack || e));
    }
    await browser.close();
    const failed = results.filter(r => !r.pass).length;
    console.log('\n合計 ' + results.length + ' 件 / 成功 ' + (results.length - failed) + ' / 失敗 ' + failed);
    process.exit(failed ? 1 : 0);
})();
