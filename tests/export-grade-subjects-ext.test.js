// データ出力の「成績処理 CSV」の教科の選択肢に、テストも提出物もない専科の教科も出す(v1.61.0)。
//   以前は、選択肢がテスト・提出物のある教科だけで、専科だけの教科(専科登録して評定だけ入れた教科)は選べなかった
//   (成績処理画面の CSV ボタンの教科の選択肢には出ていた)。
//   検査: 選択肢(本番の画面を開いたときの作り方) → 専科の教科を選んで本番のボタンを押す → 出たCSVに専科の値が入る／
//         専科でない教科の選択肢・CSVは変わらない／専科を解除した教科は選択肢から消える。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと(BASE_URL 環境変数で接続先を変えられる)
// 実行: cd tests && node export-grade-subjects-ext.test.js

const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined && detail !== '' ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

    async function seed(d) {
        await page.evaluate((K, d) => {
            const put = (k, v) => StorageManager.setImmediate(k, JSON.stringify(v));
            put(K.master, { version: 2, students: d.students, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' } });
            put(K.tests, d.tests || []); put(K.scores, d.scores || []); put(K.assigns, d.assigns || []); put(K.subs, d.subs || []);
            put(K.att, {}); put(K.weights, {}); put(K.patrol, []);
            StorageManager.remove(K.thresholds);
            if (d.ext) put(K.ext, d.ext); else StorageManager.remove(K.ext);
        }, KN, d);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(400);
        await page.evaluate(() => { window.__shared = null; window.__csv = null; window.universalShare = function(blob, name) { window.__shared = name; return blob.text().then(function(t) { window.__csv = t; }); }; });
    }
    const options = () => page.evaluate(() => { showView('export'); return Array.from(document.getElementById('expGradeSubj').options).map(o => o.value); });
    const exportGrade = (subj, term) => page.evaluate(async (subj, term) => {
        showView('export');
        const s = document.getElementById('expGradeSubj'); s.value = subj; s.dispatchEvent(new Event('change'));
        document.getElementById('expGradeTerm').value = term;
        window.__shared = null; window.__csv = null;
        document.getElementById('expGradeBtn').click();
        for (let n = 0; n < 40 && window.__csv === null; n++) await new Promise(r => setTimeout(r, 100));
        return { name: window.__shared, csv: (window.__csv || '').replace(/^﻿/, '') };
    }, subj, term);

    // 題材: 国語(テストあり)・音楽(専科・テストも提出物もない)・家庭(専科・値なし・テストも提出物もない)・図工(専科でも何もない・登録もなし)
    const tests = [{ id: 1, subject: '国語', testType: '小テスト', name: '漢字', category: '知識・技能', type: 'standard', maxScore: 10, date: '2026-05-10', term: '1', createdAt: '2026-05-10T00:00:00Z' }];
    const scores = [{ id: 101, studentIndex: 0, testId: 1, score: 8 }];
    const ext = { subjects: ['音楽', '家庭'], data: { 音楽: { '0': { k: 'A', t: 'B', a: 'A', h: 3 } } } };

    try {
        await seed({ students: [{ name: '甲' }, { name: '乙' }], tests, scores, ext });

        const o1 = await options();
        check('成績処理CSVの教科の選択肢に、テストも提出物もない専科の教科(音楽・家庭)が出る。専科登録もない教科(図工)は出ない', ['国語', '音楽', '家庭'].every(s => o1.indexOf(s) >= 0) && o1.indexOf('図工') < 0 && o1[0] === '', JSON.stringify(o1));
        check('専科でない教科(国語)の選択肢は今までどおり(選択肢の先頭の空欄と、国語が1回だけ)', o1.filter(s => s === '国語').length === 1 && o1[0] === '', JSON.stringify(o1));

        const g = await exportGrade('音楽', '1');
        const lines = g.csv.split('\n');
        check('専科の教科(音楽)を選んで本番のボタンを押すと、CSVが出る(ファイル名に教科と学期・見出しは今までどおり)', /^成績処理_音楽_1学期_/.test(g.name || '') && /^番号,氏名,評定,合計,知識ABC,思考ABC,主体ABC,知識平均,思考平均,主体平均,学期$/.test(lines[0]), String(g.name) + ' ' + lines[0]);
        check('専科の値(1学期)が入る: 甲=評定3・合計8・知A・思B・主A。乙は値がなく「未入力」', lines[1] === '1,甲,3,8,A,B,A,,,,1学期' && /^2,乙,未入力,,未入力,未入力,未入力,,,,1学期$/.test(lines[2]), lines[1] + ' | ' + lines[2]);
        const gk = await exportGrade('国語', '1');
        check('国語(専科でない)のCSVは今までどおり(1行目=甲8点の知識平均8.0)', /^成績処理_国語_1学期_/.test(gk.name || '') && gk.csv.split('\n')[1].indexOf('1,甲,') === 0, gk.csv.split('\n')[1]);
        const gh = await exportGrade('家庭', '1');
        check('専科登録だけで値のない教科(家庭)も、CSVが出て、全員「未入力」', gh.csv.split('\n').slice(1, 3).every(l => /未入力,,未入力,未入力,未入力/.test(l)), gh.csv.split('\n')[1]);

        // 専科の登録を解除(専科データを削除)したら選択肢から消える(テスト・提出物もないので)
        await page.evaluate((k) => { StorageManager.setImmediate(k, JSON.stringify({ subjects: ['家庭'], data: {} })); }, KN.ext);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
        const o2 = await options();
        check('専科の登録を外した教科(音楽)は選択肢から消え、登録が残る教科(家庭)は残る', o2.indexOf('音楽') < 0 && o2.indexOf('家庭') >= 0 && o2.indexOf('国語') >= 0, JSON.stringify(o2));
    } catch (e) {
        check('テスト実行中に例外なし', false, (e && e.stack) || String(e));
    } finally {
        await page.evaluate((b) => { Object.keys(b).forEach(k => { if (b[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, b[k]); }); }, backup).catch(() => {});
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== export-grade-subjects-ext: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
