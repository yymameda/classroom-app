// H4 案B 段階1: 児童ID(studentId)の付与と起動時移行。
//
// 仕様:
//   - 起動時に、studentId を持たない児童にだけ ID('stu_'+8桁)を付与する。付与済みの児童には触れない(冪等)。
//     再起動のたびに振り直さない。
//   - 付与の前に spa_master の生JSONを spa_migration_backup_studentId へ退避し、付与後に検証する。
//     書き込み・検証に失敗したら退避から書き戻し、ID なしの従来動作のまま起動する(ロールバック)。
//   - 既存データは1件も変わらない: spa_master は studentId が増えるだけ。他の全キーはバイト単位で不変。
//   - 付与済みの ID は 名簿保存・バックアップ復元・視力/身長の属性保持(H6) で失われない。
//   - フィールド名は studentId。pf.html は s.id を新体力テストの児童キーに使うため、students[].id は増やさない。
//   - 端末データ消去(退勤モード)で退避コピー(氏名を含む)も消える。
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node student-id-migration.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ID_RE = /^stu_[a-z0-9]{8}$/;

const NAMES = ['甲', '乙', '丙', '丁'];
const CI = { year: 2026, grade: 5, class: 1, teacher: 'T', termSystem: 3, term2Start: '09-01', term3Start: '01-01' };
const stuNoId = () => NAMES.map((n, i) => ({ name: n, gender: i % 2 ? '女' : '男', visionL: 'A', visionR: 'B', height: 130 + i }));
const masterRaw = (students) => JSON.stringify({ version: 2, classInfo: CI, students: students, lastSync: '2026-09-01T00:00:00.000Z' });
// 児童に紐づく各種データ(生JSON文字列のまま保存して、移行前後でバイト単位に比較する)
function dataKeys() {
    const byIdx = (f) => { const o = {}; NAMES.forEach((n, i) => { o[String(i)] = f(n, i); }); return o; };
    return {
        spa_tests: JSON.stringify([{ id: 1, subject: '算数', testType: '小テスト', name: 't1', category: '知識・技能', maxScore: 100, inputMode: 'score', date: '2026-05-10' }]),
        spa_scores: JSON.stringify(NAMES.map((n, i) => ({ id: i + 1, studentIndex: i, testId: 1, score: 50 + i }))),
        spa_submissions_assignments: JSON.stringify([{ id: 101, subject: '算数', name: '宿題', date: '2026-05-10' }]),
        spa_submissions_data: JSON.stringify(NAMES.map((n, i) => ({ id: i + 1, studentIndex: i, assignmentId: 101, status: 'submitted' }))),
        spa_attendance: JSON.stringify({ '2026-05-10': { '0': '○', '1': '×', '2': '○', '3': '／' } }),
        spa_karte_life: JSON.stringify(byIdx((n) => [{ id: 1, date: '2026-05-01', summary: n + 'の記録' }])),
        spa_karte_health: JSON.stringify(byIdx((n) => ({ allergies: [], medication: '', exerciseLimit: '', familyMemo: n }))),
        spa_seating: JSON.stringify({ s0: 0, s1: 1, s2: 2, s3: 3 }),
        spa_kanji: JSON.stringify({ chars: ['山', '川'], checks: byIdx(() => ({ '0': 'o' })) }),
        spa_grades_external: JSON.stringify({ subjects: ['音楽'], data: { 音楽: byIdx(() => ({ k: 'A', t: 'B', a: 'A', h: 3 })) } }),
        spa_patrol: JSON.stringify(NAMES.map((n, i) => ({ id: i + 1, sessionKey: 's', studentIndex: i, subject: '算数', evals: {} }))),
        spa_grade_weights: JSON.stringify({ 算数: { knowledge: { k_1: 2 } } })
    };
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
        if (msg.type() !== 'error') return;
        const loc = msg.location() || {};
        if ((loc.url || '').indexOf('favicon.ico') !== -1) return;
        consoleErrors.push(msg.text() + (loc.url ? ' [' + loc.url + ']' : ''));
    });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => d.accept());

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const KN = await page.evaluate(() => ({ master: KEYS.master, backup: KEYS.migration_backup_studentId }));
    // 実データの完全退避(全キー)と復元
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });

    // 全キーを消してから seed(map: key→生JSON) を書き、再読み込みする(起動時移行が走る)
    async function reset(map, opts) {
        await page.evaluate((map) => {
            StorageManager.getAllKeys().slice().forEach(k => { StorageManager.remove(k); });
            Object.keys(map).forEach(k => { StorageManager.setImmediate(k, map[k]); });
        }, map);
        if (!(opts && opts.noReload)) { await page.reload({ waitUntil: 'networkidle0' }); await sleep(400); }
    }
    const snapshot = () => page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const master = async () => JSON.parse(await page.evaluate((k) => StorageManager.getRaw(k), KN.master));
    const strip = (s) => { const c = Object.assign({}, s); delete c.studentId; return c; };

    try {
        // ---------------- (1) 付与: ID を持たない児童全員に一意なIDが付く ----------------
        await reset(Object.assign({ spa_master: masterRaw(stuNoId()) }, dataKeys()));
        let m = await master();
        const ids = m.students.map(s => s.studentId);
        check('全児童に studentId(stu_+8桁)が付与される', ids.every(i => ID_RE.test(i)), JSON.stringify(ids));
        check('付与されたIDは名簿内で一意', new Set(ids).size === ids.length, '');
        check('students[].id は増やさない(pf.html の児童キー s.id と衝突させない)', m.students.every(s => !('id' in s)), JSON.stringify(m.students[0]));
        check('付与以外の項目(name/gender/視力/身長)は変わらない', JSON.stringify(m.students.map(strip)) === JSON.stringify(stuNoId()), JSON.stringify(m.students.map(strip)));
        check('classInfo・lastSync など名簿以外の項目も変わらない', JSON.stringify(m.classInfo) === JSON.stringify(CI) && m.lastSync === '2026-09-01T00:00:00.000Z' && m.version === 2, JSON.stringify(m));

        // ---------------- (2) 退避: 付与前の生JSONがそのまま退避される ----------------
        const bk = await page.evaluate((k) => StorageManager.getRaw(k), KN.backup);
        check('付与前の spa_master が spa_migration_backup_studentId に(バイト単位で)退避される', bk === masterRaw(stuNoId()), String(bk).slice(0, 80));

        // ---------------- (3) 冪等: 再起動しても振り直さない・書き換えない ----------------
        const snapA = await snapshot();
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
        const snapB = await snapshot();
        check('再起動2回: 児童のIDは変わらない', JSON.stringify((JSON.parse(snapB.spa_master)).students.map(s => s.studentId)) === JSON.stringify(ids), '');
        check('再起動2回: spa_master の生JSONが1バイトも変わらない', snapA.spa_master === snapB.spa_master, '');
        check('再起動2回: 退避コピーと移行フラグも書き換わらない', snapA[KN.backup] === snapB[KN.backup] && snapA.migration_studentId_v1 === snapB.migration_studentId_v1 && !!snapB.migration_studentId_v1, '');

        // ---------------- (4) 一部だけ付与済み: 付与済みには触れず、無い児童にだけ付与 ----------------
        const partial = stuNoId(); partial[1].studentId = 'stu_keepkeep';
        await reset({ spa_master: masterRaw(partial) });
        m = await master();
        check('一部付与済み: 付与済みの児童のIDは保持される', m.students[1].studentId === 'stu_keepkeep', m.students[1].studentId);
        check('一部付与済み: 無い児童にだけ新規付与(付与済みIDとも重複しない)', [0, 2, 3].every(i => ID_RE.test(m.students[i].studentId)) && new Set(m.students.map(s => s.studentId)).size === 4, JSON.stringify(m.students.map(s => s.studentId)));
        const allHave = stuNoId().map((s, i) => Object.assign(s, { studentId: 'stu_aaaaaaa' + i }));
        await reset({ spa_master: masterRaw(allHave) });
        check('全員付与済み: 退避コピーも移行フラグも作らない(何もしない)', (await page.evaluate((k) => [StorageManager.getRaw(k), StorageManager.getRaw('migration_studentId_v1')], KN.backup)).every(v => v === null), '');
        check('全員付与済み: spa_master は1バイトも変わらない', (await page.evaluate((k) => StorageManager.getRaw(k), KN.master)) === masterRaw(allHave), '');

        // ---------------- (5) 既存データが1件も変わらない(全キーのスナップショット比較) ----------------
        // 起動時の他の処理による自然な更新(ノイズ)を対照実験(IDを付与済みのデータ)で測り、それ以外の差分が無いことを確認する
        const seedNoId = Object.assign({ spa_master: masterRaw(stuNoId()) }, dataKeys());
        const seedWithId = Object.assign({ spa_master: masterRaw(stuNoId().map((s, i) => Object.assign(s, { studentId: 'stu_ctrl000' + i }))) }, dataKeys());
        // 起動時に他の処理が自然に書くキー(移行済みフラグ・日時付きバックアップ名など)は名前の日時部分を正規化して比較する
        const norm = (o) => { const r = {}; Object.keys(o).forEach(k => { r[k.replace(/\d{10,}/, '#')] = o[k]; }); return r; };
        const diffFromSeed = (snap, seed) => {
            const n = norm(snap);
            return {
                changed: Object.keys(seed).filter(k => k in n && n[k] !== seed[k]),
                removed: Object.keys(seed).filter(k => !(k in n)),
                added: Object.keys(n).filter(k => !(k in seed))
            };
        };
        await reset(seedWithId);                    // 対照: IDを付与済みのデータで起動(移行は何もしない)
        const control = diffFromSeed(await snapshot(), seedWithId);
        await reset(seedNoId);                      // 本番: IDなしのデータで起動(移行が走る)
        const s1 = await snapshot();
        const mig = diffFromSeed(s1, seedNoId);
        const unexpectedChanged = mig.changed.filter(k => k !== 'spa_master' && control.changed.indexOf(k) === -1);
        check('全キー比較: 児童データ・課題・記録・出欠・カルテ・座席・漢字・専科・重みは1バイトも変わらない', unexpectedChanged.length === 0 && Object.keys(dataKeys()).every(k => s1[k] === dataKeys()[k]), JSON.stringify(unexpectedChanged));
        check('全キー比較: 削除されたキーは無い', mig.removed.length === 0, JSON.stringify(mig.removed));
        const unexpectedAdded = mig.added.filter(k => k !== KN.backup && k !== 'migration_studentId_v1' && control.added.indexOf(k) === -1);
        check('全キー比較: 増えたキーは 退避コピー と 移行フラグ だけ(起動時の他の処理が書くキーを除く)', unexpectedAdded.length === 0 && mig.added.indexOf(KN.backup) !== -1 && mig.added.indexOf('migration_studentId_v1') !== -1, JSON.stringify(mig.added));
        const s0 = seedNoId;
        check('全キー比較: spa_master は studentId が増えただけ(それ以外の値は同一)', JSON.stringify(JSON.parse(s1.spa_master).students.map(strip)) === JSON.stringify(JSON.parse(s0.spa_master).students), '');

        // ---------------- (6) 失敗時のロールバック ----------------
        async function failScenario(stubSrc) {
            await reset({ spa_master: masterRaw(stuNoId()) }, { noReload: true });
            await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
            // reload で起動時移行が走ってしまうため、ID なしの状態を作り直してから、失敗させて手動で移行を実行する
            await page.evaluate((raw, k) => { StorageManager.setImmediate(KEYS.master, raw); StorageManager.remove(k); StorageManager.remove('migration_studentId_v1'); loadMaster(); }, masterRaw(stuNoId()), KN.backup);
            return page.evaluate((stubSrc) => {
                const orig = StorageManager.setImmediate;
                StorageManager.setImmediate = new Function('orig', 'return ' + stubSrc)(orig);
                let res;
                try { res = window.migrateStudentIdsV1(); } finally { StorageManager.setImmediate = orig; }
                return { res: res, raw: StorageManager.getRaw(KEYS.master), backup: StorageManager.getRaw(KEYS.migration_backup_studentId), flag: StorageManager.getRaw('migration_studentId_v1'), mem: JSON.stringify(master.students) };
            }, stubSrc);
        }
        const ORIG = masterRaw(stuNoId());
        // 6-1 退避の書き込みに失敗 → 何も変更しない
        let f = await failScenario("function(k, v) { if (k === KEYS.migration_backup_studentId) throw new Error('boom'); return orig.apply(this, arguments); }");
        check('失敗(退避の書き込みで例外): spa_master は元のまま・IDは付かない', f.raw === ORIG && !/studentId/.test(f.raw) && !/studentId/.test(f.mem), String(f.res && f.res.reason));
        check('失敗(退避の書き込みで例外): 移行フラグは立たず、結果は ok:false', f.flag === null && f.res && f.res.ok === false, JSON.stringify(f.res));
        // 6-2 名簿の書き込みで例外 → 元のまま
        f = await failScenario("function(k, v) { if (k === KEYS.master && /studentId/.test(v)) throw new Error('boom'); return orig.apply(this, arguments); }");
        check('失敗(名簿の書き込みで例外): spa_master は元のまま・メモリ上の名簿にもIDは付かない', f.raw === ORIG && !/studentId/.test(f.mem), f.raw.slice(0, 60));
        check('失敗(名簿の書き込みで例外): 移行フラグは立たず、結果は ok:false', f.flag === null && f.res && f.res.ok === false, JSON.stringify(f.res));
        // 6-3 名簿が壊れて書き込まれた(検証で不一致) → 退避から書き戻す
        f = await failScenario("function(k, v) { if (k === KEYS.master && /studentId/.test(v)) return orig.call(this, k, v.slice(0, v.length - 7)); return orig.apply(this, arguments); }");
        check('失敗(書き込み内容が壊れた): 検証で検出して退避から書き戻し、spa_master は元どおり', f.raw === ORIG, f.raw.slice(-40));
        check('失敗(書き込み内容が壊れた): メモリ上の名簿も元どおり(IDなし)で、移行フラグは立たず ok:false', !/studentId/.test(f.mem) && f.flag === null && f.res && f.res.ok === false, JSON.stringify(f.res));
        // 6-4 失敗後の次回起動で再試行され、成功すれば付与される
        await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
        m = await master();
        check('失敗後の次回起動: 再試行されて全員にIDが付く(ID無しのまま固まらない)', m.students.every(s => ID_RE.test(s.studentId)), JSON.stringify(m.students.map(s => s.studentId)));

        // ---------------- (7) 名簿保存で ID が失われない(H6の属性保持と併用) ----------------
        const withIds = stuNoId().map((s, i) => Object.assign(s, { studentId: 'stu_saveid0' + i }));
        async function saveRoster(lines) {
            await reset({ spa_master: masterRaw(withIds) });
            await page.evaluate((lines) => { showView('settings'); if (lines) document.getElementById('masterRoster').value = lines.join('\n'); saveMasterRoster(); flushSaveQueue && flushSaveQueue(); }, lines);
            await page.reload({ waitUntil: 'networkidle0' }); await sleep(400);
            return (await master()).students;
        }
        let st = await saveRoster(null);
        check('名簿を変更せず保存: 全員のIDと視力・身長が残る', st.every((s, i) => s.studentId === 'stu_saveid0' + i && s.visionL === 'A' && s.height === 130 + i), JSON.stringify(st.map(s => s.studentId)));
        st = await saveRoster(['甲,男', '乙乙,女', '丙,男', '丁,女']);
        check('同位置の改名: IDは保持され、名前だけ更新される', st[1].studentId === 'stu_saveid01' && st[1].name === '乙乙' && st[1].height === 131, JSON.stringify(st[1]));
        st = await saveRoster(['甲,男', '乙,女', '丙,男', '丁,女', '戊,男']);
        check('末尾に転入生を追加: 既存4名のIDは保持され、新しい児童にはIDが付く(重複しない)', st.length === 5 && [0, 1, 2, 3].every(i => st[i].studentId === 'stu_saveid0' + i) && ID_RE.test(st[4].studentId) && new Set(st.map(s => s.studentId)).size === 5, JSON.stringify(st.map(s => s.studentId)));
        st = await saveRoster(['甲,男', '乙,女', '丙,男']);
        check('末尾の児童を削除: 残る児童のIDは保持される', st.length === 3 && st.every((s, i) => s.studentId === 'stu_saveid0' + i), JSON.stringify(st.map(s => s.studentId)));

        // ---------------- (8) バックアップ復元でIDが失われない ----------------
        async function restoreFrom(backupObj) {
            const file = path.join(os.tmpdir(), 'sid-restore-' + Date.now() + '.json');
            fs.writeFileSync(file, JSON.stringify(backupObj));
            const input = await page.$('#restoreFile');
            await input.uploadFile(file);
            await page.evaluate(() => { importBackup(); });
            await sleep(2500); // 復元後に自動で再読込される
            await page.waitForFunction(() => typeof StorageManager !== 'undefined', { timeout: 5000 });
            await sleep(400);
            fs.unlinkSync(file);
        }
        await reset(Object.assign({ spa_master: masterRaw(withIds) }, dataKeys()));
        const exported = await page.evaluate(async () => {
            let text = null;
            window.universalShare = function(blob) { return blob.text().then(function(t) { text = t; }); };
            await exportBackup(false);
            return text;
        });
        const exportedObj = JSON.parse(exported);
        check('前提: バックアップに studentId 入りの名簿が含まれる', JSON.parse(exportedObj.data.spa_master).students.every(s => /^stu_saveid0/.test(s.studentId)), '');
        // 端末の名簿を別内容にしてから、IDありバックアップを復元
        await page.evaluate((k) => { StorageManager.setImmediate(k, JSON.stringify({ version: 2, classInfo: {}, students: [{ name: '別人' }] })); }, KN.master);
        await restoreFrom(exportedObj);
        m = await master();
        check('IDありバックアップを復元: 名簿のIDが復元されたとおりに残る', m.students.length === 4 && m.students.every((s, i) => s.studentId === 'stu_saveid0' + i), JSON.stringify(m.students.map(s => s.studentId)));
        // 旧形式(IDなし)のバックアップを復元: 復元後の起動でIDが付与され、他のデータは変わらない
        const oldFmt = { version: 10, appType: 'classroom-spa', exportDate: '2026-01-01T00:00:00Z', data: Object.assign({ spa_master: masterRaw(stuNoId()) }, dataKeys()) };
        await restoreFrom(oldFmt);
        m = await master();
        const snapR = await snapshot();
        check('IDなし(旧形式)バックアップを復元: 復元後の起動で全員にIDが付く', m.students.length === 4 && m.students.every(s => ID_RE.test(s.studentId)), JSON.stringify(m.students.map(s => s.studentId)));
        check('IDなし(旧形式)バックアップを復元: 名簿以外のデータは復元したまま1バイトも変わらない', Object.keys(dataKeys()).every(k => snapR[k] === dataKeys()[k]), JSON.stringify(Object.keys(dataKeys()).filter(k => snapR[k] !== dataKeys()[k])));

        // ---------------- (9) 端末データ消去で退避コピー(氏名を含む)も消える ----------------
        await reset(Object.assign({ spa_master: masterRaw(stuNoId()) }, dataKeys()));
        const hadBackup = await page.evaluate((k) => StorageManager.getRaw(k) !== null, KN.backup);
        await page.evaluate(() => { wipeLocalData(); });
        const afterWipe = await page.evaluate((k) => [StorageManager.getRaw(k), StorageManager.getRaw(KEYS.master)], KN.backup);
        check('端末データ消去(退勤モード): 退避コピーも消える(氏名が端末に残らない)', hadBackup === true && afterWipe[0] === null && afterWipe[1] === null, JSON.stringify([hadBackup, afterWipe[0] === null]));

        // ---------------- (9b) 診断出力(コピーして共有される)に、退避コピー内の氏名が出ない ----------------
        await sleep(1800); // wipe 後の自動再読込を待つ
        await reset(Object.assign({ spa_master: masterRaw(stuNoId().map((s, i) => Object.assign(s, { name: '診断確認' + i }))) }, dataKeys()));
        const aud = await page.evaluate(async () => {
            showView('settings'); runAuditDiagnosis();
            await new Promise(r => setTimeout(r, 700));
            return { html: document.getElementById('audit-result-container').innerHTML, json: JSON.stringify(window._auditDiagnosisLastResult) };
        });
        check('診断出力(画面・JSON)に退避コピー内の氏名が含まれない(退避キーの存在は表示される)', !/診断確認/.test(aud.html) && !/診断確認/.test(aud.json) && aud.html.indexOf('spa_migration_backup_studentId') !== -1, '');

        // ---------------- (10) 空の名簿・破損した名簿では何もしない ----------------
        await sleep(1800); // wipe 後の自動再読込を待つ
        await reset({ spa_master: masterRaw([]) });
        check('名簿が空: 退避コピー・移行フラグを作らず、例外も出ない', (await page.evaluate((k) => [StorageManager.getRaw(k), StorageManager.getRaw('migration_studentId_v1')], KN.backup)).every(v => v === null), '');
        await reset({ spa_master: '{"version":2,"students":[{"name":"甲"' }); // 破損したJSON
        const broken = await page.evaluate((k) => [StorageManager.getRaw(KEYS.master), StorageManager.getRaw(k)], KN.backup);
        check('破損した名簿: 上書きせず(生JSONのまま)、退避コピーも作らない', broken[0] === '{"version":2,"students":[{"name":"甲"' && broken[1] === null, String(broken[0]).slice(0, 40));
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        // 実データの完全復元
        await page.evaluate((bk) => {
            StorageManager.getAllKeys().slice().forEach(k => { if (!(k in bk)) StorageManager.remove(k); });
            Object.keys(bk).forEach(k => { if (bk[k] === null) StorageManager.remove(k); else StorageManager.setImmediate(k, bk[k]); });
        }, realBackup);
        check('コンソールエラーなし(意図した破損データ・失敗シナリオのログを除く)', consoleErrors.filter(e => !/master load error|Unexpected|JSON|migrateStudentIdsV1 failed/.test(e)).length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== student-id-migration: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
