// M7: 専科(外部確定)成績を学期ごとに持つ(v1.61.0)。
//   先生の回答: 通知表には専科の評定を学期ごとに載せる。既存の値はすべて1学期分。
//   保存データは書き換えない: `data[教科]`(今までの形)を「1学期の値」と読み、2・3学期は `data['教科@2']`・`data['教科@3']` に足す(移行処理なし=冪等)。
//   専科入力タブに学期の切り替え(初期値は現在の学期・「いま入力中」の表示)。
//   各出力(成績処理の表・カルテPDF・面談テキスト・レーダーPDF・成績CSV(成績処理／データ出力)・算出根拠Excel)は、それぞれの学期の出所に従い、その学期の専科の値を使う。
//   値のない学期は「未入力」(他の学期で埋めない)。通年は「最新の入力済み学期の値」を学期名つきで(例: B（2学期）)。学期の平均は取らない。
//   1学期を選んだときの各出力と、専科以外の成績(全学期)は、変更前と完全に同じ(PIN で固定。変更前のコードで採取した値)。
//   本番の操作経路: 専科入力タブのボタンを page.click() で押す／出力ボタンを押す／名簿変更・復元・バックアップは本番の関数。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node ext-grade-term.test.js       (CAPTURE=1 を付けると、PIN 用の値を出力するだけで判定しない)

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const CAPTURE = process.env.CAPTURE === '1';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 変更前のコード(v1.60.4)で採取した値。1学期のときの各出力と、専科以外(国語)の成績。
let PIN = {};
try { PIN = require('./ext-grade-term.pin.json'); } catch (e) { /* CAPTURE 前は無い */ }

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept());   // 「専科データを削除しますか」などの確認は「はい」
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol, archive: KEYS.student_archive }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    const pinned = {};   // CAPTURE 用
    function pin(name, value, label) {
        const s = JSON.stringify(value);
        if (CAPTURE) { pinned[name] = value; console.log('CAPTURED ' + name + ' :: ' + s); return; }
        check(label || name, s === JSON.stringify(PIN[name]), s === JSON.stringify(PIN[name]) ? '' : ('実際=' + s + ' / 変更前=' + JSON.stringify(PIN[name])));
    }

    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: d.termSystem || 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []);
            put(K.scores, d.scores || []);
            put(K.assigns, d.assigns || []);
            put(K.subs, d.subs || []);
            put(K.att, {}); put(K.weights, {}); put(K.patrol, d.patrol || []);
            StorageManager.remove(K.thresholds); StorageManager.remove(K.archive);
            if (d.ext) put(K.ext, d.ext); else StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => {
            window.__rendered = []; window.__renderedHtml = [];
            window.__origH2C = window.html2canvas;
            window.html2canvas = function(el, opts) { window.__rendered.push((el.innerText || '').replace(/\s+/g, ' ')); window.__renderedHtml.push(el.outerHTML); return window.__origH2C(el, opts); };
            const col = (c) => { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
            window.XLSX = { utils: { encode_col: col, encode_cell: (a) => col(a.c) + (a.r + 1), book_new: () => ({ names: [], sheets: {} }), book_append_sheet: (wb, ws, name) => { wb.names.push(name); wb.sheets[name] = ws; window.__wb = wb; }, aoa_to_sheet: (aoa) => ({ __aoa: aoa }) }, write: () => new Uint8Array(1) };
            window.__shared = null; window.__csv = null;
            window.universalShare = function(blob, name) { window.__shared = name; return blob.text().then(function(t) { window.__csv = t; }); };
            try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(t) { window.__clip = t; return Promise.resolve(); } } }); } catch (e) {}
        });
    }
    async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(250); } return false; }
    const rawExt = () => page.evaluate((k) => localStorage.getItem(k), KN.ext);
    const parsedExt = async () => JSON.parse((await rawExt()) || 'null');

    // 成績処理画面の学期・教科を選ぶ(本番のサブタブのボタンを押す)
    async function gradeSel(sub, term, subj) {
        await page.evaluate(() => { showView('grades'); });
        await page.click('#view-grades .sub-subnav-btn[data-sub="' + sub + '"]');
        await page.evaluate((term, subj) => {
            const s = document.getElementById('grdTermSel'); s.value = term; s.dispatchEvent(new Event('change'));
            const g = document.getElementById('grdGradeSubj'); if (g && subj) { g.value = subj; g.dispatchEvent(new Event('change')); }
        }, term, subj);
        await sleep(150);
    }
    const tableRows = () => page.evaluate(() => { const t = document.querySelector('#grdGradeContainer table'); return t ? Array.from(t.querySelectorAll('tbody tr')).map(tr => Array.from(tr.children).map(td => td.innerText.trim()).join('|')) : []; });
    const csvLines = (t) => (t || '').replace(/^﻿/, '').split('\n');
    async function gradeCsv(term, subj) {   // 成績処理画面の成績CSV
        await gradeSel('grade', term, subj);
        return page.evaluate(async () => { window.__shared = null; window.__csv = null; document.getElementById('grdCSVBtn').click(); await new Promise(r => setTimeout(r, 300)); return { name: window.__shared, csv: window.__csv }; });
    }
    async function exportCsv(term, subj) {   // データ出力画面の成績処理CSV
        return page.evaluate(async (term, subj) => {
            showView('export');
            const sel = document.getElementById('expGradeSubj'); if (![...sel.options].some(o => o.value === subj)) sel.add(new Option(subj, subj));
            sel.value = subj; document.getElementById('expGradeTerm').value = term;
            window.__shared = null; window.__csv = null; document.getElementById('expGradeBtn').click(); await new Promise(r => setTimeout(r, 300)); return { name: window.__shared, csv: window.__csv };
        }, term, subj);
    }
    async function excelRows(term, subj) {   // 算出根拠Excel の「評定一覧」
        await gradeSel('grade', term, subj);
        await page.evaluate(() => { window.__wb = null; window.__shared = null; document.getElementById('grdExcelBtn').click(); });
        await sleep(400);
        return page.evaluate(() => ({ name: window.__shared, rows: window.__wb && window.__wb.sheets['評定一覧'] ? window.__wb.sheets['評定一覧'].__aoa.map(r => r.join('|')) : null }));
    }
    async function setOutputTerm(term) { await page.evaluate((term) => { showView('karte'); kvSetMode('output'); const s = document.getElementById('kvTermSel'); s.value = term; s.dispatchEvent(new Event('change')); }, term); await sleep(150); }
    async function pdfRun(clickFn, ...args) {
        await page.evaluate(() => { window.__rendered = []; window.__renderedHtml = []; const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });
        await page.evaluate(clickFn, ...args);
        const ok = await waitFor(() => !!document.getElementById('pdfResultOverlay'), 90000);
        const out = await page.evaluate(() => ({ text: window.__rendered.slice(), html: window.__renderedHtml.slice() }));
        await page.evaluate(() => { const o = document.getElementById('pdfResultOverlay'); if (o) o.remove(); });
        return Object.assign({ ok }, out);
    }
    const kartePdf = (design, term, idx) => pdfRun(async (design, term, idx) => {
        showView('karte'); kvSetMode('output');
        const s = document.getElementById('kvTermSel'); s.value = term; s.dispatchEvent(new Event('change'));
        document.getElementById('kvSec_grades').checked = true;
        document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(idx)); });
        const r = document.querySelector('input[name="kvDesign"][value="' + design + '"]'); if (r) r.checked = true;
        document.getElementById('kvPrintBtn').click();
    }, design, term, idx);
    async function confText(term, idx) {
        await setOutputTerm(term);
        await page.evaluate((idx) => { window.__clip = null; document.querySelectorAll('.kv-student-chk').forEach(c => { c.checked = (c.value === String(idx)); }); document.getElementById('kvCopyTextBtn').click(); }, idx);
        await sleep(250);
        return page.evaluate(() => window.__clip || '');
    }
    const radarPdf = async (term) => { await setOutputTerm(term); return pdfRun(() => { document.getElementById('grdExtRadarPdfBtn').click(); }); };
    const grepLine = (t, re) => ((t || '').split('\n').find(l => re.test(l)) || '(なし)');
    const snip = (t) => { const m = /音楽.*?(?=家庭|📚|$)/.exec(t || ''); return m ? m[0].trim() : '(なし)'; };   // 音楽の分だけ(次の教科・次の欄の手前まで)
    const radarRow = (html) => { const m = /<td[^>]*>音楽<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td><td[^>]*>(.*?)<\/td>/.exec(html || ''); return m ? m.slice(1, 5).join(',') : '(なし)'; };
    const pageOf = (r, i, kind) => { const re = new RegExp((i + 1) + '\\s*' + NAMES[i] + '\\s*さん\\s*' + (kind === 'card' ? '教科別のくわしい記録' : '学習のようす')); const k = r.text.findIndex(t => re.test(t)); return k < 0 ? null : { text: r.text[k], html: r.html[k] }; };

    // ===== 題材: 4人(甲・乙・丙・丁)。国語(専科でない)の小テスト・宿題・机間巡視は学期で値が変わる。音楽・家庭は専科 =====
    const NAMES = ['甲', '乙', '丙', '丁'];
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score }, extra || {});
    const tests = [T({ id: 1, name: '漢字一学期', term: '1' }), T({ id: 2, name: '漢字二学期', term: '2', date: '2026-09-10' })];
    const scores = [S(1, 0, 8), S(2, 0, 4), S(1, 1, 6), S(2, 1, 6)];
    const assigns = [{ id: 101, subject: '国語', name: '一学期の宿題', date: '2026-05-11', term: '1', createdAt: '2026-05-01T00:00:00Z' }, { id: 102, subject: '国語', name: '二学期の宿題', date: '2026-09-11', term: '2', createdAt: '2026-09-01T00:00:00Z' }];
    const patrol = [{ id: 1, subject: '国語', studentIndex: 0, date: '2026-05-12', evals: { '発言': '○' } }, { id: 2, subject: '国語', studentIndex: 0, date: '2026-09-12', evals: { '発言': '△' } }];
    const subs = [{ id: 1, studentIndex: 0, assignmentId: 101, status: 'submitted', correctionDone: true, createdAt: '2026-05-12T00:00:00Z' }];
    // 保存されている専科の値(v1.60.4 までの形＝学期を持たない)。学期を足したあとは、これが「1学期の値」になる。丙は知・思だけ(主・評定は未入力)。丁は何もない
    const LEGACY = { subjects: ['音楽', '家庭'], data: { 音楽: { '0': { k: 'A', t: 'B', a: 'A', h: 3 }, '1': { k: 'B', t: 'B', a: 'B', h: 2 }, '2': { k: 'C', t: 'C' } } } };
    const LEGACY_RAW = JSON.stringify(LEGACY);
    const base = { students: NAMES.map(n => ({ name: n })), tests, scores, assigns, subs, patrol };

    try {
        await seed(Object.assign({}, base, { ext: LEGACY }));

        // ============ 1. 保存データは書き換えない(移行処理なし＝冪等) ============
        check('保存データ: 起動した直後も、専科の保存データは v1.60.4 までの形のまま(1バイトも変わらない)', (await rawExt()) === LEGACY_RAW, (await rawExt()));
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(300); await page.reload({ waitUntil: 'networkidle0' }); await sleep(300);
        check('保存データ: 再読み込みを2回しても同じ(冪等)', (await rawExt()) === LEGACY_RAW, '');
        await seed(Object.assign({}, base, { ext: LEGACY }));

        // ============ 2. 【変更前と完全一致】専科以外(国語)の成績は、全学期で変わらない ============
        pin('kokugo', await page.evaluate(() => ['1', '2', '3', 'all'].map(t => grdCalculate('国語', t).map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.avg, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum]))), '専科以外(国語)の観点別・評定は、1学期・2学期・3学期・通年とも変更前と完全に同じ');

        // ============ 3. 【変更前と完全一致】1学期の専科の値: 計算結果・各出力 ============
        pin('calc1', await page.evaluate(() => grdCalculate('音楽', '1').map(r => [r.knowledge.abc, r.thinking.abc, r.attitude.abc, r.hyoutei, r.totalNum])), '1学期: 専科(音楽)の計算結果(知・思・主・評定・合計)が変更前と同じ');
        await gradeSel('grade', '1', '音楽');
        pin('table1', (await tableRows()).slice(0, 3), '1学期: 成績処理の表(音楽・甲乙丙)が変更前と同じ');
        const g1 = await gradeCsv('1', '音楽');
        pin('csv1', { name: g1.name && g1.name.replace(/\d{4}-\d{2}-\d{2}/, 'D'), rows: csvLines(g1.csv).slice(0, 4) }, '1学期: 成績CSV(成績処理画面)のファイル名・中身(音楽・甲乙丙)が変更前と同じ');
        const e1 = await exportCsv('1', '音楽');
        pin('expcsv1', { name: e1.name && e1.name.replace(/\d{4}-\d{2}-\d{2}/, 'D'), rows: csvLines(e1.csv).slice(0, 4) }, '1学期: 成績CSV(データ出力画面)のファイル名・中身が変更前と同じ');
        const x1 = await excelRows('1', '音楽');
        pin('excel1', { name: x1.name && x1.name.replace(/\d{4}-\d{2}-\d{2}/, 'D'), rows: (x1.rows || []).slice(0, 6) }, '1学期: 算出根拠Excelの「評定一覧」のファイル名・中身が変更前と同じ');
        const c1 = await confText('1', 0), c1b = await confText('1', 2);
        pin('conf1', [grepLine(c1, /^音楽：/), grepLine(c1b, /^音楽：/)], '1学期: 面談テキストの音楽の行(甲・丙)が変更前と同じ');
        const kc1 = await kartePdf('child', '1', 0), kt1 = await kartePdf('teacher', '1', 1);
        pin('karte1', [snip(kc1.text[0]), snip(kt1.text[0])], '1学期: カルテPDF(児童用の甲・教員用の乙)の音楽が変更前と同じ');
        const rd1 = await radarPdf('1');
        const rp1 = pageOf(rd1, 0, 'main'), rp1c = pageOf(rd1, 2, 'main');
        pin('radar1', [radarRow(rp1 && rp1.html), radarRow(rp1c && rp1c.html)], '1学期: レーダーPDF 1ページ目の音楽の行(甲・丙)が変更前と同じ');

        if (CAPTURE) {
            require('fs').writeFileSync(require('path').join(__dirname, 'ext-grade-term.pin.json'), JSON.stringify(pinned, null, 1));
            console.log('WROTE ext-grade-term.pin.json');
            throw new Error('CAPTURE 終了');
        }

        // ============ 4. 値のない学期は「未入力」(他の学期で埋めない) ============
        const calc2 = await page.evaluate(() => grdCalculate('音楽', '2').map(r => [r.knowledge.abc, r.thinking.abc, r.attitude.abc, r.hyoutei]));
        check('2学期: まだ何も入れていない専科の値は、1学期の値で埋めず空(計算結果)', JSON.stringify(calc2) === '[["","","",""],["","","",""],["","","",""],["","","",""]]', JSON.stringify(calc2));
        await gradeSel('grade', '2', '音楽');
        const t2 = await tableRows();
        check('2学期: 成績処理の表は、全員「未入力」(甲の行に 3/A/B/A が出ない)', t2.length === 4 && t2.every(r => r.split('|').slice(2, 6).every(c => c === '未入力')), JSON.stringify(t2));
        const g2 = await gradeCsv('2', '音楽'), e2 = await exportCsv('2', '音楽'), x2 = await excelRows('2', '音楽');
        check('2学期: 成績CSV(成績処理画面・データ出力画面)・算出根拠Excelの音楽は「未入力」(評定・知思主の欄)', /未入力/.test(csvLines(g2.csv)[1]) && /未入力/.test(csvLines(e2.csv)[1]) && (x2.rows || []).slice(3, 4).every(r => /未入力/.test(r)) && !/,A,|,B,|,3,/.test(csvLines(g2.csv)[1]), csvLines(g2.csv)[1] + ' || ' + csvLines(e2.csv)[1] + ' || ' + (x2.rows || [])[3]);
        check('2学期: ファイル名は今までどおり学期つき', /音楽_成績_2学期_/.test(g2.name || '') && /成績処理_音楽_2学期_/.test(e2.name || ''), g2.name + ' / ' + e2.name);
        const c2 = await confText('2', 0);
        check('2学期: 面談テキストは「音楽：未入力」(対象学期：2学期)', /^音楽：未入力/m.test(c2) && /対象学期：2学期/.test(c2), grepLine(c2, /^音楽：/));
        const kc2 = await kartePdf('child', '2', 0), kt2 = await kartePdf('teacher', '2', 0);
        check('2学期: カルテPDF(児童用・教員用)の音楽は「未入力」', /音楽 .{0,12}未入力/.test(kc2.text[0]) && /音楽 未入力/.test(kt2.text[0]), snip(kc2.text[0]) + ' | ' + snip(kt2.text[0]));
        const rd2 = await radarPdf('2');
        const rp2 = pageOf(rd2, 0, 'main'), rc2 = pageOf(rd2, 0, 'card');
        check('2学期: レーダーPDFの表の音楽の行は「未入力」。教科カードの評定も「未入力」(以前は行もカードも1学期の値)', radarRow(rp2 && rp2.html) === '未入力,未入力,未入力,未入力' && rc2 && /音楽 評定 未入力/.test(rc2.text), radarRow(rp2 && rp2.html) + ' / ' + (rc2 ? (/音楽.{0,16}/.exec(rc2.text) || [''])[0] : '(カードなし)'));

        // ============ 5. 専科入力タブ: 学期の切り替え・初期値は現在の学期・「いま入力中」の表示 ============
        await seed(Object.assign({}, base, { ext: LEGACY }));
        await page.evaluate(() => { const R = Date; window.__RealDate = R; window.Date = class extends R { constructor(...a) { if (a.length === 0) super('2026-10-15T09:00:00'); else super(...a); } static now() { return new R('2026-10-15T09:00:00').getTime(); } }; });
        await page.evaluate(() => { showView('grades'); });
        await page.click('#view-grades .sub-subnav-btn[data-sub="external"]');
        await sleep(200);
        const tabInfo = await page.evaluate(() => { const s = document.getElementById('grdExtTermSel'); const b = document.getElementById('grdExtTermBanner'); return { exists: !!s, value: s && s.value, opts: s ? Array.from(s.options).map(o => o.value + ':' + o.text) : [], banner: b ? b.innerText.replace(/\s+/g, '') : null, bannerVisible: !!(b && b.offsetParent) }; });
        check('専科入力タブ: 学期の切り替えがあり、初期値は現在の学期(2学期の日付なら「2学期」)。1〜3学期から選べる', tabInfo.exists && tabInfo.value === '2' && JSON.stringify(tabInfo.opts) === '["1:1学期","2:2学期","3:3学期"]', JSON.stringify(tabInfo));
        check('専科入力タブ: 「いま入力中：2学期」が見える表示になっている', tabInfo.bannerVisible && /いま入力中.*2学期/.test(tabInfo.banner || ''), String(tabInfo.banner));
        await page.evaluate(() => { window.Date = window.__RealDate; });

        // ============ 6. 2学期に本番のボタンで入力: 1学期(保存データ)は1バイトも変わらない ============
        await page.select('#grdExtSubj', '音楽');
        await page.select('#grdExtTermSel', '2');
        await sleep(150);
        check('専科入力タブ: 学期を変えると「いま入力中：2学期」の表示と、表の見出しにも学期が出る。2学期はまだ全員空', await page.evaluate(() => /2学期/.test(document.getElementById('grdExtTermBanner').innerText) && /2学期/.test(document.getElementById('grdExtGridWrap').innerText) ), '');
        const rowTerms = () => page.evaluate(() => Array.from(document.querySelectorAll('#grdExtGridWrap .grd-ext-row-term')).map(e => e.innerText.trim()));
        const rt2 = await rowTerms();
        check('専科入力タブ: 画面をスクロールしても分かるよう、児童の各行の名前の横にも「2学期」の札が出る(4人とも)', rt2.length === 4 && rt2.every(t => t === '2学期'), JSON.stringify(rt2));
        const clickExt = async (call) => { await page.click('#grdExtGridWrap button[onclick="' + call + '"]'); await sleep(700); };   // 保存は少し遅れて書かれる;
        await clickExt("grdExtSetABC(0,'k','C')");            // 甲の2学期: 知=C
        await clickExt("grdExtSetHyoutei(0,2)");               // 甲の2学期: 評定=2
        await clickExt("grdExtSetABC(1,'k','B')");             // 乙の2学期: 知=B (あとで消す)
        await clickExt("grdExtClearRow(1)");                   // 乙の2学期の行をクリア
        let ext = await parsedExt();
        check('2学期の入力は data["音楽@2"] に保存される(甲=知C・評定2)。乙は行をクリアしたので残らない', ext && JSON.stringify(ext.data['音楽@2']) === '{"0":{"k":"C","h":2}}', JSON.stringify(ext && ext.data['音楽@2']));
        check('1学期の値(data["音楽"])と subjects は、2学期を入力しても1バイトも変わらない', ext && JSON.stringify(ext.data['音楽']) === JSON.stringify(LEGACY.data['音楽']) && JSON.stringify(ext.subjects) === JSON.stringify(LEGACY.subjects), JSON.stringify(ext && ext.data['音楽']));
        pin('calc1', await page.evaluate(() => grdCalculate('音楽', '1').map(r => [r.knowledge.abc, r.thinking.abc, r.attitude.abc, r.hyoutei, r.totalNum])), '2学期を入力したあとも、1学期の専科の計算結果は変更前と同じ(以前は1学期の値も書き換わった)');
        await gradeSel('grade', '2', '音楽');
        const t2b = await tableRows();
        check('2学期: 成績処理の表は、甲=知C・評定2(入力した分)、乙〜丁は「未入力」。1学期の値は混ざらない', t2b[0] && t2b[0].split('|').slice(2, 6).join(',') === '2,C,—,—' && t2b.slice(1).every(r => r.split('|').slice(2, 6).every(c => c === '未入力')), JSON.stringify(t2b));
        await gradeSel('grade', '1', '音楽');
        pin('table1', (await tableRows()).slice(0, 3), '1学期: 成績処理の表は、2学期を入力したあとも変更前と同じ');
        // 1学期を、学期の切り替え(1学期)で入力: 保存先は今までのキー(data["音楽"])
        await page.evaluate(() => { showView('grades'); });
        await page.click('#view-grades .sub-subnav-btn[data-sub="external"]');
        await page.select('#grdExtTermSel', '1'); await sleep(120);
        const rt1 = await rowTerms();
        check('1学期に切り替えると、各行の札も「1学期」になる', rt1.length === 4 && rt1.every(t => t === '1学期'), JSON.stringify(rt1));
        await clickExt("grdExtSetABC(3,'a','B')");             // 丁の1学期: 主=B
        ext = await parsedExt();
        check('1学期の入力は今までのキー data["音楽"] に保存される(丁=主B)。2学期の値は変わらない', ext && ext.data['音楽']['3'] && ext.data['音楽']['3'].a === 'B' && JSON.stringify(ext.data['音楽@2']) === '{"0":{"k":"C","h":2}}', JSON.stringify(ext && ext.data['音楽']['3']));
        await clickExt("grdExtSetABC(3,'a','B')");             // 押し直して丁の1学期を元に戻す
        ext = await parsedExt();
        check('1学期の丁の入力を取り消すと、保存データは最初の形に戻る(1学期の行は空になり消える)', ext && JSON.stringify(ext.data['音楽']) === JSON.stringify(LEGACY.data['音楽']), JSON.stringify(ext && ext.data['音楽']));

        // ============ 7. 通年: 最新の入力済み学期の値を学期名つきで(平均は取らない) ============
        //   甲: 1学期 A/B/A/3 → 2学期 知C・評定2 を入力済み。3学期の甲は評定だけ 1 を入力する
        await page.select('#grdExtTermSel', '3'); await sleep(120);
        await clickExt("grdExtSetHyoutei(0,1)");
        ext = await parsedExt();
        check('3学期の入力は data["音楽@3"] に保存される', ext && JSON.stringify(ext.data['音楽@3']) === '{"0":{"h":1}}', JSON.stringify(ext && ext.data['音楽@3']));
        const all = await page.evaluate(() => grdCalculate('音楽', 'all').map(r => ({ k: r.knowledge.abc, t: r.thinking.abc, a: r.attitude.abc, h: r.hyoutei, total: r.totalNum, terms: r.extTerms, missing: r.extMissing })));
        check('通年の計算: 甲は項目ごとに最新の入力済み学期(知=2学期のC・思=1学期のB・主=1学期のA・評定=3学期の1)。学期の平均は取らない', all[0].k === 'C' && all[0].t === 'B' && all[0].a === 'A' && all[0].h === 1 && JSON.stringify(all[0].terms) === '{"k":"2","t":"1","a":"1","h":"3"}', JSON.stringify(all[0]));
        check('通年の計算: 学期がばらばらの甲は合計を出さない(null)。乙は全部1学期の値なので合計6', all[0].total === null && all[1].total === 6 && JSON.stringify(all[1].terms) === '{"k":"1","t":"1","a":"1","h":"1"}', JSON.stringify([all[0].total, all[1].total]));
        check('通年の計算: 丙は知・思だけ(未入力ではなく主・評定は空)。丁は何もないので extMissing', all[2].k === 'C' && all[2].a === '' && all[2].missing === false && all[3].missing === true, JSON.stringify([all[2], all[3]]));
        await gradeSel('grade', 'all', '音楽');
        const tall = await tableRows();
        check('通年: 成績処理の表は「1（3学期）」「C（2学期）」「B（1学期）」「A（1学期）」(合計は—)。丙は主・評定が「—」、丁は「未入力」', tall[0].split('|').slice(2, 7).join(',') === '1（3学期）,C（2学期）,B（1学期）,A（1学期）,—' && tall[2].split('|').slice(2, 6).join(',') === '—,C（1学期）,C（1学期）,—' && tall[3].split('|').slice(2, 6).every(c => c === '未入力'), JSON.stringify(tall));
        const ga = await gradeCsv('all', '音楽'), ea = await exportCsv('all', '音楽'), xa = await excelRows('all', '音楽');
        check('通年: 成績CSV(成績処理画面・データ出力画面)は「1（3学期）」「C（2学期）」つき。ファイル名に通年', /1（3学期）/.test(csvLines(ga.csv)[1]) && /C（2学期）/.test(csvLines(ga.csv)[1]) && /1（3学期）/.test(csvLines(ea.csv)[1]) && /音楽_成績_通年_/.test(ga.name || '') && /成績処理_音楽_通年_/.test(ea.name || ''), csvLines(ga.csv)[1] + ' || ' + csvLines(ea.csv)[1]);
        check('通年: 算出根拠Excelの「評定一覧」も「1（3学期）」「C（2学期）」つき', (xa.rows || []).slice(3, 4).every(r => /1（3学期）/.test(r) && /C（2学期）/.test(r)), (xa.rows || [])[3]);
        const ca = await confText('all', 0), ca3 = await confText('all', 3);
        check('通年: 面談テキストは「知 C（2学期）／思 B（1学期）／主 A（1学期）／評定 1（3学期）」。値のない丁は「未入力」', /^音楽：知 C（2学期）／思 B（1学期）／主 A（1学期）／評定 1（3学期）/m.test(ca) && /^音楽：未入力/m.test(ca3), grepLine(ca, /^音楽：/) + ' | ' + grepLine(ca3, /^音楽：/));
        const kca = await kartePdf('child', 'all', 0), kta = await kartePdf('teacher', 'all', 0);
        check('通年: カルテPDF(児童用・教員用)に「C（2学期）」「1（3学期）」が出る', /C（2学期）/.test(kca.text[0]) && /1（3学期）/.test(kca.text[0]) && /C（2学期）/.test(kta.text[0]) && /1（3学期）/.test(kta.text[0]), snip(kca.text[0]) + ' | ' + snip(kta.text[0]));
        const rda = await radarPdf('all');
        const rpa = pageOf(rda, 0, 'main');
        check('通年: レーダーPDFの表の音楽の行は「C（2学期）,B（1学期）,A（1学期）,1（3学期）」。折れ線の評定の値(1)は入力済みの最新', radarRow(rpa && rpa.html) === 'C（2学期）,B（1学期）,A（1学期）,1（3学期）', radarRow(rpa && rpa.html));
        // 2学期に戻す: 通年のあとでも 2学期・1学期の値は変わらない
        pin('calc1', await page.evaluate(() => grdCalculate('音楽', '1').map(r => [r.knowledge.abc, r.thinking.abc, r.attitude.abc, r.hyoutei, r.totalNum])), '通年・3学期を入力したあとも、1学期の専科の計算結果は変更前と同じ');

        // ============ 8. 専科以外の成績は、専科の入力・出力のあとも全学期で変わらない ============
        pin('kokugo', await page.evaluate(() => ['1', '2', '3', 'all'].map(t => grdCalculate('国語', t).map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.avg, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum]))), '専科を学期別に入力・出力したあとも、専科以外(国語)の成績は全学期で変更前と同じ');

        // ============ 9. 全員が未入力の専科(家庭)は、どの学期でも「未入力」 ============
        await gradeSel('grade', '1', '家庭');
        const th1 = await tableRows();
        check('家庭(専科登録のみ・値なし): 1学期でも通年でも「未入力」', th1.length === 4 && th1.every(r => r.split('|').slice(2, 6).every(c => c === '未入力')), JSON.stringify(th1.slice(0, 2)));

        // ============ 10. バックアップ・復元・整合性検査・名簿変更 ============
        const bk = await page.evaluate(() => JSON.parse(JSON.stringify(window.buildBackupObject())));
        const bkExt = JSON.parse(bk.data[KN.ext]);
        check('バックアップ: 専科の学期別の値(音楽@2・音楽@3)も含まれる。版の印は今までどおり(version 11)', bkExt.data['音楽@2'] && bkExt.data['音楽@3'] && bk.version === 11, 'version=' + bk.version);
        // 端末の専科データを消してから復元 → 学期別の値が戻る
        await page.evaluate((k) => { StorageManager.setImmediate(k, JSON.stringify({ subjects: ['音楽'], data: {} })); }, KN.ext);
        const rs = await page.evaluate((b) => window.brRestoreFromBackup(b), bk);
        await sleep(400);
        const afterRestore = await parsedExt();
        check('復元: 学期別の値(音楽@2・音楽@3)が戻り、1学期の値も同じ', afterRestore && JSON.stringify(afterRestore.data) === JSON.stringify(bkExt.data), JSON.stringify(rs).slice(0, 120));
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
        const integ = await page.evaluate(() => window.spaIntegrityCheck());
        check('復元後の整合性検査: 問題なし(専科の学期別の値で問題が出ない)', integ && integ.ok === true, JSON.stringify(integ));

        // 名簿から甲を外す → 退避 → 戻す: 音楽・音楽@2・音楽@3 のすべてが甲に付いて戻る
        await seed(Object.assign({}, base, { ext: JSON.parse(JSON.stringify(bkExt)) }));
        const ids = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).students.map(s => s.studentId), KN.master);
        const ns = await page.evaluate((k) => { const m = JSON.parse(localStorage.getItem(k)); return m.students.slice(1); }, KN.master);
        const ap = await page.evaluate((ns) => window.applyRosterChange(ns, { reload: false }), ns);
        const extAfterDel = await parsedExt();
        check('名簿から甲を外すと、音楽・音楽@2・音楽@3 とも、残りの児童の番号が1つずつ繰り上がる(乙=0番)', ap && ap.ok && extAfterDel.data['音楽']['0'].k === 'B' && extAfterDel.data['音楽@2'] && Object.keys(extAfterDel.data['音楽@2']).length === 0 && extAfterDel.data['音楽@3'] && Object.keys(extAfterDel.data['音楽@3']).length === 0, JSON.stringify(ap).slice(0, 100) + ' ' + JSON.stringify(extAfterDel.data));
        const arch = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KN.archive);
        const archId = arch && arch.entries && arch.entries[0] && arch.entries[0].archiveId;
        const rr = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), archId);
        const extAfterRestore = await parsedExt();
        const newIdx = String(ns.length);
        check('退避した甲を戻すと、1学期(音楽)・2学期(音楽@2)・3学期(音楽@3)のすべてが甲に戻る(以前は学期別のキーを「専科でない教科」と誤読して戻さなかった)', rr && rr.ok && JSON.stringify(extAfterRestore.data['音楽'][newIdx]) === JSON.stringify(bkExt.data['音楽']['0']) && JSON.stringify(extAfterRestore.data['音楽@2'][newIdx]) === JSON.stringify(bkExt.data['音楽@2']['0']) && JSON.stringify(extAfterRestore.data['音楽@3'][newIdx]) === JSON.stringify(bkExt.data['音楽@3']['0']), JSON.stringify(rr).slice(0, 160) + ' ' + JSON.stringify(extAfterRestore.data));

        // ============ 11. 専科データの削除: 学期別の値もすべて消える ============
        await seed(Object.assign({}, base, { ext: JSON.parse(JSON.stringify(bkExt)) }));
        await page.evaluate(() => { showView('grades'); });
        await page.click('#view-grades .sub-subnav-btn[data-sub="external"]');
        await page.select('#grdExtSubj', '音楽'); await sleep(120);
        await page.click('#grdExtClearSubjBtn'); await sleep(900);
        const extDel = await parsedExt();
        check('「この教科の専科データを削除」: 音楽・音楽@2・音楽@3 と専科登録がすべて消える(家庭の登録は残る)', extDel && !('音楽' in extDel.data) && !('音楽@2' in extDel.data) && !('音楽@3' in extDel.data) && JSON.stringify(extDel.subjects) === '["家庭"]', JSON.stringify(extDel));

        // ============ 12. 2学期制: 入力できる学期は1・2学期 ============
        await seed(Object.assign({}, base, { termSystem: 2, ext: LEGACY }));
        await page.evaluate(() => { showView('grades'); });
        await page.click('#view-grades .sub-subnav-btn[data-sub="external"]'); await sleep(150);
        const opts2 = await page.evaluate(() => Array.from(document.getElementById('grdExtTermSel').options).map(o => o.value));
        check('2学期制: 専科入力の学期の切り替えは「1学期・2学期」だけ', JSON.stringify(opts2) === '["1","2"]', JSON.stringify(opts2));
    } catch (e) {
        if (!CAPTURE) check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        if (!CAPTURE) check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== ext-grade-term: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(CAPTURE ? 0 : (fail ? 1 : 0));
    }
})();
