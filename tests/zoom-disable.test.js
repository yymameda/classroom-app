// iPad の画面の拡大(ズーム)を止める(v1.61.2)。次の3種類をすべて止める。
//   1. ダブルタップでの拡大: html・body に touch-action: manipulation
//   2. 2本指のピンチでの拡大: viewport の meta に maximum-scale=1・user-scalable=no。iOS Safari は meta を無視するため、
//      gesturestart・gesturechange・gestureend を preventDefault する(passive:false・タッチ端末でのみ登録)
//   3. 入力欄を押したときの自動拡大: input・select・textarea の font-size を 16px 以上に(JS が組み立てる入力欄の inline style にも勝つ)
// 拡大したまま戻せなくなる状態を作らない: すでに拡大された状態から始まったピンチは止めない(2本指で戻せる)。
// 既存のスクロール・座席表のドラッグ(タッチ)・入力は、タッチ操作で確かめる。
// ピンチの挙動そのもの(実際の指の操作)は headless では再現できないので、iPad 実機で確認する。ここでは gesture イベントを送って
// 処理の判断(止める/止めない)を確かめる。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
//           変異テストでは BASE_URL に、書き換えたコピーの index.html を向ける
// 実行: cd tests && node zoom-disable.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// gesture イベントの登録を記録する(アプリのスクリプトより前に差し込む)
const SPY = () => {
    window.__gestureReg = [];
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
        if (/^gesture/.test(type)) window.__gestureReg.push({ type, target: this === document ? 'document' : (this === window ? 'window' : 'other'), passive: (opts && typeof opts === 'object') ? opts.passive : undefined });
        return orig.apply(this, arguments);
    };
};

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const consoleErrors = [];
    const watch = (page) => {
        page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1 && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); } });
        page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    };

    try {
        // ================= A. パソコン(タッチなし) =================
        const pn = await browser.newPage();
        watch(pn);
        await pn.evaluateOnNewDocument(SPY);
        await pn.goto(BASE_URL, { waitUntil: 'networkidle0' });
        await sleep(400);

        // ---- 1. viewport の meta ----
        const meta = await pn.evaluate(() => { const m = document.querySelector('meta[name="viewport"]'); return m ? m.getAttribute('content') : null; });
        const kv = {}; String(meta || '').split(',').forEach(p => { const a = p.split('='); if (a.length === 2) kv[a[0].trim()] = a[1].trim(); });
        check('viewport の meta: maximum-scale=1 と user-scalable=no がある', kv['maximum-scale'] === '1' || kv['maximum-scale'] === '1.0', meta);
        check('viewport の meta: user-scalable=no', kv['user-scalable'] === 'no', meta);
        check('viewport の meta: width=device-width・initial-scale=1 は変わらない', kv['width'] === 'device-width' && (kv['initial-scale'] === '1' || kv['initial-scale'] === '1.0'), meta);

        // ---- 2. touch-action ----
        const ta = await pn.evaluate(() => ({ html: getComputedStyle(document.documentElement).touchAction, body: getComputedStyle(document.body).touchAction }));
        check('html に touch-action: manipulation(ダブルタップでの拡大を止める)', ta.html === 'manipulation', ta.html);
        check('body に touch-action: manipulation', ta.body === 'manipulation', ta.body);
        // 座席表のドラッグ用の touch-action:none は、子の指定がそのまま効く(html・body の指定に上書きされない)
        const taNone = await pn.evaluate(() => { const d = document.createElement('div'); d.className = 'unassigned-btn'; document.body.appendChild(d); const v = getComputedStyle(d).touchAction; d.remove(); const e = document.createElement('div'); e.style.touchAction = 'none'; document.body.appendChild(e); const v2 = getComputedStyle(e).touchAction; e.remove(); return [v, v2]; });
        check('座席表のドラッグ用の touch-action:none(未配置ボタンの CSS・座席の inline)は、そのまま none', taNone[0] === 'none' && taNone[1] === 'none', JSON.stringify(taNone));

        // ---- 3. gesture: パソコン(タッチなし)では登録しない ----
        const regN = await pn.evaluate(() => window.__gestureReg);
        check('gesture のリスナーは、タッチ端末でないと登録しない(パソコンでは0件)', regN.length === 0, JSON.stringify(regN));

        // ---- 4. 入力欄の font-size(16px以上) ----
        // 4a. JS が組み立てる入力欄の inline style(0.8rem・12px・10px 等)にも勝つ
        const probe = await pn.evaluate(() => {
            const host = document.createElement('div');
            host.innerHTML = '<input id="__p1" style="font-size:0.8rem"><select id="__p2" style="font-size:12px"><option>a</option></select><textarea id="__p3" style="font-size:10px"></textarea>'
                + '<input type="date" id="__p4" style="font-size:13px"><input type="number" id="__p5" style="font-size:0.75rem"><input type="text" id="__p6" class="rubric-field-input"><input type="month" id="__p7" style="font-size:14px">'
                + '<input type="password" id="__p8" style="font-size:9px"><input type="checkbox" id="__p9" style="font-size:10px">';
            document.body.appendChild(host);
            const fs = {}; ['__p1', '__p2', '__p3', '__p4', '__p5', '__p6', '__p7', '__p8', '__p9'].forEach(id => { fs[id] = parseFloat(getComputedStyle(document.getElementById(id)).fontSize); });
            host.remove();
            return fs;
        });
        const probeBad = Object.keys(probe).filter(k => k !== '__p9' && probe[k] < 16);
        check('組み立てた入力欄(text・select・textarea・date・number・month・password・inline style 0.75rem〜14px)は、すべて16px以上', probeBad.length === 0, JSON.stringify(probe));
        check('チェックボックスは対象外(文字を入れない種類なので font-size を変えない)', probe.__p9 === 10, String(probe.__p9));

        // 4b. アプリの全画面(サブタブ・モーダル含む)の入力欄。30人分のデータで、行の入力欄・グリッドまで描画する
        await pn.evaluate(() => {
            const K = KEYS;
            const students = []; for (let i = 0; i < 30; i++) students.push({ studentId: 'stu_' + (10000000 + i), name: '児童' + (i + 1) + ' 太郎', number: i + 1, gender: i % 2 ? '女' : '男' });
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students, classInfo: { year: 2026, grade: 5, class: 1, teacher: '山田', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            try { localStorage.setItem('pf_roster', JSON.stringify(students.map((s, i) => ({ id: i + 1, name: s.name, gender: s.gender, age: 11, studentId: s.studentId })))); } catch (e) {}
            const T = (o) => Object.assign({ id: 0, subject: '国語', testType: '小テスト', name: 't', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-09-10', term: '2', createdAt: '2026-09-10T00:00:00Z' }, o);
            const types = ['知', '思', '主', '知', '思'];
            put(K.tests, [T({ id: 1, name: '漢字テスト' }), T({ id: 2, name: 'まとめ', testType: 'まとめテスト', type: 'matome', category: '複合', maxScore: 0, matomePoints: types.map(() => 5), matomeQuestionTypes: types, matomeQCount: 5 })]);
            const scores = []; for (let i = 0; i < 30; i++) scores.push({ id: 100 + i, studentIndex: i, testId: 1, score: 40 + ((i * 7) % 61) });
            put(K.scores, scores);
            put(K.submissions_assignments, [{ id: 101, subject: '国語', name: '宿題1', date: '2026-09-11', term: '2', createdAt: '2026-09-01T00:00:00Z' }]);
            const subs = []; for (let i = 0; i < 30; i++) subs.push({ id: 200 + i, studentIndex: i, assignmentId: 101, status: ['submitted', 'resubmit', 'missing'][i % 3], correctionDone: i % 3 === 0, createdAt: '2026-09-20T00:00:00Z' });
            put(K.submissions_data, subs);
            const seats = {}; for (let i = 0; i < 6; i++) seats['0-' + i] = i;
            put(K.seating, seats);
        });
        await pn.reload({ waitUntil: 'networkidle0' });
        await sleep(500);
        const tour = [
            () => showView('dashboard'), () => showView('quickmemo'), () => showView('settings'), () => showView('attendance'), () => showView('seating'),
            () => { showView('records'); recShowSub('input'); const s = document.getElementById('recInputTestSelect'); s.value = '1'; s.dispatchEvent(new Event('change')); },
            () => { const s = document.getElementById('recInputTestSelect'); s.value = '2'; s.dispatchEvent(new Event('change')); },
            () => recOpenMatomeModal(0),
            () => recShowSub('tests'), () => recShowSub('stats'), () => recShowSub('patrol'),
            () => { showView('submissions'); document.querySelector('#view-submissions [data-sub="input"]').click(); const s = document.getElementById('subInputAssignSel'); if (s && s.options.length > 1) { s.selectedIndex = 1; s.dispatchEvent(new Event('change')); } },
            () => document.querySelector('#view-submissions [data-sub="person"]').click(), () => document.querySelector('#view-submissions [data-sub="stats"]').click(),
            () => document.querySelector('#view-submissions [data-sub="diary"]').click(), () => document.querySelector('#view-submissions [data-sub="assign"]').click(),
            () => { showView('forgotten'); fgtShowSub('input'); }, () => fgtShowSub('student'), () => fgtShowSub('item'), () => fgtShowSub('monthly'), () => fgtShowSub('settings'),
            () => { showView('grades'); document.querySelector('#view-grades [data-sub="overview"]').click(); },
            () => document.querySelector('#view-grades [data-sub="grade"]').click(), () => document.querySelector('#view-grades [data-sub="external"]').click(),
            () => document.querySelector('#view-grades [data-sub="stats"]').click(), () => document.querySelector('#view-grades [data-sub="settings"]').click(), () => document.querySelector('#view-grades [data-sub="weights"]').click(),
            () => showView('kanji'),
            () => { showView('karte'); kvSetMode('output'); },
            () => { kvSetMode('view'); ['summary', 'records', 'learning', 'life', 'parent', 'health'].forEach(t => { const b = document.querySelector('.karte-tab-btn[data-ktab="' + t + '"]'); if (b) b.click(); }); },
            () => showView('export'),
            () => { showView('pf'); ['input', 'result', 'analysis', 'stats', 'settings'].forEach(v => document.querySelector('[data-pfview="' + v + '"]').click()); }
        ];
        let tourErr = null;
        for (let i = 0; i < tour.length; i++) {
            try { await pn.evaluate(tour[i]); } catch (e) { tourErr = 'step ' + i + ': ' + e.message; break; }
            await sleep(150);
        }
        check('全画面・サブタブ・モーダルを開いて入力欄を描画できた(例外なし)', tourErr === null, tourErr || '');
        const scan = await pn.evaluate(() => {
            const skip = ['checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'button', 'submit', 'reset', 'image'];
            const all = [...document.querySelectorAll('input, select, textarea')].filter(el => !(el.tagName === 'INPUT' && skip.indexOf((el.type || '').toLowerCase()) >= 0));
            const desc = (el) => el.tagName.toLowerCase() + (el.tagName === 'INPUT' ? '[' + el.type + ']' : '') + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '');
            const bad = all.filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(desc);
            return { n: all.length, bad: bad.slice(0, 15), badN: bad.length };
        });
        check('アプリの全画面の入力欄(text・number・date・month・select・textarea)が、すべて16px以上(' + scan.n + '個を検査)', scan.n > 300 && scan.badN === 0, scan.badN + '個が16px未満: ' + scan.bad.join(', '));
        check('検査した入力欄に、行の入力欄(点数入力・新体力の表)・まとめの設問グリッドが含まれる(件数の下限)', await pn.evaluate(() => document.querySelectorAll('.rec-row input, .rec-mq-cell input, .pf-sg-table input').length) >= 100, '');
        const sw = await pn.evaluate(async () => (await (await fetch('./sw.js?nocache=' + Date.now())).text()).match(/CACHE_VERSION = '([^']*)'/)[1]);
        // 版は「この変更を入れた v1.61.2 以上」であること(次の版に上げても、この検査は通り続ける。上げ忘れ=v1.61.1 以下は失敗する)
        const vparts = String(sw).replace(/^v/, '').split('.').map(Number);
        const swAtLeast = vparts.length === 3 && vparts.every(n => !isNaN(n)) && (vparts[0] > 1 || (vparts[0] === 1 && (vparts[1] > 61 || (vparts[1] === 61 && vparts[2] >= 2))));
        check('sw.js の CACHE_VERSION が v1.61.2 以上', swAtLeast, sw);
        await pn.close();

        // ================= B. iPad 相当(タッチあり) =================
        const pt = await browser.newPage();
        watch(pt);
        await pt.setViewport({ width: 1180, height: 820, hasTouch: true });
        await pt.evaluateOnNewDocument(SPY);
        await pt.goto(BASE_URL, { waitUntil: 'networkidle0' });
        await sleep(500);
        const touchOn = await pt.evaluate(() => ('ontouchstart' in window) || navigator.maxTouchPoints > 0);
        check('(前提)タッチ有効のページになっている', touchOn, '');

        // ---- 3. gesture: 3種類を document に passive:false で登録 ----
        const reg = await pt.evaluate(() => window.__gestureReg);
        const has = (t) => reg.filter(r => r.type === t && r.target === 'document' && r.passive === false).length;
        check('gesturestart・gesturechange・gestureend を document に passive:false で登録している(タッチ端末)', has('gesturestart') === 1 && has('gesturechange') === 1 && has('gestureend') === 1, JSON.stringify(reg));

        const fire = (type) => pt.evaluate((type) => { const e = new Event(type, { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }, type);
        const cdp = await pt.createCDPSession();
        const scale = () => pt.evaluate(() => window.visualViewport.scale);

        // ---- 5. 拡大されていない状態: ピンチ(3つのイベント)を止める ----
        const p1 = [await fire('gesturestart'), await fire('gesturechange'), await fire('gestureend')];
        check('拡大されていないとき、gesturestart・gesturechange・gestureend を止める(preventDefault)', p1.every(x => x === true), JSON.stringify(p1));

        // ---- 6. すでに拡大された状態から始まるピンチは止めない(2本指で元に戻せる。戻せなくなる状態を作らない) ----
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
        await sleep(200);
        check('(前提)ページの拡大率が 2 になっている', (await scale()) > 1.5, String(await scale()));
        const p2 = [await fire('gesturestart'), await fire('gesturechange'), await fire('gestureend')];
        check('すでに拡大されているとき(scale>1)は、gesture を止めない(2本指で縮小して戻せる)', p2.every(x => x === false), JSON.stringify(p2));
        // 拡大されたまま始まったピンチが途中で 1 倍になっても、そのピンチは最後まで止めない(途中で止めると戻しきれない)
        await fire('gesturestart');
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
        await sleep(150);
        const p2b = [await fire('gesturechange'), await fire('gestureend')];
        check('拡大から始まったピンチは、途中で1倍に戻っても最後まで止めない', p2b.every(x => x === false), JSON.stringify(p2b));
        // 1倍に戻ったあとの新しいピンチは、また止める
        const p3 = [await fire('gesturestart'), await fire('gesturechange'), await fire('gestureend')];
        check('1倍に戻ったあとの新しいピンチは、また止める(拡大できない)', p3.every(x => x === true), JSON.stringify(p3));

        // ---- 7. visualViewport が無い古い端末は止めない(戻せなくなるより安全) ----
        await pt.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => undefined }); });
        const p4 = [await fire('gesturestart'), await fire('gesturechange'), await fire('gestureend')];
        check('visualViewport が無い端末では、gesture を止めない(戻せなくなる状態を作らない)', p4.every(x => x === false), JSON.stringify(p4));
        await pt.evaluate(() => { delete window.visualViewport; });

        // ---- 8. 既存の操作: スクロール(タッチ)・座席表のドラッグ(タッチ)・入力・ボタンのタップ ----
        await pt.evaluate(() => {
            const K = KEYS;
            const students = []; for (let i = 0; i < 30; i++) students.push({ studentId: 'stu_' + (10000000 + i), name: '児童' + (i + 1) + ' 太郎', number: i + 1, gender: i % 2 ? '女' : '男' });
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students, classInfo: { year: 2026, grade: 5, class: 1, teacher: '山田', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, [{ id: 1, subject: '国語', testType: '小テスト', name: '漢字テスト', category: '知識・技能', type: 'standard', maxScore: 100, date: '2026-09-10', term: '2', createdAt: '2026-09-10T00:00:00Z' }]);
            put(K.scores, []);
            const seats = {}; for (let i = 0; i < 6; i++) seats['0-' + i] = i;
            put(K.seating, seats);
        });
        await pt.reload({ waitUntil: 'networkidle0' });
        await sleep(500);

        // 8a. 点数入力の一覧(30人分)をタッチでスクロールできる(touch-action: manipulation が、縦のスクロールを止めない)
        //     iPad 横向きの標準の高さでは30人が列に並んで収まりスクロールしないので、画面の高さを低くして、一覧がスクロールする条件で確かめる
        await pt.setViewport({ width: 1180, height: 420, hasTouch: true });
        await pt.evaluate(() => { showView('records'); recShowSub('input'); const s = document.getElementById('recInputTestSelect'); s.value = '1'; s.dispatchEvent(new Event('change')); });
        await sleep(500);
        const scroller = await pt.evaluate(() => {
            const e = document.getElementById('recList');
            if (!e || e.scrollHeight <= e.clientHeight + 100) return e ? { none: true, sh: e.scrollHeight, ch: e.clientHeight } : null;
            e.scrollTop = 0; const b = e.getBoundingClientRect();
            return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 150)), sh: e.scrollHeight, ch: e.clientHeight };
        });
        check('(前提)点数入力の一覧(30人分)にスクロールする領域がある', !!scroller && !scroller.none, JSON.stringify(scroller));
        if (scroller && !scroller.none) {
            await cdp.send('Input.synthesizeScrollGesture', { x: scroller.x, y: scroller.y, yDistance: -300, gestureSourceType: 'touch', speed: 800 });
            await sleep(400);
            const st = await pt.evaluate(() => document.getElementById('recList').scrollTop);
            check('点数入力の一覧を、指(タッチ)の縦のなぞりでスクロールできる', st > 100, 'scrollTop=' + st);
        }
        await pt.evaluate(() => { document.getElementById('recList').scrollTop = 0; });
        await pt.setViewport({ width: 1180, height: 820, hasTouch: true });
        await sleep(300);

        // 8b. 入力欄に入力できる(点数欄をタップして数字を打つ)
        const inp = await pt.$('#rec-row-0 input');
        if (inp) {
            await inp.tap();
            await pt.keyboard.type('85');
            await pt.evaluate(() => document.activeElement && document.activeElement.blur());
            await sleep(200);
            const v = await pt.evaluate(() => document.querySelector('#rec-row-0 input').value);
            check('点数欄をタップして「85」を入力できる(入力に影響なし)', v === '85', v);
        } else check('点数欄をタップして「85」を入力できる(入力に影響なし)', false, '入力欄が見つからない');
        // 入力欄を押したあとも、ページの拡大率は1のまま(自動拡大が起きない条件は 16px。実機の確認は iPad で)
        check('入力欄をタップしたあとも、ページの拡大率は 1', (await pt.evaluate(() => window.visualViewport.scale)) === 1, '');

        // 8c. 座席表のドラッグ(タッチ): 座席 0-0 の児童を 0-1 へ。入れ替わる
        await pt.evaluate(() => showView('seating'));
        await sleep(300);
        await pt.click('#seatEditBtn');
        await sleep(300);
        const names = () => pt.evaluate(() => ['0-0', '0-1', '0-2'].map(k => (document.querySelector('[data-seat="' + k + '"]').innerText || '').replace(/\s+/g, '')));
        const before = await names();
        const pos = await pt.evaluate(() => ['0-0', '0-1'].map(k => { const b = document.querySelector('[data-seat="' + k + '"]').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; }));
        await pt.touchscreen.touchStart(pos[0][0], pos[0][1]);
        await pt.touchscreen.touchMove((pos[0][0] + pos[1][0]) / 2, pos[0][1]);
        await pt.touchscreen.touchMove(pos[1][0], pos[1][1]);
        await pt.touchscreen.touchEnd();
        await sleep(400);
        const after = await names();
        check('座席表の編集で、タッチのドラッグで席を入れ替えられる(0-0 と 0-1 が入れ替わり、0-2 はそのまま)', before[0] !== before[1] && after[0] === before[1] && after[1] === before[0] && after[2] === before[2], JSON.stringify({ before, after }));
        check('ドラッグのあとも、ページの拡大率は 1', (await pt.evaluate(() => window.visualViewport.scale)) === 1, '');
        await pt.close();
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== zoom-disable: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
