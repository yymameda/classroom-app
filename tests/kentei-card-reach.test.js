// 泳力(24技)・なわとび(21技)の検定カードで、全技が「表示され、タップして選べる」ことの回帰テスト(v1.62.0)。
//
// 不具合(K1): 25〜30人のとき、カード(.rec-nawatobi-card、overflow:hidden)が押しつぶされ、下の区分(ジャンプ・ハイジャンプ)の技が見えず選べなかった。
//   原因: v1.38.0 で一覧(#recList)が内側スクロールになって以降、グリッドの行が一覧の高さを分け合って縮んだ。
//   修正(v1.62.0): .rec-list.nw-mode に grid-auto-rows: max-content(行はカードの中身の高さ。一覧は縦にスクロール)。
//
// 検査:
//   A. 既存の入力済みデータ(段階・score10・成績)が変わらない
//      - 保存された記録の stage・score10、アプリの計算(kenteiCalcStage・kenteiStageToScore10・kenteiStageToLabel)が、
//        定義(泳力24技25段階・なわとび21技22段階)から決まる期待値と一致する(期待値はこのファイルに固定)
//      - 一覧の表示(級バッジ)が期待の級と一致する
//      - 一覧を開くだけでは、保存された記録は1バイトも変わらない
//      - 体育の成績(grdCalculate)は、変更前のコードで採取した値(kentei-card-reach.pin.json)と一致する
//   B. 30人で、iPad Air 横/縦・iPad 10世代・iPad mini・iPad Pro 13 の各サイズにおいて、両方の検定の全技(24個・21個)が
//      (1)カードの中に入っている (2)一覧の見える範囲に入る(一覧をスクロールして) (3)その位置でボタンが一番上にある(他の要素に隠れていない)
//      (4)実際にタップして選べる(最後の児童のカードで全技をタップ→段階・score10・級が合う→もう一度タップして元に戻る)
//   C. v1.38.0 の構造(一覧だけが内側でスクロールし、外側・ヘッダーは動かない)と、検定でない一覧が影響を受けないこと
//
// 技ボタンのタップ領域は約23〜31px角のまま(44pxの基準に届かない)。ここでは「隠れていない・タップできる」ことを検査し、大きさは記録するだけ。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node kentei-card-reach.test.js
//   CAPTURE=1 を付けると、成績の pin(kentei-card-reach.pin.json)を書き出して終わる(変更前のコードに向けて実行する)

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const CAPTURE = process.env.CAPTURE === '1';
const PIN_FILE = path.join(__dirname, 'kentei-card-reach.pin.json');
let PIN = null;
try { PIN = require('./kentei-card-reach.pin.json'); } catch (e) { /* CAPTURE 前は無い */ }

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 定義から決まる期待値(v1.61.2 までの定義。変えていない) ----
const SWIM = { total: 24,
    label: (s) => s <= 0 ? '-' : (s <= 18 ? (19 - s) + '級' : 'マスター' + (25 - s)),
    score10: (s) => s <= 0 ? 1 : s <= 6 ? 2 : s <= 12 ? 4 : s <= 14 ? 7 : s <= 16 ? 8 : s <= 18 ? 9 : 10 };
const NW_S10 = [0, 1, 2, 3, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10];
const NAWA = { total: 21,
    label: (s) => s <= 0 ? '-' : (s >= 21 ? 'マスター' : (21 - s) + '級'),
    score10: (s) => NW_S10[Math.max(0, Math.min(21, s))] };

const VIEWPORTS = [
    ['iPad Air 横 1180x820', 1180, 820], ['iPad Air 縦 820x1180', 820, 1180], ['iPad 10世代 横 1080x810', 1080, 810],
    ['iPad mini 横 1133x744', 1133, 744], ['iPad Pro13 横 1366x1024', 1366, 1024]
];
const N = 30;

// 段階(=合格累計技数)の並び。泳力: 境目(6/7・12/13・14/15・16/17・18/19・24)を含む。なわとびは (i*3)%22
const SWIM_STAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 6, 12, 18, 5];
const NAWA_STAGE = (i) => (i * 3) % 22;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820, hasTouch: true } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    const setVp = async (w, h) => { await page.setViewport({ width: w, height: h, hasTouch: true }); await sleep(250); };
    const selectTest = async (id) => {
        await page.evaluate((id) => { showView('records'); recShowSub('input'); const s = document.getElementById('recInputTestSelect'); s.value = String(id); s.dispatchEvent(new Event('change')); }, id);
        await sleep(450);
    };

    try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
        await sleep(400);

        // ================= 題材の投入(30人。泳力・なわとび・通常の小テスト) =================
        await page.evaluate((N, SWIM_STAGES, NAWA_STAGES) => {
            const K = KEYS;
            const students = []; for (let i = 0; i < N; i++) students.push({ studentId: 'stu_' + (10000000 + i), name: '児童' + String(i + 1).padStart(2, '0'), number: i + 1, gender: i % 2 ? '女' : '男' });
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            const T = (o) => Object.assign({ subject: '体育', testType: '実技記録', category: '知識・技能', type: 'standard', maxScore: 9999, date: '2026-09-10', term: '2', createdAt: '2026-09-10T00:00:00Z', peDirection: 'higher', peTrials: 1 }, o);
            put(K.tests, [T({ id: 1, name: '泳力検定', peUnit: '検定:swimming' }), T({ id: 2, name: 'なわとび', peUnit: 'なわとびカード' }),
                { id: 3, subject: '算数', testType: '小テスト', category: '知識・技能', type: 'standard', name: '計算テスト', maxScore: 100, date: '2026-09-10', term: '2', createdAt: '2026-09-10T00:00:00Z' }]);
            // 記録は、アプリが保存する形(passData・nawatobiData・stage・score・score10)。技は区分の順に先頭から stage 個を合格にする
            const passOf = (cfg, n) => { const o = {}; let k = 0; cfg.categories.forEach(c => c.skills.forEach(s => { o[s.id] = (k++ < n) ? 1 : 0; })); return o; };
            const cfgS = kenteiGetConfig({ peUnit: '検定:swimming' }), cfgN = kenteiGetConfig({ peUnit: 'なわとびカード' });
            const scores = []; let id = 1000;
            const add = (i, testId, passData, stage, s10) => scores.push({ id: ++id, studentIndex: i, testId, passData, nawatobiData: passData, stage, score: stage, score10: s10, createdAt: '2026-09-11T00:00:00Z' });
            SWIM_STAGES.forEach((st, i) => {
                if (i === 27) { // 前の区分が未完了で、後ろの区分だけ合格している児童(ホップ5/6・ジャンプ3個): 段階は5(後ろは数えない)
                    const p = passOf(cfgS, 5); cfgS.categories[2].skills.slice(0, 3).forEach(s => { p[s.id] = 1; }); add(i, 1, p, 5, 2);
                } else add(i, 1, passOf(cfgS, st), st, NaN);
            });
            NAWA_STAGES.forEach((st, i) => { if (st > 0) add(i, 2, passOf(cfgN, st), st, NaN); });
            for (let i = 0; i < 10; i++) scores.push({ id: ++id, studentIndex: i, testId: 3, score: 50 + i * 5, createdAt: '2026-09-11T00:00:00Z' });
            window.__fixture = scores;
            put(K.scores, scores);
        }, N, SWIM_STAGES, Array.from({ length: N }, (_, i) => NAWA_STAGE(i)));
        // score10 は期待値(定義から決まる値)で保存し直す(NaN で仮置きしたもの)
        await page.evaluate((s10Swim, s10Nawa) => {
            const K = KEYS; const raw = JSON.parse(StorageManager.getRaw(K.scores));
            raw.forEach(r => { if (r.testId === 1 && (r.score10 === null || Number.isNaN(r.score10))) r.score10 = s10Swim[r.stage]; if (r.testId === 2) r.score10 = s10Nawa[r.stage]; });
            StorageManager.setImmediate(K.scores, JSON.stringify(raw));
        }, Array.from({ length: 25 }, (_, s) => SWIM.score10(s)), NW_S10);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(600);
        const rawBefore = await page.evaluate(() => StorageManager.getRaw(KEYS.scores));
        const recs = JSON.parse(rawBefore);
        check('(前提)題材: 30人・泳力の記録28件・なわとびの記録(段階1以上)・通常の小テスト10件', recs.filter(r => r.testId === 1).length === 28 && recs.filter(r => r.testId === 2).length === Array.from({ length: N }, (_, i) => NAWA_STAGE(i)).filter(x => x > 0).length && recs.filter(r => r.testId === 3).length === 10, recs.length + '件');

        // ================= A. 既存データの段階・score10・成績が変わらない =================
        const calc = await page.evaluate(() => {
            const cS = kenteiGetConfig({ peUnit: '検定:swimming' }), cN = kenteiGetConfig({ peUnit: 'なわとびカード' });
            return JSON.parse(StorageManager.getRaw(KEYS.scores)).filter(r => r.testId === 1 || r.testId === 2).map(r => { const c = r.testId === 1 ? cS : cN; const st = kenteiCalcStage(c, r.passData); return { testId: r.testId, i: r.studentIndex, savedStage: r.stage, savedS10: r.score10, stage: st, s10: kenteiStageToScore10(c, st), label: kenteiStageToLabel(c, st) }; });
        });
        const badCalc = calc.filter(x => { const D = x.testId === 1 ? SWIM : NAWA; return !(x.stage === x.savedStage && x.s10 === x.savedS10 && x.s10 === D.score10(x.stage) && x.label === D.label(x.stage)); });
        check('保存済みの記録(泳力28件・なわとび)の段階・10点換算・級が、定義から決まる期待値と一致する(アプリの計算も同じ)', badCalc.length === 0 && calc.length > 40, badCalc.length + '件不一致 ' + JSON.stringify(badCalc.slice(0, 2)));
        check('境目の段階(6/7・12/13・14/15・16/17・18/19・24)と「前の区分が未完了なら後ろは数えない」(段階5)を含む', [6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 24].every(s => calc.some(x => x.testId === 1 && x.stage === s)) && calc.some(x => x.testId === 1 && x.i === 27 && x.stage === 5 && x.label === '14級'), '');

        for (const [testId, D, tname] of [[1, SWIM, '泳力'], [2, NAWA, 'なわとび']]) {
            await selectTest(testId);
            const badge = await page.evaluate(() => [...document.querySelectorAll('.rec-nawatobi-card')].map(c => ({ i: parseInt(c.id.replace('rec-row-', ''), 10), text: c.querySelector('.rec-nw-grade').textContent, has: c.classList.contains('has-record') })));
            const expect = (i) => { const r = recs.find(x => x.testId === testId && x.studentIndex === i); return r ? D.label(r.stage) : '-'; };
            const badBadge = badge.filter(b => b.text !== expect(b.i) || b.has !== (expect(b.i) !== '-'));
            check(tname + ': 一覧の級バッジが、記録の段階から決まる級と一致する(' + badge.length + '人。記録なしは「-」)', badge.length === N && badBadge.length === 0, JSON.stringify(badBadge.slice(0, 3)));
        }

        // 成績(体育・2学期): 変更前のコードで採取した値と一致する
        const gradeNow = await page.evaluate(() => {
            const res = grdCalculate('体育', '2');
            const summary = res.map(r => r.name + ':' + r.knowledge.items.map(it => it.itemKey + '=' + it.score10 + '/' + it.raw).join(',') + '|avg=' + r.knowledge.avg + '|' + r.knowledge.abc + '|' + r.hyoutei + '|' + r.totalNum);
            let h = 2166136261; const s = JSON.stringify(res); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
            return { summary, hash: h, n: res.length };
        });
        if (CAPTURE) {
            fs.writeFileSync(PIN_FILE, JSON.stringify({ grade: gradeNow.summary, hash: gradeNow.hash }, null, 1));
            console.log('WROTE kentei-card-reach.pin.json (' + gradeNow.n + '人)');
            await browser.close();
            process.exit(0);
        }
        check('(前提)成績の pin(kentei-card-reach.pin.json)がある', !!PIN && Array.isArray(PIN.grade) && PIN.grade.length === N, '');
        if (PIN) {
            const diff = gradeNow.summary.map((s, i) => [i, s, PIN.grade[i]]).filter(x => x[1] !== x[2]);
            check('体育の成績(検定の10点換算・素点・知識・技能の平均と観点・評定・合計)が、変更前のコードで採取した値と30人とも一致する', gradeNow.n === N && diff.length === 0 && gradeNow.hash === PIN.hash, diff.length + '人不一致 ' + JSON.stringify(diff.slice(0, 1)) + ' hash ' + gradeNow.hash + '/' + PIN.hash);
        }

        // ================= B. 30人・各サイズで全技が到達可能 =================
        // 一覧をスクロールして、全児童の全技ボタンが (1)カード内 (2)一覧の見える範囲内 (3)他の要素に隠れていない(その位置で最前面) ことを確かめる
        const reachFn = () => {
            const list = document.getElementById('recList');
            const cards = [...list.querySelectorAll('.rec-nawatobi-card')];
            const bad = []; let n = 0, minSide = 999;
            const lr0 = list.getBoundingClientRect();
            const listOnScreen = lr0.top >= -0.5 && lr0.bottom <= innerHeight + 0.5 && lr0.height > 200;
            cards.forEach((card, ci) => card.querySelectorAll('.rec-nw-skill-btn').forEach(btn => {
                n++;
                const lr = list.getBoundingClientRect(); let br = btn.getBoundingClientRect();
                list.scrollTop += (br.top + br.height / 2) - (lr.top + lr.height / 2);
                br = btn.getBoundingClientRect();
                const cr = card.getBoundingClientRect(), lr2 = list.getBoundingClientRect();
                const inCard = br.top >= cr.top - 0.5 && br.bottom <= cr.bottom + 0.5 && br.left >= cr.left - 0.5 && br.right <= cr.right + 0.5;
                const inList = br.top >= lr2.top - 0.5 && br.bottom <= lr2.bottom + 0.5;
                const top = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
                const hit = top === btn || btn.contains(top);
                minSide = Math.min(minSide, br.width, br.height);
                if (!(inCard && inList && hit)) bad.push(ci + ':' + btn.id.replace(/^rec-nw-\d+-/, '') + (inCard ? '' : '[カード外]') + (inList ? '' : '[一覧外]') + (hit ? '' : '[隠れ]'));
            }));
            list.scrollTop = 0;
            return { cards: cards.length, n, badN: bad.length, bad: bad.slice(0, 6), minSide: Math.round(minSide), listOnScreen, cols: getComputedStyle(list).gridTemplateColumns.split(' ').length, scrolls: list.scrollHeight > list.clientHeight + 1 };
        };
        for (const [vname, w, h] of VIEWPORTS) {
            await setVp(w, h);
            for (const [testId, D, tname] of [[1, SWIM, '泳力'], [2, NAWA, 'なわとび']]) {
                await selectTest(testId);
                const r = await page.evaluate(reachFn);
                check(tname + ' / ' + vname + ': 30人 × 全' + D.total + '技(' + r.n + '個)が、カード内・一覧の見える範囲・最前面に到達できる(' + r.cols + '列・一覧は' + (r.scrolls ? 'スクロールする' : 'スクロールしない') + '・技ボタンの最小辺 ' + r.minSide + 'px)',
                    r.cards === N && r.n === N * D.total && r.badN === 0 && r.listOnScreen && r.minSide >= 20, r.badN + '個が届かない ' + r.bad.join(' '));
            }
        }

        // 一覧を、指(タッチ)のなぞりでスクロールできる(プログラムからの scrollTop は overflow:hidden でも効くので、実際のタッチ操作で確かめる)
        const cdp = await page.createCDPSession();
        for (const [vname, w, h] of VIEWPORTS) {
            await setVp(w, h);
            await selectTest(1);
            const c = await page.evaluate(() => { const l = document.getElementById('recList'); l.scrollTop = 0; const b = l.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 200)), overflowY: getComputedStyle(l).overflowY, sh: l.scrollHeight, ch: l.clientHeight }; });
            await cdp.send('Input.synthesizeScrollGesture', { x: c.x, y: c.y, yDistance: -300, gestureSourceType: 'touch', speed: 800 });
            await sleep(450);
            const top = await page.evaluate(() => document.getElementById('recList').scrollTop);
            check('泳力 / ' + vname + ': 一覧を指のなぞり(タッチ)で縦にスクロールできる(内容' + c.sh + 'px・表示' + c.ch + 'px)', c.sh > c.ch + 100 && /^(auto|scroll)$/.test(c.overflowY) && top > 100, 'overflow-y=' + c.overflowY + ' scrollTop=' + top);
            await page.evaluate(() => { document.getElementById('recList').scrollTop = 0; });
        }

        // 実際にタップして選べる: 一覧の最後の児童(29番=いちばん下・記録なし)のカードで、全技を順にタップ(スクロールしながら)。
        //   全技 → 段階=技の総数・10点換算=10・級=マスター。もう一度全部タップ → 元に戻る(記録が消え、保存が最初と同じ)
        //   (戻すときは逆順: 全技offでちょうど段階0になり、記録が削除される。順に戻すと途中で記録が消えて画面だけが変わるため)
        const tapAll = async (testId, idx, total, reverse) => {
            let ids = await page.evaluate((idx) => [...document.querySelectorAll('#rec-row-' + idx + ' .rec-nw-skill-btn')].map(b => b.id), idx);
            if (reverse) ids = ids.slice().reverse();
            let missed = 0;
            for (const id of ids) {
                const pos = await page.evaluate((id) => {
                    const list = document.getElementById('recList'); const btn = document.getElementById(id);
                    const lr = list.getBoundingClientRect(); let br = btn.getBoundingClientRect();
                    list.scrollTop += (br.top + br.height / 2) - (lr.top + lr.height / 2);
                    br = btn.getBoundingClientRect();
                    const x = br.left + br.width / 2, y = br.top + br.height / 2; const top = document.elementFromPoint(x, y);
                    return { x, y, hit: top === btn || btn.contains(top) };
                }, id);
                if (!pos.hit) { missed++; continue; }
                await page.touchscreen.tap(pos.x, pos.y);
                await sleep(30);
            }
            return { ids: ids.length, missed };
        };
        for (const [vname, w, h] of VIEWPORTS) {
            await setVp(w, h);
            for (const [testId, D, tname] of [[1, SWIM, '泳力'], [2, NAWA, 'なわとび']]) {
                await selectTest(testId);
                const idx = N - 1; // 29番。泳力は記録なし。なわとびは (29*3)%22=21 → 記録あり(マスター)なので、別の記録なしの児童を使う
                const target = testId === 1 ? idx : await page.evaluate(() => { const has = new Set(JSON.parse(StorageManager.getRaw(KEYS.scores)).filter(r => r.testId === 2).map(r => r.studentIndex)); for (let i = 29; i >= 0; i--) if (!has.has(i)) return i; return -1; });
                const before = await page.evaluate(() => StorageManager.getRaw(KEYS.scores));
                const t1 = await tapAll(testId, target, D.total);
                await sleep(700); // StorageManager は少し遅れて localStorage に書く
                const rec = await page.evaluate((testId, idx) => { const r = JSON.parse(StorageManager.getRaw(KEYS.scores)).find(x => x.testId === testId && x.studentIndex === idx); return r ? { stage: r.stage, s10: r.score10, pass: Object.values(r.passData).filter(v => v === 1).length } : null; }, testId, target);
                const badgeAll = await page.evaluate((idx) => document.getElementById('rec-nw-grade-' + idx).textContent, target);
                check(tname + ' / ' + vname + ': 最後のほうの児童(' + (target + 1) + '番)の全' + D.total + '技を、実際にタップして選べる(段階=' + D.total + '・10点換算=' + D.score10(D.total) + '・級=' + D.label(D.total) + ')',
                    t1.ids === D.total && t1.missed === 0 && rec && rec.stage === D.total && rec.pass === D.total && rec.s10 === D.score10(D.total) && badgeAll === D.label(D.total), JSON.stringify({ t1, rec, badgeAll }));
                const t2 = await tapAll(testId, target, D.total, true);
                await sleep(700);
                const after = await page.evaluate(() => StorageManager.getRaw(KEYS.scores));
                check(tname + ' / ' + vname + ': もう一度全部タップすると元に戻り、他の児童の記録を含む保存内容が最初と1バイトも違わない', t2.missed === 0 && after === before, t2.missed + '個届かず / ' + (after === before ? '同一' : '差あり'));
            }
        }

        // ================= C. 一覧を開いても記録は変わらない・v1.38.0 の構造・検定でない一覧への影響なし =================
        await setVp(1180, 820);
        const rawNow = await page.evaluate(() => StorageManager.getRaw(KEYS.scores));
        check('一覧の表示・スクロールだけでは、保存された記録は変わらない(全サイズ・両方の検定を開いたあとも、最初の保存内容と同一)', rawNow === rawBefore, '');

        await selectTest(1);
        const st = await page.evaluate(() => {
            const list = document.getElementById('recList'), view = document.getElementById('view-records');
            const rectOf = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.left), Math.round(b.width), Math.round(b.height)].join(','); };
            const fixedEls = ['.rec-subnav', '#recInputTestSelect', '.rec-test-selector'].map(s => document.querySelector('#view-records ' + s)).filter(Boolean);
            const before = fixedEls.map(rectOf);
            list.scrollTop = list.scrollHeight;
            const after = fixedEls.map(rectOf);
            return { fixed: before.length, moved: before.filter((b, i) => b !== after[i]).length, listScrolls: list.scrollHeight > list.clientHeight + 1, outerScrolls: view.scrollHeight > view.clientHeight + 1, lastVisible: (() => { const cards = list.querySelectorAll('.rec-nawatobi-card'); const l = cards[cards.length - 1].getBoundingClientRect(), lr = list.getBoundingClientRect(); return l.bottom <= lr.bottom + 0.5; })() };
        });
        check('v1.38.0 の構造: 一覧だけが内側でスクロールし(30人)、外側の画面は動かず、ヘッダー・課題選択の位置も動かない。最後の児童のカードが下まで見える',
            st.listScrolls && !st.outerScrolls && st.moved === 0 && st.fixed >= 2 && st.lastVisible, JSON.stringify(st));

        await selectTest(3);
        const normal = await page.evaluate(() => { const list = document.getElementById('recList'); return { nw: list.classList.contains('nw-mode'), rows: getComputedStyle(list).gridAutoRows, rowsN: list.querySelectorAll('.rec-row').length }; });
        check('検定でない課題(小テスト)の一覧は、検定カード用の指定の影響を受けない(nw-mode なし・grid-auto-rows は auto のまま・30人の行)', !normal.nw && normal.rows === 'auto' && normal.rowsN === N, JSON.stringify(normal));
        await selectTest(1);
        const swAgain = await page.evaluate(() => getComputedStyle(document.getElementById('recList')).gridAutoRows);
        check('検定に戻ると、行の高さは中身の高さ(max-content)になる', swAgain === 'max-content' || /^\d/.test(swAgain), swAgain);

        const sw = await page.evaluate(async () => (await (await fetch('./sw.js?nocache=' + Date.now())).text()).match(/CACHE_VERSION = '([^']*)'/)[1]);
        check('sw.js の CACHE_VERSION が v1.62.0', sw === 'v1.62.0', sw);
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== kentei-card-reach: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
