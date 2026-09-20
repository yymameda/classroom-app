// 診断の情報表示「まとめテスト … 全問が単一観点(観点不均衡の可能性)」の見直し(v1.55.1)と、
// L9(v1.59.1): 単元テストを単一観点の判定から外す・観点語のない名前の文言変更・内訳表(課題名と種別の列・赤印なし)・サマリーのラベル(まとめ形式の内訳)。
// 表示だけの変更で、課題・記録・設問・名簿は変えない。
//   先生は観点ごとにまとめテストを分けて作っている(例「まテ_1学期　思考」)ので、課題名がちょうど1つの観点を示し、全問がその観点なら、意図どおりとして表示しない。
//   名前が示す観点と全問の観点が違う・名前に観点の語が無い場合は、これまでどおり表示する(違う場合はその旨を添える)。読み取り専用のまま。
//   (作成時の観点設定はテストに保存されていない=「観点一括」ボタンは各設問の観点を書き込むだけ。課題名だけが手がかり)
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node audit-matome-perspective.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const backup = await page.evaluate(() => [StorageManager.getRaw(KEYS.master), StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores), StorageManager.getRaw(KEYS.matome_questions)]);

    // まとめテスト: types は各設問の観点(知・思・主)、points は配点
    const M = (id, name, types, extra) => Object.assign({ id, subject: '体育', testType: 'まとめテスト', type: 'matome', name, category: '複合', maxScore: 0, date: '2026-06-23', matomePoints: types.map(() => 2), matomeQuestionTypes: types, matomeQCount: types.length }, extra || {});
    const tests = [
        M(1, 'まテ_1学期　思考', ['思', '思', '思']),
        M(2, 'まテ_1学期　知識', ['知', '知']),
        M(3, 'まテ_2学期　主体性', ['主', '主']),
        M(4, 'まテ_1学期　態度', ['主', '主']),
        M(5, 'まテ_1学期　思考(名前だけ思考)', ['知', '知', '知']),
        M(6, 'まテ_1学期　知識・思考', ['知', '知']),
        M(7, 'まテ_単元のまとめ', ['知', '知']),
        M(8, 'まテ_1学期　思考と知識', ['思', '思', '知', '主']),
        M(9, 'まテ_1学期　技能', ['知', '知']),
        M(10, 'まテ_表現運動', ['思', '思']),
        M(11, '設問なし', [], { matomePoints: [], matomeQuestionTypes: [], matomeQCount: 0 }),
        M(12, 'まテ_2学期　判断(設問は別ストア)', [], { matomePoints: [], matomeQuestionTypes: [], matomeQCount: 0 }),
        // L9: 単元テスト(type は matome)。全問が知識でも単一観点の判定の対象にしない(課題名に観点の語が無くても・あっても)
        M(13, '単元_かけ算', ['知', '知', '知'], { testType: '単元テスト' }),
        M(14, '単元_思考力を問う', ['知', '知'], { testType: '単元テスト' }),
        M(15, '単元_設問なし', [], { testType: '単元テスト', matomePoints: [], matomeQuestionTypes: [], matomeQCount: 0 }),
        // まとめテストでも単元テストでもない種別の matome(旧データなど)と、通常のテスト(matome ではない)
        M(16, '旧形式テスト', ['知', '思'], { testType: 'その他' }),
        { id: 17, subject: '国語', testType: '小テスト', type: 'standard', name: '漢字小テスト', category: '知識・技能', maxScore: 10, date: '2026-06-23' }
    ];
    const qstore = { 12: [{ points: 3, type: '思' }, { points: 3, type: '思' }] };
    try {
        await page.evaluate((tests, qstore) => {
            StorageManager.setImmediate(KEYS.master, JSON.stringify({ version: 2, students: [{ name: '甲' }, { name: '乙' }], classInfo: { year: 2026, grade: 5, class: 1, termSystem: 3 } }));
            StorageManager.setImmediate(KEYS.tests, JSON.stringify(tests));
            StorageManager.setImmediate(KEYS.scores, '[]');
            StorageManager.setImmediate(KEYS.matome_questions, JSON.stringify(qstore));
        }, tests, qstore);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(300);
        const before = await page.evaluate(() => [StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores), StorageManager.getRaw(KEYS.matome_questions), StorageManager.getRaw(KEYS.master)]);
        const spy = await page.evaluate(async () => {
            let n = 0; const o = Storage.prototype.setItem, r = Storage.prototype.removeItem;
            Storage.prototype.setItem = function() { n++; return o.apply(this, arguments); }; Storage.prototype.removeItem = function() { n++; return r.apply(this, arguments); };
            try { showView('export'); runAuditDiagnosis(); await new Promise(res => setTimeout(res, 900)); } finally { Storage.prototype.setItem = o; Storage.prototype.removeItem = r; }
            const r2 = window._auditDiagnosisLastResult;
            return { writes: n, info: r2.anomalies.info, warn: r2.anomalies.warn, kinds: r2.dataVolume.matomeKinds, balanceKinds: r2.matomeBalance.kinds, perTest: r2.matomeBalance.perTest.map(p => [p.testId, p.name, p.total, p.testType]) };
        });
        const info = spy.info.filter(i => /(まとめテスト|単元テスト) testId=/.test(i) && /単一観点|観点ですが|同じ観点です/.test(i));
        const has = (id) => info.filter(i => i.indexOf('testId=' + id + ' ') !== -1 || i.indexOf('testId=' + id + ':') !== -1);
        check('課題名が「思考」で全問が思考: 意図どおりとして表示しない(「まテ_1学期　思考」)', has(1).length === 0, JSON.stringify(has(1)));
        check('課題名が「知識」で全問が知識・「技能」で全問が知識・技能の観点: 表示しない', has(2).length === 0 && has(9).length === 0, '');
        check('課題名が「主体性」「態度」で全問が主体性: 表示しない', has(3).length === 0 && has(4).length === 0, '');
        check('設問が別ストア(matome_questions)にあるまとめテストも同じく判定する(課題名「判断」で全問が思考: 表示しない)', has(12).length === 0, JSON.stringify(has(12)));
        check('課題名が「思考」なのに全問が知識: 表示する(観点の付け間違いの可能性)と、名前と全問の観点が違う旨を添える', has(5).length === 1 && /全問が「知識・技能」の観点ですが、課題名は「思考・判断・表現」を示しています/.test(has(5)[0]), JSON.stringify(has(5)));
        check('課題名に複数の観点(知識・思考)があり全問が知識: 表示する(単一の観点を示していないため)', has(6).length === 1 && /課題名は「知識・技能・思考・判断・表現」を示しています/.test(has(6)[0]), JSON.stringify(has(6)));
        check('課題名に観点の語が無く全問が単一観点: 表示する(課題名つき。文言は「全問が同じ観点です。観点ごとに分けて作ったテストならこのままで問題ありません」)', has(7).length === 1 && /全問が同じ観点です。観点ごとに分けて作ったテストならこのままで問題ありません/.test(has(7)[0]) && !/観点不均衡/.test(has(7)[0]) && /「まテ_単元のまとめ」/.test(has(7)[0]), JSON.stringify(has(7)));
        check('観点が混ざっているまとめテスト(思・知・主)は、単一観点ではないので表示しない', has(8).length === 0, JSON.stringify(has(8)));
        check('課題名の「表現」が観点の語として働き、全問が思考なら表示しない(表現運動など。意図どおりの判定)', has(10).length === 0, JSON.stringify(has(10)));
        check('設問のない課題(合計0)は表示しない', has(11).length === 0, '');
        check('情報の一覧に載るまとめテストの単一観点の行は、上の3件(5・6・7)だけ', info.length === 3, String(info.length) + JSON.stringify(info.map(i => i.slice(0, 30))));
        check('診断の結果(観点バランス)に、課題名が入る(氏名は含まれない)', spy.perTest.some(p => p[1] === 'まテ_1学期　思考'), JSON.stringify(spy.perTest.slice(0, 2)));
        // ---- L9(v1.59.1) ----
        check('単元テストは単一観点の判定から除外する(課題名に観点の語が無い「単元_かけ算」・名前が思考で全問が知識の「単元_思考力を問う」とも表示しない)', has(13).length === 0 && has(14).length === 0 && !info.some(i => /単元テスト testId=/.test(i)), JSON.stringify(info.map(i => i.slice(0, 40))));
        check('種別は診断の結果(内訳)に入る(まとめテスト・単元テスト・その他)', spy.perTest.find(p => p[0] === 13)[3] === '単元テスト' && spy.perTest.find(p => p[0] === 1)[3] === 'まとめテスト' && spy.perTest.find(p => p[0] === 16)[3] === 'その他', JSON.stringify(spy.perTest.filter(p => [1, 13, 16].indexOf(p[0]) >= 0)));
        check('まとめ形式の内訳: 全体16件＝まとめテスト12＋単元テスト3＋その他1(通常のテストは含めない)', JSON.stringify(spy.kinds) === JSON.stringify({ total: 16, matome: 12, unit: 3, other: 1 }) && JSON.stringify(spy.balanceKinds) === JSON.stringify(spy.kinds), JSON.stringify(spy.kinds));
        // 注: 警告「まとめ形式のテスト…のうち問題定義のないもの N件」は L10(v1.60.0)で出るようになった(audit-matome-noq-warning.test.js で確認)。ここでは画面の構造の行で件数を見る。
        const ui = await page.evaluate(() => {
            const root = document.getElementById('audit-result-container');
            const rows = Array.from(root.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(c => c.textContent.trim()));
            const h4 = Array.from(root.querySelectorAll('h4')).map(e => e.textContent.trim());
            const sum = Array.from(root.querySelectorAll('summary')).map(e => e.textContent.trim());
            const balanceHead = Array.from(root.querySelectorAll('tr')).find(tr => Array.from(tr.children).some(c => c.textContent.trim() === '課題名'));
            const balanceTable = balanceHead && balanceHead.closest('table');
            return {
                total: (rows.find(r => r[0] === 'テスト総数') || [])[1], h4, sum, text: root.textContent,
                head: balanceHead ? Array.from(balanceHead.children).map(c => c.textContent.trim()) : null,
                balanceRows: balanceTable ? Array.from(balanceTable.querySelectorAll('tr')).slice(1).map(tr => Array.from(tr.children).map(c => c.textContent.trim())) : [],
                redInBalance: balanceTable ? balanceTable.querySelectorAll('.audit-status-error').length : -1,
                noQRow: (rows.find(r => /問題定義なし/.test(r[0]) && /まとめ/.test(r[0])) || [])[0],
                noQVal: (rows.find(r => /問題定義なし/.test(r[0]) && /まとめ/.test(r[0])) || [])[1]
            };
        });
        check('診断の画面: テスト総数は「17件（うち まとめ形式 16件＝まとめテスト12＋単元テスト3＋その他1）」(旧表記「まとめテスト: N件」は出ない)', ui.total === '17件（うち まとめ形式 16件＝まとめテスト12＋単元テスト3＋その他1）' && ui.text.indexOf('(まとめテスト: ') === -1, String(ui.total));
        check('診断の画面: 5章の見出しと件数・内訳の見出し・問題定義なしの行が「まとめ形式(まとめテスト・単元テスト)」に揃っている(旧「各まとめテストの内訳」は出ない)', ui.h4.some(h => h === '5. まとめ形式テスト(まとめテスト・単元テスト)の観点バランス') && ui.text.indexOf('まとめ形式 16件＝まとめテスト12＋単元テスト3＋その他1') !== -1 && ui.sum.some(t => t === '各まとめ形式テスト(まとめテスト・単元テスト)の内訳を表示') && ui.text.indexOf('各まとめテストの内訳') === -1 && /まとめ形式テスト\(まとめテスト・単元テスト\)問題定義なし/.test(ui.noQRow || '') && ui.noQVal === '2件', JSON.stringify({ h4: ui.h4.slice(4, 6), sum: ui.sum, noQ: ui.noQRow }));
        check('内訳の表: 列は「testId・課題名・種別・知・思・主・未設定・合計」で、行に課題名と種別が出る(単元テスト「単元_かけ算」・まとめテスト「まテ_1学期　思考」)', JSON.stringify(ui.head) === JSON.stringify(['testId', '課題名', '種別', '知', '思', '主', '未設定', '合計']) && ui.balanceRows.length === 16 && ui.balanceRows.some(r => r[0] === '13' && r[1] === '単元_かけ算' && r[2] === '単元テスト') && ui.balanceRows.some(r => r[0] === '1' && r[1] === 'まテ_1学期　思考' && r[2] === 'まとめテスト'), JSON.stringify(ui.head) + ' rows=' + ui.balanceRows.length);
        check('内訳の表: 全問が単一観点の行(知だけ・思だけ)にも赤い「❌全問単一観点」の印は出ない(合計の欄は数字だけ)', ui.redInBalance === 0 && ui.text.indexOf('❌全問単一観点') === -1 && ui.balanceRows.find(r => r[0] === '2')[7] === '4' && ui.balanceRows.find(r => r[0] === '13')[7] === '6', 'red=' + ui.redInBalance + ' ' + JSON.stringify(ui.balanceRows.find(r => r[0] === '2')));
        // コピー用テキストにも同じラベルが出る
        const copied = await page.evaluate(async () => {
            window.__copied = null;
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }, configurable: true });
            copyAuditResultAsText();
            await new Promise(r => setTimeout(r, 200));
            return window.__copied;
        });
        check('コピー用テキスト: 「テスト総数: 17件（うち まとめ形式 16件＝…）」・問題定義なし・観点バランスの見出しが同じ言い方(旧「まとめテスト: N件」「まとめテスト数」は出ない)', !!copied && copied.indexOf('テスト総数: 17件（うち まとめ形式 16件＝まとめテスト12＋単元テスト3＋その他1）') !== -1 && copied.indexOf('まとめ形式テスト(まとめテスト・単元テスト)問題定義なし: 2件') !== -1 && copied.indexOf('【まとめ形式テスト(まとめテスト・単元テスト)の観点バランス】') !== -1 && copied.indexOf('(まとめテスト: ') === -1 && copied.indexOf('まとめテスト数') === -1, (copied || '').split('\n').filter(l => /テスト総数|問題定義|観点バランス/.test(l)).join(' | '));
        const after = await page.evaluate(() => [StorageManager.getRaw(KEYS.tests), StorageManager.getRaw(KEYS.scores), StorageManager.getRaw(KEYS.matome_questions), StorageManager.getRaw(KEYS.master)]);
        check('読み取り専用: 診断の間、localStorage への書き込み・削除が0回で、課題・記録・設問・名簿が1バイトも変わらない', spy.writes === 0 && JSON.stringify(before) === JSON.stringify(after), 'writes=' + spy.writes);
        // 画面にも同じ内容が出る(情報の欄)
        const html = await page.evaluate(() => document.getElementById('audit-result-container').textContent);
        check('診断の画面: 意図どおりの「まテ_1学期　思考」は情報の欄に出ず、付け間違いの可能性の行は出る', html.indexOf('testId=1782173422503') === -1 && /課題名は「思考・判断・表現」を示しています/.test(html), '');
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { ['master', 'tests', 'scores', 'matome_questions'].forEach((k, i) => { if (b[i] === null) StorageManager.remove(KEYS[k]); else StorageManager.setImmediate(KEYS[k], b[i]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== audit-matome-perspective: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
