// エンプティステート（v1.12.0 ②: emptyState関数）機械検証
//
// index.html の emptyState() 関数単体の挙動（既定ボタン・null抑制・
// カスタムコールバック・HTMLエスケープ）と、名簿0名時に実際の画面が
// 行き止まりにならないことを検証する。取り消し基盤（uiUndoable系）は
// tests/undo.test.js で扱うため、この節では扱わない。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
//   cd classroom-app && python3 -m http.server 8123
// 実行: cd tests && node emptystate.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:8123/index.html';

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new',
        defaultViewport: { width: 1180, height: 820 }
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') {
            const loc = msg.location() || {};
            consoleErrors.push({ text: msg.text(), url: loc.url || '' });
        }
    });
    page.on('pageerror', err => consoleErrors.push({ text: 'PAGEERROR: ' + err.message, url: '' }));

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));

    // --- 1. 既定のボタン（引数省略時）が表示され、設定タブへの遷移が仕込まれている ---
    {
        const r = await page.evaluate(() => {
            var d = document.createElement('div');
            d.innerHTML = emptyState('名簿がまだ登録されていません。');
            var b = d.querySelector('[data-ui-empty]');
            return {
                icon: !!d.querySelector('.ui-empty-icon'),
                msg: d.querySelector('.ui-empty-msg').textContent,
                label: b ? b.textContent : null,
                key: b ? b.getAttribute('data-ui-empty') : null
            };
        });
        check('既定のボタン（引数省略時）が表示され、設定タブへの遷移が仕込まれている',
            r.icon && /名簿がまだ登録されていません/.test(r.msg) && r.key === 'settings' && /名簿を登録する/.test(r.label),
            JSON.stringify(r));
    }

    // --- 2. そのボタンを実際にクリックすると設定タブに遷移する ---
    // 遷移先の観測方法: showView() は #view-<name> に .active クラスを付け外しする
    // だけの実装（index.html:5360-5364）であり、現在の画面は
    // document.getElementById('view-settings').classList.contains('active') で
    // 判定できる。他の画面遷移テスト（v1.8.49.test.js等）とも同じ観測方法。
    {
        const r = await page.evaluate(() => {
            showView('dashboard'); // 設定タブ以外を起点にする
            var host = document.getElementById('dashStudentGrid');
            host.innerHTML = emptyState('名簿がまだ登録されていません。');
            host.querySelector('[data-ui-empty]').click();
            return document.getElementById('view-settings').classList.contains('active');
        });
        check('そのボタンを実際にクリックすると設定タブに遷移する', r === true, 'active=' + r);
    }

    // --- 3. actionLabel に null を指定するとボタンが表示されない ---
    {
        const r = await page.evaluate(() => {
            var d = document.createElement('div');
            d.innerHTML = emptyState('ここに一覧が出ます。', null);
            return d.querySelectorAll('[data-ui-empty]').length;
        });
        check('actionLabelにnullを指定するとボタンが表示されない', r === 0, 'count=' + r);
    }

    // --- 4. カスタムラベルとコールバックを指定すると、そのラベルで表示されクリックでコールバックが呼ばれる ---
    {
        const r = await page.evaluate(() => {
            var hit = 0;
            var d = document.createElement('div');
            d.innerHTML = emptyState('絞り込みに当てはまる児童がいません。', 'すべて表示', function() { hit++; });
            document.body.appendChild(d); // documentへのクリック委譲(closest)を機能させるため接続する
            var btn = d.querySelector('[data-ui-empty]');
            var label = btn.textContent;
            btn.click();
            d.remove();
            return { hit: hit, label: label };
        });
        check('カスタムラベルとコールバックを指定すると、そのラベルで表示されクリックでコールバックが呼ばれる',
            r.hit === 1 && /すべて表示/.test(r.label), JSON.stringify(r));
    }

    // --- 5. メッセージにHTMLを含む文字列を渡してもエスケープされる（タグとして解釈されない） ---
    // 判定方法: innerHTML中のエスケープ済み文字列（&lt;等）の有無ではなく、
    // (a) querySelectorAll('img').length===0 で「要素として解釈されていない」こと、
    // (b) textContentに元の記号がそのまま文字として現れる（/<img src=x/が一致する）こと、
    // の2点で判定する。textContentはブラウザがエンティティを復号した後の
    // 「実際に画面に見える文字」であり、escapeHtmlの実装（&lt;を使うか等）に
    // 依存せず「タグではなく文字として見えている」ことを直接確認できるため。
    {
        const r = await page.evaluate(() => {
            var d = document.createElement('div');
            d.innerHTML = emptyState('<img src=x onerror=alert(1)>', null);
            return { imgs: d.querySelectorAll('img').length, txt: d.querySelector('.ui-empty-msg').textContent };
        });
        check('メッセージにHTMLを含む文字列を渡してもエスケープされる',
            r.imgs === 0 && /<img src=x/.test(r.txt), JSON.stringify(r));
    }

    // --- 6. 名簿0名の状態で提出物の入力タブを開いても行き止まりにならない ---
    // master（KEYS.master）は他の大半の機能が参照する実データのため、
    // in-memoryオブジェクトのJSON文字列をtry前に丸ごと退避し、finallyで
    // masterへ再代入したうえでsaveMaster()により永続化も戻す。
    // loadMaster()はストレージが空の場合に何もしない実装（index.html:5233-5247）
    // のため、ストレージキー経由ではなくmasterオブジェクト自体を退避・復元する。
    {
        const masterBackup = await page.evaluate(() => JSON.stringify(master));
        try {
            await page.evaluate(() => { master.students = []; saveMaster(); });
            const r = await page.evaluate(() => {
                showView('submissions');
                var wrap = document.getElementById('subListWrap');
                if (wrap) wrap.innerHTML = '';
                var nav = document.querySelector('#view-submissions .sub-subnav-btn[data-sub="input"]');
                if (nav) nav.click();
                return {
                    has: wrap ? !!wrap.querySelector('[data-ui-empty]') : false,
                    html: wrap ? wrap.innerHTML.slice(0, 80) : null
                };
            });
            check('名簿0名の状態で提出物の入力タブを開いても行き止まりにならない', r.has, JSON.stringify(r));
        } finally {
            await page.evaluate((raw) => { master = JSON.parse(raw); saveMaster(); }, masterBackup);
        }
    }

    // ================================================================
    // コンソールエラーなし
    // ================================================================
    const realErrors = consoleErrors.filter(e => e.url.indexOf('favicon') === -1);
    check('コンソールエラーなし（favicon 404除く）', realErrors.length === 0, JSON.stringify(realErrors));

    await browser.close();

    console.log('---');
    const failed = results.filter(r => !r.pass);
    console.log('TOTAL ' + results.length + ' / PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
    if (failed.length) {
        console.log('FAILED:');
        failed.forEach(r => console.log('  - ' + r.name + (r.detail ? ' :: ' + r.detail : '')));
        process.exit(1);
    }
})();
