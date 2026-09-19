// H4 案B 段階2a: 児童データ付け替えの純関数(StudentRemap)の単体テスト。
//   - computeRosterRemap: 対応表とエラー
//   - 各ストア種別(kind)の付け替え・退避・エッジケース
//   - 不変条件 I1〜I7 の違反検出
//   - 純粋性(入力を変更しない・書き込みゼロ)
//   - 登録漏れの検出(KEYS の全キー、index.html 内の 'spa_*' リテラルの全キー)
//   - 乱数固定のランダム操作(並べ替え・削除・挿入)でずれ0・保存則・不変条件
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node student-remap.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { buildRaws, ownersOf, misplaced, LABELS, STORE_NAMES, mkStudents } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 乱数固定(mulberry32)
function rng(seed) { let a = seed >>> 0; return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

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

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const plan = (raws, o, n) => page.evaluate((raws, o, n) => StudentRemap.planRosterChange(raws, o, n), raws, o, n);
    const remapOf = (o, n) => page.evaluate((o, n) => StudentRemap.computeRosterRemap(o, n), o, n);
    const S = (ids) => ids.map(id => ({ studentId: id, name: id }));

    try {
        // ---------------- A. computeRosterRemap ----------------
        console.log('--- A. 対応表(computeRosterRemap) ---');
        const old4 = S(['a', 'b', 'c', 'd']);
        let r = await remapOf(old4, [old4[2], old4[0], old4[1], old4[3]]);
        check('並べ替え: 旧→新の対応表(a:0→1, b:1→2, c:2→0, d:3→3)', r.ok && r.map[0] === 1 && r.map[1] === 2 && r.map[2] === 0 && r.map[3] === 3 && !r.identity && r.deleted.length === 0 && r.added.length === 0, JSON.stringify(r.map));
        r = await remapOf(old4, [old4[0], old4[2], old4[3]]);
        check('途中削除: 削除IDと対応表', r.ok && r.deleted.length === 1 && r.deleted[0].studentId === 'b' && r.deleted[0].oldIdx === 1 && r.map[0] === 0 && r.map[2] === 1 && r.map[3] === 2 && r.map[1] === undefined, JSON.stringify(r));
        r = await remapOf(old4, [old4[0], { name: '転入' }, old4[1], old4[2], old4[3]]);
        check('途中挿入: 転入生(IDなし)の新添字が added に入る', r.ok && JSON.stringify(r.added) === '[1]' && r.map[1] === 2 && r.map[3] === 4, JSON.stringify(r));
        r = await remapOf(old4, old4.map(s => Object.assign({}, s, { name: '改名' })));
        check('同一名簿(名前だけ変更): identity=true', r.ok && r.identity === true, JSON.stringify(r.identity));
        r = await remapOf(old4, old4.concat([{ name: 'x' }]));
        check('末尾追加は identity ではない', r.ok && r.identity === false && JSON.stringify(r.added) === '[4]', JSON.stringify(r));
        check('エラー: 旧名簿にIDが無い児童', (await remapOf([{ name: 'x' }], [])).error === 'old-missing-id', '');
        check('エラー: 旧名簿のID重複', (await remapOf(S(['a', 'a']), [])).error === 'old-duplicate-id', '');
        check('エラー: 新名簿のID重複', (await remapOf(old4, [old4[0], old4[0]])).error === 'new-duplicate-id', '');
        check('エラー: 旧名簿に無いIDが新名簿に混ざる(別端末の名簿など)', (await remapOf(old4, [{ studentId: 'zzz', name: 'z' }])).error === 'new-unknown-id', '');
        check('エラー: 新名簿のIDが不正(数値など)', (await remapOf(old4, [{ studentId: 5, name: 'z' }])).error === 'new-invalid-id', '');
        check('エラー: 配列でない入力', (await remapOf(null, [])).error === 'not-array', '');

        // ---------------- B. ストア種別ごとの付け替え・エッジケース ----------------
        console.log('--- B. ストア種別ごとの挙動 ---');
        const O = S(['a', 'b', 'c']);       // 旧名簿(添字0,1,2)
        const delB = [O[0], O[2]];          // bを削除 → c は 2→1
        const swap = [O[1], O[0], O[2]];    // a,b を入替
        const one = async (key, data, newRoster) => {
            const p = await plan({ [key]: typeof data === 'string' ? data : JSON.stringify(data) }, O, newRoster);
            return { p, out: p.newRaw[key] === undefined ? undefined : JSON.parse(p.newRaw[key]) };
        };
        // 配列レコード: 文字列の添字・順序・動かないレコードのバイト同一
        let x = await one(K.scores, [{ id: 1, studentIndex: '2', testId: 1, score: 5 }, { id: 2, studentIndex: 0, testId: 1, score: 6 }, { id: 3, studentIndex: 1, testId: 2, score: 7 }, { id: 4, note: '添字なし' }], delB);
        check('配列: 文字列の添字("2")も付け替える(→数値1)・削除児童の記録は退避・添字なしは無変更', JSON.stringify(x.out) === JSON.stringify([{ id: 1, studentIndex: 1, testId: 1, score: 5 }, { id: 2, studentIndex: 0, testId: 1, score: 6 }, { id: 4, note: '添字なし' }]) && x.p.archive['b'][K.scores].length === 1 && x.p.archive['b'][K.scores][0].id === 3, JSON.stringify(x.out));
        x = await one(K.scores, [{ id: 1, studentIndex: 0, score: 1 }, { id: 2, studentIndex: 1, score: 2 }, { id: 3, studentIndex: 2, score: 3 }], swap);
        check('配列: 順序は保持され、付け替え後の添字が入る', JSON.stringify(x.out.map(r => [r.id, r.studentIndex])) === '[[1,1],[2,0],[3,2]]', JSON.stringify(x.out));
        x = await one(K.scores, [{ id: 1, studentIndex: 0, score: 1 }, { id: 2, studentIndex: 1, score: 2 }, { id: 3, studentIndex: 2, score: 3 }], [O[0], O[2], O[1]]);
        check('配列: 動かない記録(id1)は他と同様に保持される', x.out[0].id === 1 && x.out[0].studentIndex === 0, JSON.stringify(x.out));
        // 孤立データ(範囲外の添字)は __orphan__ へ退避し、消さない
        x = await one(K.scores, [{ id: 1, studentIndex: 0, score: 1 }, { id: 2, studentIndex: 9, score: 2 }], delB);
        check('孤立データ(添字9・旧人数3以上)は __orphan__:9 に退避され、名簿が広がっても別の児童に付かない', x.out.length === 1 && x.p.archive['__orphan__:9'][K.scores].length === 1 && x.p.archiveEntries.some(e => e.orphanIndex === 9), JSON.stringify(x.p.archive));
        // オブジェクトキー: 数字でないキー(メタ情報)・先頭ゼロは児童に紐づかない
        x = await one(K.karte_life, { '0': ['a'], '1': ['b'], '2': ['c'], meta: 'M', '01': 'Z' }, delB);
        check('オブジェクトキー: 数字でないキー・先頭ゼロのキーは無変更、削除児童の値は退避', JSON.stringify(x.out) === JSON.stringify({ '0': ['a'], '1': ['c'], meta: 'M', '01': 'Z' }) && JSON.stringify(x.p.archive['b'][K.karte_life]) === '["b"]', JSON.stringify(x.out));
        x = await one(K.karte_life, { '0': ['a'], '1': ['b'], '2': ['c'] }, swap);
        check('オブジェクトキー: 入替でキーが衝突せず両方の値が入れ替わる', JSON.stringify(x.out) === JSON.stringify({ '0': ['b'], '1': ['a'], '2': ['c'] }), JSON.stringify(x.out));
        // 日付ごと: 空になった日付を残す
        x = await one(K.attendance, { '2026-05-01': { '1': '×' }, '2026-05-02': { '0': '○', '1': '×', '2': '○' }, '2026-05-03': 'メモ' }, delB);
        check('日付ごと: 空になった日付は空オブジェクトのまま残り、日付が値でない項目は無変更', JSON.stringify(x.out) === JSON.stringify({ '2026-05-01': {}, '2026-05-02': { '0': '○', '1': '○' }, '2026-05-03': 'メモ' }) && JSON.stringify(x.p.archive['b'][K.attendance]) === JSON.stringify({ '2026-05-01': '×', '2026-05-02': '×' }), JSON.stringify(x.out));
        // 漢字: chars は不変
        x = await one(K.kanji, { chars: ['山', '川'], checks: { '0': { '0': 'o' }, '1': { '1': 'd' }, '2': { '0': 'o' } } }, delB);
        check('漢字チェック: chars は不変、checks のキーだけ付け替え・削除児童は退避', JSON.stringify(x.out) === JSON.stringify({ chars: ['山', '川'], checks: { '0': { '0': 'o' }, '1': { '0': 'o' } } }) && JSON.stringify(x.p.archive['b'][K.kanji]) === JSON.stringify({ '1': 'd' }), JSON.stringify(x.out));
        // 座席: 値を書換、削除児童の席は空席
        x = await one(K.seating, { r1c1: 0, r1c2: 1, r1c3: 2, r2c1: 'x' }, delB);
        check('座席: 座席キーは変えず値だけ付け替え、削除児童の席はキーごと削除(空席)', JSON.stringify(x.out) === JSON.stringify({ r1c1: 0, r1c3: 1, r2c1: 'x' }) && JSON.stringify(x.p.archive['b'][K.seating]) === '["r1c2"]', JSON.stringify(x.out));
        x = await one(K.seating, { s0: '0', s1: '1', s2: '2' }, swap);
        check('座席: 値が文字列("0")でも読み取り、数値で書き戻す', JSON.stringify(x.out) === JSON.stringify({ s0: 1, s1: 0, s2: 2 }), JSON.stringify(x.out));
        // 専科成績: subjects は不変
        x = await one(K.grades_external, { subjects: ['音楽', '家庭'], data: { 音楽: { '0': { k: 'A' }, '1': { k: 'B' }, '2': { k: 'C' } }, 家庭: 'x' } }, delB);
        check('専科成績: subjects は不変、教科ごとにキー付け替え・削除児童は教科別に退避', JSON.stringify(x.out) === JSON.stringify({ subjects: ['音楽', '家庭'], data: { 音楽: { '0': { k: 'A' }, '1': { k: 'C' } }, 家庭: 'x' } }) && JSON.stringify(x.p.archive['b'][K.grades_external]) === JSON.stringify({ 音楽: { k: 'B' } }), JSON.stringify(x.out));
        // 忘れ物の集計(派生)
        x = await one(K.forgotten_history, { '2026-05-01': { total: 3, students: { '0': 1, '1': 2 } }, '2026-05-02': { total: 2, students: { '1': 2 } }, '2026-05-03': { total: 4, students: { '2': 4 } } }, delB);
        check('忘れ物集計: 削除児童の件数を除いて total を更新、残る児童が居ない日は削除、他の児童は新添字へ', JSON.stringify(x.out) === JSON.stringify({ '2026-05-01': { total: 1, students: { '0': 1 } }, '2026-05-03': { total: 4, students: { '1': 4 } } }) && JSON.stringify(x.p.archive['b'][K.forgotten_history]) === JSON.stringify({ '2026-05-01': 2, '2026-05-02': 2 }), JSON.stringify(x.out));
        // ストアの意味が変わらないときは書き込み対象にしない
        x = await one(K.tests, [{ id: 1 }], delB);
        check('登録表にないキー(課題)を渡しても無視され、出力は空', Object.keys(x.p.newRaw).length === 0, JSON.stringify(Object.keys(x.p.newRaw)));
        x = await one(K.scores, [{ id: 1, studentIndex: 0, score: 1 }], [O[0], O[1], O[2], { name: '転入' }]);
        check('末尾追加でもデータが動かないストアは、書き込み対象(newRaw)に入らない', x.p.ok && x.out === undefined, JSON.stringify(Object.keys(x.p.newRaw)));

        // ---------------- C. エラー・形の不一致は「何も適用しない」 ----------------
        console.log('--- C. 異常データ ---');
        let bad = await plan({ [K.scores]: '{壊れたJSON' }, O, delB);
        check('壊れたJSON: ok=false・error=store-invalid・対象キーを返す(何も適用しない)', bad.ok === false && bad.error === 'store-invalid' && bad.key === K.scores, JSON.stringify(bad));
        bad = await plan({ [K.scores]: '{"a":1}' }, O, delB);
        check('形の不一致(配列であるべきがオブジェクト): ok=false', bad.ok === false && bad.error === 'store-invalid', JSON.stringify(bad));
        bad = await plan({ [K.seating]: '[1,2]' }, O, delB);
        check('形の不一致(オブジェクトであるべきが配列): ok=false', bad.ok === false && bad.error === 'store-invalid', JSON.stringify(bad));
        bad = await plan({}, O, [{ studentId: 'zzz' }]);
        check('対応表のエラー(旧名簿に無いID)は計画もエラー', bad.ok === false && bad.error === 'new-unknown-id', JSON.stringify(bad));
        const emptyPlan = await plan({ [K.scores]: null, [K.seating]: '' }, O, delB);
        check('存在しない/空のストアは無視される', emptyPlan.ok === true && Object.keys(emptyPlan.newRaw).length === 0, JSON.stringify(emptyPlan));
        const orphanNoop = await plan({ [K.scores]: JSON.stringify([{ studentIndex: 99 }]) }, O, O.map(s => Object.assign({}, s)));
        check('同一名簿なら、孤立データがあっても noop(何も動かさない)', orphanNoop.noop === true && Object.keys(orphanNoop.newRaw).length === 0, JSON.stringify(orphanNoop.noop));

        // ---------------- D. 不変条件の違反検出 ----------------
        console.log('--- D. 不変条件(I1〜I7)の違反検出 ---');
        const viol = (before, result, oldS, newS) => page.evaluate((b, r, o, n) => StudentRemap.verifyRemapInvariants(b, r, { remap: StudentRemap.computeRosterRemap(o, n), oldStudents: o, newStudents: n }), before, result, oldS, newS);
        const rawS = JSON.stringify([{ studentIndex: 0, testId: 1 }, { studentIndex: 1, testId: 1 }, { studentIndex: 2, testId: 1 }]);
        let v = await viol({ [K.scores]: rawS }, { newRaw: { [K.scores]: JSON.stringify([{ studentIndex: 0, testId: 1 }, { studentIndex: 1, testId: 1 }]) }, archive: {} }, O, O.slice());
        check('I1: 記録が消えて退避にも無い(件数の保存則違反)を検出', v.some(x => x.invariant === 'I1'), JSON.stringify(v));
        v = await viol({ [K.scores]: rawS }, { newRaw: { [K.scores]: JSON.stringify([{ studentIndex: 0, testId: 1 }, { studentIndex: 1, testId: 1 }, { studentIndex: 5, testId: 1 }]) }, archive: {} }, O, O.slice());
        check('I2: 新名簿の範囲外の添字を検出', v.some(x => x.invariant === 'I2'), JSON.stringify(v));
        v = await viol({ [K.scores]: rawS }, { newRaw: { [K.scores]: JSON.stringify([{ studentIndex: 0, testId: 1 }, { studentIndex: 0, testId: 1 }, { studentIndex: 2, testId: 1 }]) }, archive: {} }, O, O.slice());
        check('I3: (添字, testId)の重複が増えたことを検出', v.some(x => x.invariant === 'I3'), JSON.stringify(v));
        v = await viol({ [K.scores]: rawS }, { newRaw: { spa_tests: '[]' }, archive: {} }, O, O.slice());
        check('I4: 登録表にないキーへの書き込みを検出', v.some(x => x.invariant === 'I4'), JSON.stringify(v));
        v = await viol({}, { newRaw: {}, archive: {} }, O, [O[0], Object.assign({}, O[0])]);
        check('I5: 新名簿のID重複を検出', v.some(x => x.invariant === 'I5'), JSON.stringify(v));
        v = await viol({ [K.scores]: rawS }, { newRaw: {}, archive: {} }, O, [O[0], { name: '転入' }, O[2]]); // 転入生の添字1に、旧児童bの記録が残ったまま
        check('I6: 転入生の添字にデータが付いていることを検出', v.some(x => x.invariant === 'I6'), JSON.stringify(v));
        v = await viol({ [K.scores]: rawS }, { newRaw: {}, archive: { 'stu_未知': { [K.scores]: [] } } }, O, O.slice());
        check('I7: 削除された児童でも孤立データでもない退避IDを検出', v.some(x => x.invariant === 'I7'), JSON.stringify(v));
        v = await viol({ [K.scores]: rawS }, { newRaw: {}, archive: {} }, O, O.slice());
        check('違反が無ければ空(恒等)', v.length === 0, JSON.stringify(v));

        // ---------------- E. 純粋性: 入力を変えない・書き込みゼロ ----------------
        console.log('--- E. 純粋性 ---');
        const base = mkStudents(6);
        const raws = buildRaws(K, base);
        const rawsCopy = JSON.stringify(raws);
        const baseCopy = JSON.stringify(base);
        const pure = await page.evaluate((raws, base, K) => {
            const calls = [];
            const wrap = (obj, name) => { const orig = obj[name]; obj[name] = function() { calls.push(name); return orig.apply(this, arguments); }; return () => { obj[name] = orig; }; };
            const restores = [wrap(Storage.prototype, 'setItem'), wrap(Storage.prototype, 'removeItem'), wrap(StorageManager, 'set'), wrap(StorageManager, 'setImmediate'), wrap(StorageManager, 'remove')];
            const ns = base.filter((s, i) => i !== 2); ns.reverse();
            const before = JSON.stringify(raws) + JSON.stringify(base);
            const p = StudentRemap.planRosterChange(raws, base, ns);
            StudentRemap.collectStudentKeyedRaws();
            const after = JSON.stringify(raws) + JSON.stringify(base);
            restores.forEach(f => f());
            return { calls: calls, ok: p.ok, unchanged: before === after };
        }, raws, base, K);
        check('計画の作成・収集でストレージへの書き込み・削除が0回', pure.calls.length === 0 && pure.ok, JSON.stringify(pure.calls));
        check('入力(生JSONの表・旧名簿)を変更しない', pure.unchanged && JSON.stringify(raws) === rawsCopy && JSON.stringify(base) === baseCopy, '');

        // ---------------- F. 登録漏れの検出 ----------------
        console.log('--- F. 登録表の網羅性 ---');
        const reg = await page.evaluate(() => ({ stores: StudentRemap.STORES.map(s => ({ key: s.key, kind: s.kind })), notKeyed: StudentRemap.NOT_KEYED }));
        const regKeys = reg.stores.map(s => s.key);
        const keysValues = Object.keys(K).map(k => K[k]);
        check('登録表は18ストアで、キーの重複がない', reg.stores.length === 18 && new Set(regKeys).size === 18, String(reg.stores.length));
        check('見落としていた2ストア(忘れ物集計・専科PDFコメント)が登録されている', regKeys.indexOf(K.forgotten_history) !== -1 && regKeys.indexOf(K.grades_ext_pdf_comments) !== -1, '');
        const uncovered = keysValues.filter(k => regKeys.indexOf(k) === -1 && !(k in reg.notKeyed));
        check('KEYS の全キーが「登録表」か「児童に紐づかない一覧(理由つき)」のどちらかに入っている', uncovered.length === 0, JSON.stringify(uncovered));
        check('登録表と「児童に紐づかない一覧」に重複がない', regKeys.every(k => !(k in reg.notKeyed)), '');
        check('「児童に紐づかない一覧」の各項目に理由が書かれている', Object.keys(reg.notKeyed).every(k => typeof reg.notKeyed[k] === 'string' && reg.notKeyed[k].length > 3), '');
        check('登録表・一覧のキーはすべて KEYS に存在する(タイプミス防止)', regKeys.concat(Object.keys(reg.notKeyed)).every(k => keysValues.indexOf(k) !== -1), JSON.stringify(regKeys.concat(Object.keys(reg.notKeyed)).filter(k => keysValues.indexOf(k) === -1)));
        // index.html 内の 'spa_*' リテラルを全走査(KEYS に入れずに直接キー文字列で読み書きしている新ストアの検出)
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const literals = Array.from(new Set((src.match(/'spa_[A-Za-z0-9_]+'/g) || []).map(s => s.slice(1, -1))));
        const KNOWN_OTHER = {
            spa_wiped: '退勤モードのフラグ', spa_roster_notice_after_reload: 'sessionStorageの通知(名簿変更の再読み込み後に表示)', spa_restore_notice_after_reload: 'sessionStorageの通知(バックアップの復元・復元の取り消しの再読み込み後に表示)', spa_capacity_probe: '名簿変更前の容量確認用の一時キー(書き込んですぐ消す)', spa_open_settings_after_roster: 'sessionStorageのフラグ(名簿変更後の再読み込みで名簿設定を開く)', spa_storage_persisted: '永続ストレージ要求の結果フラグ', spa_classroom_db: 'IndexedDBのデータベース名',
            spa_cleanup_missing_v1863_done: '移行の完了フラグ', spa_kanji_backup_v1851: '旧バックアップ(漢字の移行前の写し・削除可)',
            spa_kanji_backup_v1853_order: '旧バックアップ(漢字の並べ替え前の写し・削除可)', spa_submissions_removed_v1863: '旧バックアップ(削除した手動×提出記録の写し・削除可)'
        };
        const unknown = literals.filter(k => keysValues.indexOf(k) === -1 && !(k in KNOWN_OTHER));
        check("index.html の 'spa_*' リテラルはすべて KEYS か既知の非対象キー(理由つき)に入っている(新ストアの登録漏れ検出)", unknown.length === 0, JSON.stringify(unknown));
        check("既知の非対象キーは、実際に index.html に存在するものだけ(古い許可リストを残さない)", Object.keys(KNOWN_OTHER).every(k => literals.indexOf(k) !== -1), JSON.stringify(Object.keys(KNOWN_OTHER).filter(k => literals.indexOf(k) === -1)));
        // 種別ごとのストア数の内訳(設計10.1と一致)
        const kindCount = {}; reg.stores.forEach(s => { kindCount[s.kind] = (kindCount[s.kind] || 0) + 1; });
        check('種別の内訳が設計どおり(配列4・オブジェクトキー5・日付ごと5・派生1・漢字1・座席1・専科1)', JSON.stringify(kindCount) === JSON.stringify({ 'array-field': 4, 'object-key': 5, 'date-object-key': 5, 'derived-history': 1, 'nested-checks': 1, 'seat-value': 1, 'subject-object-key': 1 }), JSON.stringify(kindCount));

        // ---------------- G. 乱数固定のランダム操作 ----------------
        console.log('--- G. ランダム操作(乱数固定・60ケース) ---');
        const rand = rng(20260919);
        let badCases = [];
        for (let c = 0; c < 60; c++) {
            const n = 4 + Math.floor(rand() * 27);            // 4〜30人
            const students = mkStudents(n);
            const rawsC = buildRaws(K, students);
            const ids = students.map(s => s.studentId);
            // ランダム操作: 並べ替え(シャッフル)・削除・挿入を組み合わせる
            let ns = students.map(s => Object.assign({}, s));
            for (let i = ns.length - 1; i > 0; i--) { if (rand() < 0.5) { const j = Math.floor(rand() * (i + 1)); const t = ns[i]; ns[i] = ns[j]; ns[j] = t; } }
            const delCount = Math.floor(rand() * Math.min(4, n - 1));
            for (let d = 0; d < delCount; d++) ns.splice(Math.floor(rand() * ns.length), 1);
            const addCount = Math.floor(rand() * 3);
            for (let a = 0; a < addCount; a++) ns.splice(Math.floor(rand() * (ns.length + 1)), 0, { name: '転入' + a });
            const pc = await plan(rawsC, students, ns);
            const before = ownersOf(K, rawsC, ids);
            const after = ownersOf(K, Object.assign({}, rawsC, pc.newRaw), ids);
            const mis = misplaced(after, ns);
            const deleted = ids.filter(id => !ns.some(s => s.studentId === id));
            const problems = [];
            if (!pc.ok) problems.push('plan not ok ' + JSON.stringify(pc.violations || pc.error));
            STORE_NAMES.forEach((name) => {
                const expected = before[name].length - before[name].filter(e => deleted.indexOf(e.owner) !== -1).length;
                if (mis[name].shifted !== 0) problems.push(name + ' shifted ' + mis[name].shifted);
                if (mis[name].total !== expected) problems.push(name + ' total ' + mis[name].total + '!=' + expected);
                if (after[name].some(e => deleted.indexOf(e.owner) !== -1)) problems.push(name + ' deleted data remains');
            });
            deleted.forEach(id => { if (Object.keys((pc.archive || {})[id] || {}).length !== 18) problems.push('archive incomplete ' + id); });
            if (problems.length) badCases.push({ c: c, n: n, problems: problems.slice(0, 3) });
        }
        check('ランダム60ケース(4〜30人・並べ替え/削除/挿入): 全ストアでずれ0・件数の保存則・削除児童の退避が成立', badCases.length === 0, JSON.stringify(badCases.slice(0, 2)));
        // 連続操作(前の結果の名簿・データを次の入力にする)でも成立
        let cur = mkStudents(10), curRaws = buildRaws(K, cur), ok = true, why = '';
        const ids0 = cur.map(s => s.studentId);
        for (let step = 0; step < 8 && ok; step++) {
            const ns = cur.map(s => Object.assign({}, s));
            const i = Math.floor(rand() * ns.length), j = Math.floor(rand() * ns.length);
            const t = ns[i]; ns[i] = ns[j]; ns[j] = t;
            if (step % 3 === 1 && ns.length > 3) ns.splice(Math.floor(rand() * ns.length), 1);
            const pc = await plan(curRaws, cur, ns);
            if (!pc.ok) { ok = false; why = 'step ' + step + ' ' + JSON.stringify(pc.violations || pc.error); break; }
            curRaws = Object.assign({}, curRaws, pc.newRaw);
            cur = ns;
            const mis = misplaced(ownersOf(K, curRaws, ids0), cur);
            const bad = STORE_NAMES.filter(n => mis[n].shifted !== 0);
            if (bad.length) { ok = false; why = 'step ' + step + ' shifted ' + bad.join(','); }
        }
        check('連続8操作(並べ替え・削除の繰り返し)でもずれ0が保たれる', ok, why);
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        check('コンソールエラーなし', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== student-remap: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
