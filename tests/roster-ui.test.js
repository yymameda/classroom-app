// H4 案B 段階3: 名簿編集UI(設定画面のリスト編集・退避中の児童・取り消し)の E2E テスト。
// すべて実際のタップ・入力(page.click / keyboard.type)で操作し、保存後のデータを直接読んで検証する。
//
//   A. 6操作(変更なし・並べ替え・途中削除・途中挿入・末尾追加・改名) × 核18ストア + 新体力テスト(pf) でずれ0
//   B. 保存後の自動再読み込み・名簿設定の画面・「元に戻す」つきトースト・取り消しボタン
//   C. 下書き(未保存の変更の保持・破棄)・バックアップを促すトースト・氏名が空の行の検証・保存失敗時
//   D. 取り消し(ボタン・トースト・入力があれば拒否)
//   E. 退避中の児童(一覧・戻す・完全削除の2回タップ・pf-residual・孤立データ)
//   F. クラス情報の保存・まとめて追加・身体データを上書きしない・空の名簿
//   G. iPad のタッチ操作: 押せる領域が 44px 以上・確認ダイアログを一度も使わない
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node roster-ui.test.js

const puppeteer = require('puppeteer-core');
const ui = require('./helpers/roster-ui');
const { buildRaws, ownersOf, misplaced, STORE_NAMES, mkStudents, OPS } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = ui.sleep;
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    let dialogs = 0;
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => { dialogs++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const INFRA = [K.roster_snapshot, K.roster_txn];

    // ---------- データの準備(核18ストア・pf・非対象キー) ----------
    const pfData = (students) => {
        const roster = [], rec26 = {}, fit26 = {};
        students.forEach((s, i) => {
            if (!s.name) return;
            roster.push({ id: i + 1, name: s.name, gender: s.gender || '', age: 10, note: 'n' + i });
            rec26[String(i + 1)] = { 握力: 20 + i, _owner: s.studentId };
            fit26[String(i + 1)] = { total: 30 + i, eval: 'B', year: 2026, detail: {}, _owner: s.studentId };
        });
        return { pf_roster: JSON.stringify(roster), pf_records_2026: JSON.stringify(rec26), pf_fitness_2026: JSON.stringify(fit26), pf_setting: JSON.stringify({ year: 2026, grade: 5 }) };
    };
    async function seed(n, opts) {
        opts = opts || {};
        const students = mkStudents(n === undefined ? 6 : n);
        const raws = buildRaws(K, students);
        if (opts.orphan) { const a = JSON.parse(raws[K.scores]); a.push({ id: 99, studentIndex: 42, testId: 1, score: 1, _owner: 'orphan' }); raws[K.scores] = JSON.stringify(a); }
        const pf = students.length ? Object.assign(pfData(students), opts.pf || {}) : {};
        const extras = { [K.tests]: '[{"id":1,"subject":"算数","name":"t","category":"知識・技能","maxScore":100,"date":"2026-05-10","term":"1"}]', 'doc-index-v1': 'other-app' };
        await page.evaluate((K, raws, extras, pf, students) => {
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).concat(Object.keys(extras)).forEach(k => storageVerifiedWrite(k, raws[k] !== undefined ? raws[k] : extras[k]));
            Object.keys(pf).forEach(k => storageVerifiedWrite(k, pf[k]));
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: '担任', termSystem: 3, term2Start: '09-01', term3Start: '01-01' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
        }, K, raws, extras, pf, students);
        return { students, raws };
    }
    // データを入れて再読み込みし、設定画面を開く(実際の起動から始める)
    async function openFresh(n, opts) {
        const s = await seed(n, opts);
        await page.reload({ waitUntil: 'networkidle0' });
        await sleep(500);
        await ui.openSettings(page);
        await page.evaluate(() => { window.__marker = 1; });
        return s;
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (pre, post) => Array.from(new Set(Object.keys(pre).concat(Object.keys(post)))).filter(k => INFRA.indexOf(k) === -1 && !NOISE.test(k) && pre[k] !== post[k]);
    const masterOf = (d) => JSON.parse(d[K.master]);
    const pfBad = (d, newStudents) => { const bad = []; ['pf_records_2026', 'pf_fitness_2026'].forEach(key => { const o = JSON.parse(d[key] || '{}'); Object.keys(o).forEach(id => { const s = newStudents[Number(id) - 1]; if (!s || o[id]._owner !== s.studentId) bad.push(key + '#' + id); }); }); return bad; };
    const coreBad = (d, ids, newStudents) => { const m = misplaced(ownersOf(K, d, ids), newStudents); return STORE_NAMES.filter(n => m[n].shifted !== 0); };
    const marker = () => page.evaluate(() => window.__marker === 1);
    const activeView = () => page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    const heading = () => page.evaluate(() => document.getElementById('archiveHeading').textContent);
    const setInput = (sel, text) => ui.setInput(page, sel, text);

    try {
        // ================= 表示 =================
        console.log('--- 表示: リスト編集UI ---');
        let s = await openFresh();
        check('名簿は6行のリストで表示され、氏名・性別が入っている(旧テキスト欄は無い)', (await ui.rowCount(page)) === 6 && (await ui.rowNames(page))[0] === '児童0' && await page.evaluate(() => !document.getElementById('masterRoster') && document.querySelector('#rosterEditor select[data-act="gender"]').value === '男'), JSON.stringify(await ui.rowNames(page)));
        check('退避中の児童の欄が表示される(0名)', (await heading()).indexOf('退避中の児童 0名') !== -1, await heading());

        // ================= A. 6操作 × 18ストア + pf =================
        console.log('--- A. 6操作をUIで実行 → 核18ストア + pf でずれ0 ---');
        const UI_OPS = [
            { i: 0, run: async () => {} },
            { i: 1, run: async () => { await ui.act(page, 'down', 0); } },
            { i: 2, run: async () => { await ui.act(page, 'del', 1); } },
            { i: 3, run: async () => { await ui.act(page, 'insert', 1); await ui.setName(page, 2, '転入生'); await ui.setGender(page, 2, '男'); } },
            { i: 4, run: async () => { await ui.act(page, 'insert', 5); await ui.setName(page, 6, '転入生'); await ui.setGender(page, 6, '男'); } },
            { i: 5, run: async () => { await ui.setName(page, 1, '児童1（改名）'); } }
        ];
        for (const uo of UI_OPS) {
            const op = OPS[uo.i];
            s = await openFresh();
            const ids = s.students.map(x => x.studentId);
            const pre = await dump();
            const expected = op.make(s.students);
            await uo.run();
            await ui.clickSave(page);
            if (uo.i === 0) {
                check(op.name + '(UI): 「変更はありません」・再読み込みなし・全キー不変', await ui.toastHas(page, '変更はありません') && await marker() && diffKeys(pre, await dump()).length === 0, '');
                continue;
            }
            await ui.waitReload(page);
            const post = await dump();
            const m = masterOf(post).students;
            check(op.name + '(UI): 保存後に自動で再読み込みされ、名簿設定の画面が開く', !(await marker()) && (await activeView()) === 'view-settings', String(await activeView()));
            check(op.name + '(UI): 名簿の氏名・順序・studentId が期待どおり(既存は同じID、転入生は新しいID)・属性(身長)が残る', m.length === expected.length && m.every((x, j) => x.name === expected[j].name && (expected[j].studentId ? x.studentId === expected[j].studentId && x.height === expected[j].height : /^stu_[a-z0-9]{8}$/.test(x.studentId))), JSON.stringify(m.map(x => [x.name, x.studentId])));
            check(op.name + '(UI): 核となる18ストアがすべてずれ0', coreBad(post, ids, m).length === 0, JSON.stringify(coreBad(post, ids, m)));
            check(op.name + '(UI): 新体力テスト(pf)の記録・集計もずれ0で、pf_roster も新しい名簿と一致する', pfBad(post, m).length === 0 && JSON.parse(post.pf_roster).map(e => e.name).join() === m.filter(x => x.name).map(x => x.name).join(), JSON.stringify(pfBad(post, m)));
            check(op.name + '(UI): 再読み込み後に「元に戻す」つきのトーストと、取り消しボタンが出る', await ui.toastHas(page, '名簿を更新しました', 5000) && await page.evaluate(() => document.getElementById('toastUndoBtn').style.display !== 'none' && !!document.getElementById('rosterUndoBtn')), '');
            check(op.name + '(UI): 課題・別アプリ等の非対象キーは1バイトも変わらない', pre[K.tests] === post[K.tests] && pre['doc-index-v1'] === post['doc-index-v1'], '');
        }

        // ================= C. 下書き・バックアップ促し・検証・失敗 =================
        console.log('--- C. 下書き・バックアップを促すトースト・検証・保存失敗 ---');
        s = await openFresh();
        await ui.act(page, 'down', 0);
        check('最初の変更でバックアップを促すトーストが出る(操作は止まらず、下書きに反映される)', await ui.toastHas(page, 'バックアップを取っておくと安心') && (await ui.rowNames(page))[0] === '児童1', '');
        check('未保存の変更の帯(変更を破棄・バックアップを取る)が出る', await page.evaluate(() => !!document.getElementById('rosterDirtyBanner') && document.getElementById('rosterDirtyBanner').textContent.indexOf('未保存') !== -1), '');
        await page.evaluate(() => { showView('dashboard'); });
        await sleep(200);
        await ui.openSettings(page);
        check('画面を切り替えても下書き(未保存の変更)は保持される', (await ui.rowNames(page))[0] === '児童1', JSON.stringify(await ui.rowNames(page)));
        await ui.act(page, 'discard');
        check('「変更を破棄」で元に戻り、帯が消える(データは一度も変わっていない)', (await ui.rowNames(page))[0] === '児童0' && await page.evaluate(() => !document.getElementById('rosterDirtyBanner')), '');
        // 直近にバックアップ済みなら促さない
        s = await seed();
        await page.evaluate((K) => { StorageManager.setImmediate(K.backup_meta, JSON.stringify({ lastExportAt: new Date().toISOString(), encrypted: false })); }, K);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(500); await ui.openSettings(page);
        await ui.act(page, 'down', 0);
        check('直近10分以内にバックアップ済みなら、促すトーストは出さない', !(await ui.toastHas(page, 'バックアップを取っておくと安心', 600)), '');
        // 氏名が空の行は保存しない
        s = await openFresh(); const pre1 = await dump();
        await ui.act(page, 'insert', 5);
        await ui.clickSave(page);
        check('氏名が空の行があると保存せず、その行を赤枠にしてトーストで知らせる(データ不変・再読み込みなし)', await ui.toastHas(page, '氏名が空の行があります') && await page.evaluate(() => !!document.querySelector('#rosterEditor .rl-row.rl-err')) && await marker() && diffKeys(pre1, await dump()).length === 0, '');
        // 保存の失敗(容量超過): データは変わらず、下書きは残り、失敗を知らせる
        s = await openFresh(); const pre2 = await dump();
        await ui.act(page, 'del', 1);
        await page.evaluate((K) => { const o = Storage.prototype.setItem; window.__o = o; Storage.prototype.setItem = function(k, v) { if (k === K.roster_snapshot) throw new DOMException('quota', 'QuotaExceededError'); return o.apply(this, arguments); }; }, K);
        await ui.clickSave(page);
        await page.evaluate(() => { Storage.prototype.setItem = window.__o; });
        check('保存に失敗(容量超過)したら、名簿変更を中止し「データは変更されていません」と知らせる', await ui.toastHas(page, 'データは変更されていません') && diffKeys(pre2, await dump()).length === 0 && await marker(), '');
        check('  → 下書き(削除予定の行と帯)は残り、そのまま再度保存できる', await page.evaluate(() => !!document.querySelector('#rosterEditor .rl-row.rl-deleted') && !!document.getElementById('rosterDirtyBanner')), '');
        await ui.clickSave(page); await ui.waitReload(page);
        check('  → 再度の保存は成功する(名簿は5名・退避に1名)', masterOf(await dump()).students.length === 5 && (await heading()).indexOf('退避中の児童 1名') !== -1, await heading());

        // ================= D. 取り消し =================
        console.log('--- D. 取り消し ---');
        s = await openFresh(); const preD = await dump();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        await page.click('#rosterUndoBtn');
        await ui.waitReload(page);
        const postD = await dump();
        check('取り消しボタン: 名簿・核データ・pf がすべて変更前に戻り、退避も空になる(確認ダイアログなし)', diffKeys(preD, postD).length === 0 && (await heading()).indexOf('退避中の児童 0名') !== -1 && await page.evaluate(() => !document.getElementById('rosterUndoBtn')), JSON.stringify(diffKeys(preD, postD)));
        s = await openFresh(); const preD2 = await dump();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        await ui.toastHas(page, '名簿を更新しました', 5000);
        await page.click('#toastUndoBtn');
        await ui.waitReload(page);
        check('トーストの「元に戻す」からも取り消せる', diffKeys(preD2, await dump()).length === 0, '');
        s = await openFresh();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        await page.evaluate((K) => { const a = JSON.parse(localStorage.getItem(K.scores)); a.push({ id: 500, studentIndex: 0, testId: 2, score: 9, _owner: 'new' }); storageVerifiedWrite(K.scores, JSON.stringify(a)); renderRosterUi(); }, K);
        check('名簿変更のあとに入力があると、取り消しボタンは表示されない', await page.evaluate(() => !document.getElementById('rosterUndoBtn')), '');
        const refused = await page.evaluate(() => rosterUndoClick());
        check('  → それでも取り消しを試みると、取り消さずトーストで理由が出る(データ不変)', await ui.toastHas(page, '取り消せません') && (await heading()).indexOf('退避中の児童 1名') !== -1, '');

        // ================= E. 退避中の児童 =================
        console.log('--- E. 退避中の児童(一覧・戻す・完全削除・pf-residual・孤立データ) ---');
        s = await openFresh(); const idsE = s.students.map(x => x.studentId); const preE = await dump();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        check('削除した児童が「退避中の児童 1名」に、氏名つきで一覧される', (await heading()).indexOf('退避中の児童 1名') !== -1 && await page.evaluate(() => document.getElementById('archiveList').textContent.indexOf('児童1') !== -1), await heading());
        await page.click('#archiveList button[data-act="restore"]');
        await ui.waitReload(page);
        const postE = await dump(); const mE = masterOf(postE).students;
        check('「戻す」: 名簿の末尾に同じ児童IDで戻り、全18ストアと pf もずれ0(削除→復元でデータを失わない)', mE.length === 6 && mE[5].studentId === idsE[1] && mE[5].name === '児童1' && coreBad(postE, idsE, mE).length === 0 && pfBad(postE, mE).length === 0 && ownersOf(K, postE, idsE).scores.some(e => e.owner === idsE[1] && e.idx === 5), JSON.stringify(coreBad(postE, idsE, mE)));
        check('  → 復元後は退避が0名になり、名簿設定の画面が開く', (await heading()).indexOf('退避中の児童 0名') !== -1 && (await activeView()) === 'view-settings', await heading());
        // 完全削除は同じボタンを2回タップ(確認ダイアログではない)
        s = await openFresh();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        const preP = await dump();
        await page.click('#archiveList button[data-act="purge"]');
        check('完全削除: 1回目のタップでは削除されず、ボタンが「もう一度タップで完全に削除」に変わる', await page.evaluate(() => document.querySelector('#archiveList button[data-act="purge"]').textContent.indexOf('もう一度タップ') !== -1) && diffKeys(preP, await dump()).length === 0, '');
        await page.click('#archiveList button[data-act="purge"]');
        await sleep(200);
        check('完全削除: 2回目のタップで削除され、退避が0名になる(削除した児童は名簿にも戻らない)', (await heading()).indexOf('退避中の児童 0名') !== -1 && !(JSON.parse((await dump())[K.student_archive] || '{"entries":[]}').entries.length) && await ui.toastHas(page, '完全に削除しました'), '');
        // pf の名簿が食い違った状態で戻す → pf の分だけ退避に残る(完全削除のみ可能)
        s = await openFresh();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        await page.evaluate(() => { const r = JSON.parse(localStorage.getItem('pf_roster')); r.reverse(); localStorage.setItem('pf_roster', JSON.stringify(r)); });
        await page.click('#archiveList button[data-act="restore"]');
        await ui.waitReload(page);
        const resid = await page.evaluate(() => Array.from(document.querySelectorAll('#archiveList .ar-row')).map(r => ({ text: r.textContent, hasRestore: !!r.querySelector('button[data-act="restore"]'), hasPurge: !!r.querySelector('button[data-act="purge"]') })));
        check('pf名簿が不一致のまま戻すと、児童は戻り、pf の分は「新体力テストの記録のみ」として退避に残る(戻すボタンなし・完全削除のみ)', resid.length === 1 && /新体力テストの記録のみ/.test(resid[0].text) && !resid[0].hasRestore && resid[0].hasPurge && (await heading()).indexOf('退避中の児童 0名（その他の退避データ 1件）') !== -1, JSON.stringify(resid));
        check('  → 名簿は6名に戻っている', masterOf(await dump()).students.length === 6, '');
        await page.click('#archiveList button[data-act="purge"]'); await page.click('#archiveList button[data-act="purge"]'); await sleep(200);
        check('  → pf-residual も完全削除できる', (await heading()).indexOf('退避中の児童 0名') !== -1 && (await heading()).indexOf('その他') === -1, await heading());
        // 孤立データ
        s = await openFresh(6, { orphan: true });
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        const orph = await page.evaluate(() => Array.from(document.querySelectorAll('#archiveList .ar-row')).map(r => r.textContent));
        check('孤立データ(名簿にない番号)は「名簿にない番号（43番）のデータ」として一覧され、戻すボタンは無い', orph.some(t => /名簿にない番号（43番）/.test(t)) && (await page.evaluate(() => Array.from(document.querySelectorAll('#archiveList .ar-row')).filter(r => /名簿にない番号/.test(r.textContent)).every(r => !r.querySelector('[data-act="restore"]')))), JSON.stringify(orph));
        // 未保存の変更があるあいだは戻せない(下書きを失わないため)
        s = await openFresh();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);
        await ui.act(page, 'down', 0);
        await page.click('#archiveList button[data-act="restore"]');
        check('未保存の名簿の変更があるあいだは「戻す」を実行せず、先に保存か破棄を促す(再読み込みなし)', await ui.toastHas(page, '先に、未保存の名簿の変更を保存するか破棄してください') && (await heading()).indexOf('退避中の児童 1名') !== -1, '');

        // ================= F. クラス情報・まとめて追加・身体データ・空の名簿 =================
        console.log('--- F. クラス情報・まとめて追加・身体データ・空の名簿 ---');
        s = await openFresh(); const preF = await dump();
        await setInput('#setTeacher', '新しい担任');
        await ui.clickSave(page);
        const postF = await dump();
        check('クラス情報だけの変更: 名簿は1バイトも変えず、クラス情報だけ保存される(再読み込みなし)', await ui.toastHas(page, 'クラス情報を保存しました') && await marker() && JSON.stringify(masterOf(postF).students) === JSON.stringify(masterOf(preF).students) && masterOf(postF).classInfo.teacher === '新しい担任' && diffKeys(preF, postF).join() === K.master, JSON.stringify(diffKeys(preF, postF)));
        await setInput('#setTeacher', '別の担任');
        await ui.setName(page, 1, '児童1（改名）');
        await ui.clickSave(page); await ui.waitReload(page);
        const cF = masterOf(await dump());
        check('クラス情報と名簿を同時に保存すると、1回の保存で両方が反映される', cF.classInfo.teacher === '別の担任' && cF.students[1].name === '児童1（改名）', JSON.stringify(cF.classInfo));
        // まとめて追加
        s = await openFresh(); const idsF = s.students.map(x => x.studentId);
        await page.click('#rosterBulkAdd'); await page.keyboard.type('転入A,男'); await page.keyboard.press('Enter'); await page.keyboard.type('転入B,女');
        await ui.act(page, 'bulk-add');
        check('まとめて追加: 貼り付けた氏名が末尾に転入として追加され(8行)、保存前はデータに反映されない', (await ui.rowCount(page)) === 8 && (await ui.rowNames(page)).slice(6).join() === '転入A,転入B' && masterOf(await dump()).students.length === 6, JSON.stringify(await ui.rowNames(page)));
        await ui.clickSave(page); await ui.waitReload(page);
        const pF = await dump(); const mF = masterOf(pF).students;
        check('まとめて追加を保存: 8名になり、転入生にIDが付き、既存の児童のデータはずれ0', mF.length === 8 && mF[6].gender === '男' && mF[7].gender === '女' && /^stu_/.test(mF[6].studentId) && coreBad(pF, idsF, mF).length === 0 && pfBad(pF, mF).length === 0, JSON.stringify(mF.map(x => x.name)));
        // 下書きを作ったあとに身体データが保存されても、古いコピーで上書きしない
        s = await openFresh();
        await ui.setName(page, 0, '児童0（改名）');
        await page.evaluate(() => { master.students[2].visionL = 'D'; master.students[2].height = 150; saveMaster(); });
        await ui.clickSave(page); await ui.waitReload(page);
        const mV = masterOf(await dump()).students;
        check('下書きのあとに保存された身体データ(視力・身長)を、名簿の保存で古い値に上書きしない', mV[0].name === '児童0（改名）' && mV[2].visionL === 'D' && mV[2].height === 150, JSON.stringify(mV[2]));
        // 空の名簿
        s = await openFresh(0);
        check('名簿が空のとき: 案内が表示され、「まとめて追加」で登録できる', await page.evaluate(() => document.getElementById('rosterEditor').textContent.indexOf('まだ名簿がありません') !== -1), '');
        await page.click('#rosterBulkAdd'); await page.keyboard.type('山田 太郎,男'); await page.keyboard.press('Enter'); await page.keyboard.type('鈴木 花子,女');
        await ui.act(page, 'bulk-add'); await ui.clickSave(page); await ui.waitReload(page);
        const mEmpty = masterOf(await dump()).students;
        check('  → 保存すると2名が登録され、それぞれにIDが付く', mEmpty.length === 2 && mEmpty.every(x => /^stu_[a-z0-9]{8}$/.test(x.studentId)) && mEmpty[0].name === '山田 太郎', JSON.stringify(mEmpty));

        // ================= G. iPad のタッチ操作 =================
        console.log('--- G. タッチ操作: 押せる領域 ---');
        s = await openFresh();
        await ui.act(page, 'del', 1); await ui.clickSave(page); await ui.waitReload(page);   // 退避の行も表示された状態
        await ui.act(page, 'insert', 0);
        const small = await page.evaluate(() => {
            const sel = '#rosterEditorCard button, #rosterEditorCard select, #rosterEditorCard input[type="text"], #archiveCard button';
            return Array.from(document.querySelectorAll(sel)).filter(el => el.offsetParent !== null).map(el => { const r = el.getBoundingClientRect(); return { t: (el.getAttribute('data-act') || el.id || el.tagName), h: Math.round(r.height), w: Math.round(r.width), isBtn: el.tagName === 'BUTTON' }; }).filter(x => x.h < 44 || (x.isBtn && x.w < 44));
        });
        check('名簿編集・退避・保存の全ボタンと入力欄の高さが44px以上、ボタンの幅も44px以上', small.length === 0, JSON.stringify(small.slice(0, 4)));
        check('確認ダイアログ(confirm)は、これまでの全操作で一度も使われていない', dialogs === 0, 'dialogs=' + dialogs);
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        try {
            await page.evaluate((bk) => {
                StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear();
                Object.keys(bk).forEach(k => { if (bk[k] !== null) localStorage.setItem(k, bk[k]); });
            }, realBackup);
        } catch (e) {}
        check('コンソールエラーなし(意図した障害注入のログを除く)', consoleErrors.filter(e => !/quota|Quota|容量超過|rolling back|rollback|Failed to load resource|localStorage/.test(e)).length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== roster-ui: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
