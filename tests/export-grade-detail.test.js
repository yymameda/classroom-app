// M9: データ出力に「成績の明細CSV」を別ファイルとして追加する(v1.61.0)。
//   先生の回答: 既存のCSVは変えない。各行に 児童・教科・学期・観点・項目名・入力形式・生の値・満点・10点換算・重み を出し、提出物は 状態(お直し済み／お直し前／遅れ)・評価点・欠席除外の有無 も出す。
//   値はすべて成績処理と同じ関数から取る。ファイル名と先頭の説明に対象学期を入れる。
//   検査: (1) 既存の3つのCSV(テスト成績・提出物・成績処理)は変更前と1バイトも変わらない(PIN。変更前のコードで採取)
//         (2) 本番のボタン(#expDetailBtn)から出るファイルの名前・先頭の説明・見出し
//         (3) 明細の「10点換算」と「重み」から観点ごとの重み付き平均を組むと、成績処理CSVの 知識平均・思考平均・主体平均 と全員一致する(照合できる)
//         (4) 明細の値が成績処理(grdCalculate)の項目と一致する(項目名・10点換算・重み)
//         (5) 提出物の状態・評価点・欠席除外／まとめテスト・5段階・得点方式・実技記録・欠席・未入力の見え方／学期／専科を含まない
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node export-grade-detail.test.js       (CAPTURE=1 を付けると、PIN 用の値を出力するだけで判定しない)

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const CAPTURE = process.env.CAPTURE === '1';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let PIN = {};
try { PIN = require('./export-grade-detail.pin.json'); } catch (e) { /* CAPTURE 前は無い */ }

// CSV の1行を分解(ダブルクォート対応)
function parseCsv(text) {
    const t = (text || '').replace(/^﻿/, '');
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
}

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, tests: KEYS.tests, scores: KEYS.scores, assigns: KEYS.submissions_assignments, subs: KEYS.submissions_data, att: KEYS.attendance, weights: KEYS.grade_weights, thresholds: KEYS.grade_thresholds, ext: KEYS.grades_external, patrol: KEYS.patrol }));
    const backup = {};
    for (const k of Object.values(KN)) backup[k] = await page.evaluate((kk) => StorageManager.getRaw(kk), k);

    const pinned = {};
    function pin(name, value, label) {
        const s = JSON.stringify(value);
        if (CAPTURE) { pinned[name] = value; console.log('CAPTURED ' + name + ' :: ' + s.slice(0, 200)); return; }
        check(label || name, s === JSON.stringify(PIN[name]), s === JSON.stringify(PIN[name]) ? '' : ('実際=' + s.slice(0, 300) + ' / 変更前=' + JSON.stringify(PIN[name]).slice(0, 300)));
    }

    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []); put(K.scores, d.scores || []); put(K.assigns, d.assigns || []); put(K.subs, d.subs || []);
            put(K.att, d.att || {}); put(K.weights, d.weights || {}); put(K.patrol, d.patrol || []);
            StorageManager.remove(K.thresholds);
            if (d.ext) put(K.ext, d.ext); else StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => {
            window.__shared = null; window.__csv = null;
            window.universalShare = function(blob, name) { window.__shared = name; return blob.text().then(function(t) { window.__csv = t; }); };
        });
    }
    // データ出力画面のボタンを本番どおり押して、出たファイルの名前と中身を返す
    async function exportClick(btnId, sets) {
        return page.evaluate(async (btnId, sets) => {
            showView('export');
            Object.keys(sets || {}).forEach((id) => { const el = document.getElementById(id); if (el) { el.value = sets[id]; el.dispatchEvent(new Event('change')); } });
            window.__shared = null; window.__csv = null;
            document.getElementById(btnId).click();
            for (let n = 0; n < 40 && window.__csv === null; n++) await new Promise(r => setTimeout(r, 100));
            return { name: window.__shared, csv: window.__csv };
        }, btnId, sets);
    }
    const normName = (n) => (n || '').replace(/\d{4}-\d{2}-\d{2}/, 'D');

    // ===== 題材: 3人(甲・乙・丙)。国語(得点・満点違い・5段階・主体性の5段階/得点・まとめテスト・欠席・2学期のテスト・提出物7種・机間巡視・傾斜配分)・体育(検定)・音楽(専科) =====
    const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }, o);
    const S = (testId, i, score, extra) => Object.assign({ id: testId * 100 + i, studentIndex: i, testId, score }, extra || {});
    const tests = [
        T({ id: 1, name: '漢字10点' }), T({ id: 2, name: '文法20点', maxScore: 20 }), T({ id: 3, name: '読解5段階', inputMode: 'abc5', maxScore: 0 }),
        T({ id: 4, name: '意見文', category: '思考・判断・表現', maxScore: 5 }),
        T({ id: 5, name: '授業への態度5段階', category: '主体性', inputMode: 'abc5', maxScore: 0 }), T({ id: 6, name: 'ノート得点', category: '主体性', inputMode: 'score', maxScore: 5 }),
        T({ id: 7, name: 'まテ一学期', testType: 'まとめテスト', type: 'matome', category: '複合', maxScore: 0, matomePoints: [1, 1, 1, 1, 1, 1], matomeQuestionTypes: ['知', '知', '思', '思', '主', '主'], matomeQCount: 6 }),
        T({ id: 8, name: '欠席した小テスト' }),
        T({ id: 9, name: '二学期の漢字', term: '2', date: '2026-09-10' }),
        T({ id: 10, subject: '体育', name: 'なわとび', testType: '実技記録', maxScore: 9999, peUnit: 'なわとびカード' })
    ];
    const scores = [
        S(1, 0, 8), S(1, 1, 6), S(2, 0, 15), S(3, 0, 'B+'), S(3, 1, 'B-'), S(4, 0, 4), S(5, 0, 'A'), S(5, 1, 'C'), S(6, 0, 4),
        S(7, 0, 0, { answers: [1, 1, 1, 0, 0, 0] }), S(8, 0, 5), S(8, 1, 0, { absent: true }), S(9, 0, 4), S(10, 0, 5, { stage: 5 })
    ];
    const A = (id, name, date, extra) => Object.assign({ id, subject: '国語', name, date, term: '1', createdAt: '2026-05-01T00:00:00Z' }, extra || {});
    const assigns = [A(101, '宿題1', '2026-05-11'), A(102, '宿題2', '2026-05-12'), A(103, '宿題3', '2026-05-13'), A(104, '宿題4', '2026-05-14'), A(105, '宿題5', '2026-05-15'), A(106, '宿題6', '2026-05-16'), A(107, '宿題7', '2026-05-17')];
    const sub = (id, si, aid, extra) => Object.assign({ id, studentIndex: si, assignmentId: aid, createdAt: '2026-05-20T00:00:00Z' }, extra);
    const subs = [
        sub(1, 0, 101, { status: 'submitted' }), sub(2, 0, 102, { status: 'resubmit', correctionDone: false }), sub(3, 0, 103, { status: 'resubmit', correctionDone: true }),
        sub(4, 0, 104, { status: 'submitted', lateOnDue: true }), sub(5, 0, 105, { status: 'missing' }),
        // 宿題6は、期限日(5/16)に欠席(出席簿)かつ未提出 → 欠席除外。宿題7は記録なし
        sub(11, 1, 101, { status: 'submitted' })
    ];
    const att = { '2026-05-16': { '0': '×' } };
    const patrol = [{ id: 1, subject: '国語', studentIndex: 0, date: '2026-05-12', evals: { '発言': '○' } }];
    const weights = { 国語: { knowledge: { k_2: 2 } } };
    const ext = { subjects: ['音楽'], data: { 音楽: { '0': { k: 'A', t: 'B', a: 'A', h: 3 } } } };
    const base = { students: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], tests, scores, assigns, subs, att, patrol, weights, ext };

    // 学期ごとに、既存の3つのCSV
    async function existingCsvs() {
        const o = {};
        const sc = await exportClick('expScoreBtn', { expScoreSubj: '国語' }); o.score = { name: normName(sc.name), csv: sc.csv };
        const sb = await exportClick('expSubBtn', { expSubSubj: '国語' }); o.sub = { name: normName(sb.name), csv: sb.csv };
        for (const term of ['1', '2', 'all']) { const g = await exportClick('expGradeBtn', { expGradeSubj: '国語', expGradeTerm: term }); o['grade_' + term] = { name: normName(g.name), csv: g.csv }; }
        return o;
    }

    try {
        await seed(base);

        // ============ 1. 既存の3つのCSVは、変更前と1バイトも変わらない ============
        const ex = await existingCsvs();
        pin('existing', ex, '既存のCSV(テスト成績・提出物・成績処理の1学期／2学期／通年)は、変更前と1バイトも変わらない');
        const grades0 = await page.evaluate(() => ['1', '2', '3', 'all'].map(t => ['国語', '体育'].map(s => grdCalculate(s, t).map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.avg, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum]))));
        pin('grades', grades0, '成績処理の値(国語・体育の1学期・2学期・3学期・通年)は、変更前と完全に同じ');
        if (CAPTURE) {
            require('fs').writeFileSync(require('path').join(__dirname, 'export-grade-detail.pin.json'), JSON.stringify(pinned, null, 1));
            console.log('WROTE export-grade-detail.pin.json');
            throw new Error('CAPTURE 終了');
        }

        // ============ 2. データ出力の画面: 「成績の明細」のカード・選択肢 ============
        const ui = await page.evaluate(() => { showView('export'); const s = document.getElementById('expDetailSubj'), t = document.getElementById('expDetailTerm'); return { has: !!document.getElementById('expDetailBtn'), subj: s ? Array.from(s.options).map(o => o.value) : null, term: t ? Array.from(t.options).map(o => o.value) : null, termVal: t && t.value, cur: grdGetCurrentTerm(), text: (document.getElementById('expDetailBtn') || {}).innerText }; });
        check('データ出力に「成績の明細CSV」のボタンがある。教科は「全教科＋専科でない教科」(専科の音楽は出ない)・学期は1〜3学期と通年で、初期値は現在の学期', ui.has && JSON.stringify(ui.subj) === '["","国語","体育"]' && JSON.stringify(ui.term) === '["1","2","3","all"]' && ui.termVal === ui.cur && /成績の明細/.test(ui.text || ''), JSON.stringify(ui));

        // ============ 3. 1学期・国語: ファイル名・先頭の説明・見出し・中身 ============
        const d1 = await exportClick('expDetailBtn', { expDetailSubj: '国語', expDetailTerm: '1' });
        check('ファイル名に対象学期と教科が入り、既存の3つのCSVとは別のファイル名(成績の明細_1学期_国語_…)', /^成績の明細_1学期_国語_\d{4}-\d{2}-\d{2}\.csv$/.test(d1.name || ''), String(d1.name));
        const p1 = parseCsv(d1.csv);
        check('先頭の説明: 1行目に「対象学期：1学期」「教科：国語」、2行目に読み方の説明。3行目が見出し(16列)', /^【成績の明細】対象学期：1学期　教科：国語/.test(p1[0][0]) && /重み付き平均|10点換算/.test(p1[1][0]) && p1[2].join('|') === '番号|氏名|教科|学期|観点|項目名|種別|入力形式|生の値|満点|10点換算|重み|状態|評価点|欠席除外|日付', p1[0][0] + ' || ' + p1[2].join('|'));
        const data1 = p1.slice(3).filter(r => r.length > 1);
        check('すべての行が16列で、教科は国語だけ。専科(音楽)・体育の行は入らない', data1.length > 0 && data1.every(r => r.length === 16 && r[2] === '国語'), String(data1.length));
        const row = (name, item, kind) => data1.find(r => r[1] === name && r[5] === item && (kind === undefined || r[6] === kind));
        // 得点(10点満点・20点満点で傾斜配分2)・5段階・主体性の得点/5段階
        const r_a = row('甲', '漢字10点'), r_b = row('甲', '文法20点'), r_c = row('甲', '読解5段階'), r_d = row('甲', '意見文'), r_e = row('甲', '授業への態度5段階'), r_f = row('甲', 'ノート得点');
        check('得点方式(10点満点): 観点=知識・技能・入力形式=得点・生の値8・満点10・10点換算8・重み1・状態=入力済み', r_a && r_a.slice(3, 13).join('|') === '1学期|知識・技能|漢字10点|小テスト|得点|8|10|8|1|入力済み', r_a && r_a.join('|'));
        check('得点方式(20点満点・傾斜配分2): 生の値15・満点20・10点換算7.5(満点が違っても10点換算で比べられる)・重み2', r_b && r_b[7] === '得点' && r_b[8] === '15' && r_b[9] === '20' && r_b[10] === '7.5' && r_b[11] === '2', r_b && r_b.join('|'));
        check('5段階: 入力形式=5段階・生の値B+・満点は空・10点換算8.5', r_c && r_c[7] === '5段階' && r_c[8] === 'B+' && r_c[9] === '' && r_c[10] === '8.5', r_c && r_c.join('|'));
        check('思考・判断・表現の得点: 観点=思考・判断・表現・生の値4・満点5・10点換算8', r_d && r_d[4] === '思考・判断・表現' && r_d[8] === '4' && r_d[9] === '5' && r_d[10] === '8', r_d && r_d.join('|'));
        check('主体性の5段階(A)は10点・主体性の得点方式(4/5)は8点。入力形式が行ごとに分かる', r_e && r_e[4] === '主体性' && r_e[7] === '5段階' && r_e[10] === '10' && r_f && r_f[7] === '得点' && r_f[9] === '5' && r_f[10] === '8', (r_e && r_e.join('|')) + ' || ' + (r_f && r_f.join('|')));
        // まとめテスト: 観点ごとに行が分かれる
        const mk = data1.filter(r => r[1] === '甲' && /^まテ一学期（/.test(r[5]));
        check('まとめテスト: 知識・思考・主体性の3行に分かれ、生の値(合計点)・満点・10点換算が 2/2→10・1/2→5・0/2→0', mk.length === 3 && mk.map(r => [r[4], r[8], r[9], r[10]].join(':')).join(',') === '知識・技能:2:2:10,思考・判断・表現:1:2:5,主体性:0:2:0' && mk.every(r => r[7].indexOf('まとめテスト') === 0), JSON.stringify(mk.map(r => r.slice(4, 11))));
        // 欠席・未入力
        const r_abs = row('乙', '欠席した小テスト'), r_none = row('丙', '漢字10点');
        check('欠席の記録は状態=欠席(10点換算は空＝平均に入らない)。記録のない児童(丙)は状態=未入力', r_abs && r_abs[12] === '欠席' && r_abs[10] === '' && r_none && r_none[12] === '未入力' && r_none[10] === '', (r_abs && r_abs.join('|')) + ' || ' + (r_none && r_none.join('|')));
        // 学期: 1学期を選ぶと2学期のテストは入らない
        check('1学期を選ぶと、2学期のテスト(二学期の漢字)の行は入らない。1学期の行は「学期」列が1学期', !data1.some(r => r[5] === '二学期の漢字') && data1.every(r => r[3] === '1学期'), '');
        // 提出物: 集計の行と内訳の行
        const agg = data1.find(r => r[1] === '甲' && r[6] === '提出物');
        check('提出物の集計の行(甲): 観点=主体性・評価点の合計3.6・分母6(欠席除外の1件は入れない)・10点換算6・欠席除外1件・状態=入力済み', agg && agg[4] === '主体性' && agg[8] === '3.6' && agg[9] === '6' && agg[10] === '6' && agg[13] === '3.6' && agg[14] === '1件' && agg[12] === '入力済み', agg && agg.join('|'));
        const det = data1.filter(r => r[1] === '甲' && r[6] === '提出物（内訳）');
        check('提出物の内訳(甲の宿題1〜7): 状態と評価点が 提出1／お直し前0.8／お直し済み1／遅れて提出0.8／未提出0／欠席（除外）0(欠席除外=あり)／記録なし0', det.length === 7 && det.map(r => r[12] + ':' + r[13] + ':' + r[14]).join(',') === '提出:1:,お直し前:0.8:,お直し済み:1:,遅れて提出:0.8:,未提出:0:,欠席（除外）:0:あり,記録なし:0:', det.map(r => r[12] + ':' + r[13] + ':' + r[14]).join(','));
        check('提出物の内訳: 生の値は提出物CSVと同じ内部の文字(submitted/resubmit/missing)で、日付・入力形式も入る。10点換算・重みは集計の行だけ', det[0][8] === 'submitted' && det[1][8] === 'resubmit' && det[4][8] === 'missing' && det[6][8] === '' && det[0][15] === '2026-05-11' && det.every(r => r[10] === '' && r[11] === '' && r[7] === '提出状況'), JSON.stringify(det.slice(0, 2)));
        const agg2 = data1.find(r => r[1] === '乙' && r[6] === '提出物');
        check('提出物(乙): 提出1件・記録なし6件 → 評価点1・分母7・10点換算1.4', agg2 && agg2[8] === '1' && agg2[9] === '7' && agg2[10] === '1.4' && agg2[14] === '', agg2 && agg2.join('|'));
        // 机間巡視
        const pt = data1.filter(r => r[1] === '甲' && r[6] === '机間巡視');
        check('机間巡視(甲): 記録のある観点だけ行が出て、生の値は○・△の件数、10点換算10。記録のない児童(乙)の行は出ない', pt.length === 2 && pt.every(r => /^○1/.test(r[8]) && r[10] === '10') && !data1.some(r => r[1] === '乙' && r[6] === '机間巡視'), JSON.stringify(pt.map(r => r.slice(4, 12))));

        // ============ 4. 照合: 明細の10点換算と重みから観点ごとの重み付き平均を組むと、成績処理CSVの平均と全員一致 ============
        const gc = await exportClick('expGradeBtn', { expGradeSubj: '国語', expGradeTerm: '1' });
        const gp = parseCsv(gc.csv).slice(1).filter(r => r.length > 5);   // 番号,氏名,評定,合計,知識ABC,思考ABC,主体ABC,知識平均,思考平均,主体平均,学期
        const persp = ['知識・技能', '思考・判断・表現', '主体性'];
        const recomputed = (name) => persp.map(pn => {
            const its = data1.filter(r => r[1] === name && r[4] === pn && r[10] !== '' && r[6] !== '提出物（内訳）');
            if (!its.length) return '';
            let ws = 0, ss = 0, plain = 0;
            its.forEach(r => { const w = Number(r[11]); ws += w; ss += Number(r[10]) * w; plain += Number(r[10]); });
            const avg = ws > 0 ? ss / ws : plain / its.length;
            return (Math.round(avg * 10) / 10).toFixed(1);
        });
        let allMatch = true; const cmp = [];
        gp.forEach(g => { const mine = recomputed(g[1]), theirs = [g[7], g[8], g[9]]; cmp.push(g[1] + ':' + mine.join('/') + ' vs ' + theirs.join('/')); if (mine.join('/') !== theirs.join('/')) allMatch = false; });
        check('照合: 明細から「重み付き平均」を組むと、成績処理CSVの 知識平均・思考平均・主体平均 と全員一致する(甲・乙・丙。傾斜配分・欠席・未入力・提出物・机間巡視を含む)', allMatch && gp.length === 3, cmp.join(' | '));

        // ============ 5. 同じ関数から: 成績処理(grdCalculate)の項目と、項目名・10点換算・重みが一致 ============
        const viaCalc = await page.evaluate(() => {
            const out = [];
            grdCalculate('国語', '1').forEach(r => [['knowledge', '知識・技能'], ['thinking', '思考・判断・表現'], ['attitude', '主体性']].forEach(p => r[p[0]].items.forEach(it => {
                if (it.type === '提出物' || it.type === '机間巡視') { if (it.score10 === null || it.score10 === undefined) return; }
                out.push([r.index + 1, p[1], it.name, it.score10 === null || it.score10 === undefined ? '' : String(it.score10), it.weight === null || it.weight === undefined ? '' : String(it.weight)].join('|'));
            })));
            return out;
        });
        const viaCsv = data1.filter(r => r[6] !== '提出物（内訳）').map(r => [r[0], r[4], r[5], r[10], r[11]].join('|'));
                const aggOnly = (arr) => arr.slice().sort();
        // 提出物の集計は、提出物の課題があるとき(この題材では国語)だけ。机間巡視は記録のあるものだけ。どちらも成績と同じ順・同じ値
        check('項目名・10点換算・重みが grdCalculate の項目と一致する(順序・件数も同じ)', JSON.stringify(aggOnly(viaCsv)) === JSON.stringify(aggOnly(viaCalc)), viaCsv.length + ' vs ' + viaCalc.length + ' / ' + (aggOnly(viaCsv).filter(x => aggOnly(viaCalc).indexOf(x) < 0)[0] || '') + ' | ' + (aggOnly(viaCalc).filter(x => aggOnly(viaCsv).indexOf(x) < 0)[0] || ''));

        // ============ 6. 学期: 2学期・通年 ============
        const d2 = await exportClick('expDetailBtn', { expDetailSubj: '国語', expDetailTerm: '2' });
        const p2 = parseCsv(d2.csv), data2 = p2.slice(3).filter(r => r.length > 1);
        check('2学期: ファイル名と先頭に「2学期」・1学期のテストは入らない(二学期の漢字だけ。学期列=2学期)', /^成績の明細_2学期_国語_/.test(d2.name || '') && /対象学期：2学期/.test(p2[0][0]) && data2.some(r => r[5] === '二学期の漢字' && r[3] === '2学期' && r[10] === '4') && !data2.some(r => r[5] === '漢字10点'), data2.map(r => r[5]).filter((v, i, a) => a.indexOf(v) === i).join(','));
        const dA = await exportClick('expDetailBtn', { expDetailSubj: '国語', expDetailTerm: 'all' });
        const pA = parseCsv(dA.csv), dataA = pA.slice(3).filter(r => r.length > 1);
        check('通年: ファイル名と先頭に「通年」・1学期と2学期のテストが両方入り、テストの行の学期列はそのテストの学期(1学期／2学期)・提出物と机間巡視の集計は「通年」', /^成績の明細_通年_国語_/.test(dA.name || '') && /対象学期：通年/.test(pA[0][0]) && dataA.some(r => r[5] === '漢字10点' && r[3] === '1学期') && dataA.some(r => r[5] === '二学期の漢字' && r[3] === '2学期') && dataA.filter(r => r[6] === '提出物' || r[6] === '机間巡視').every(r => r[3] === '通年'), '');

        // ============ 7. 全教科: 専科は含まない・体育の検定 ============
        const dAll = await exportClick('expDetailBtn', { expDetailSubj: '', expDetailTerm: '1' });
        const pAll = parseCsv(dAll.csv), dataAll = pAll.slice(3).filter(r => r.length > 1);
        const subjSet = Array.from(new Set(dataAll.map(r => r[2]))).sort().join(',');
        check('全教科: ファイル名は「全教科」・教科は国語と体育だけ(専科登録の音楽は行に出ない)', /^成績の明細_1学期_全教科_/.test(dAll.name || '') && /教科：全教科/.test(pAll[0][0]) && subjSet === '体育,国語', subjSet);
        const nawa = dataAll.find(r => r[1] === '甲' && r[5] === 'なわとび');
        check('体育の検定(なわとび): 入力形式=実技記録(換算表による)・生の値=段階5・10点換算=4(段階の数字と換算値が区別できる)', nawa && nawa[7] === '実技記録（換算表による）' && nawa[8] === '5' && nawa[10] === '4' && nawa[6] === '実技記録', nawa && nawa.join('|'));

        // ============ 8. 出したあとも、既存のCSVと成績の値は変わらない ============
        const ex2 = await existingCsvs();
        pin('existing', ex2, '明細を出したあとも、既存の3つのCSVは変更前と1バイトも変わらない');
        const grades1 = await page.evaluate(() => ['1', '2', '3', 'all'].map(t => ['国語', '体育'].map(s => grdCalculate(s, t).map(r => [r.knowledge.avg, r.knowledge.abc, r.thinking.avg, r.thinking.abc, r.attitude.avg, r.attitude.abc, r.hyoutei, r.totalNum]))));
        pin('grades', grades1, '明細を出したあとも、成績処理の値は変更前と完全に同じ');
    } catch (e) {
        if (!CAPTURE) check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        if (!CAPTURE) check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== export-grade-detail: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(CAPTURE ? 0 : (fail ? 1 : 0));
    }
})();
