// H4 案B 段階2b: 名簿変更のトランザクション(applyRosterChange)・検証付き書き込み・容量の事前確認・
// 起動時のジャーナル検出と自動ロールバック・退避と復元・取り消し。
//
//   A. storageVerifiedWrite: 直接読み戻して検証(容量超過・書き込み破損を検出)。StorageManager.setImmediate との違い
//   B. 容量の事前確認(書き込みゼロで中止)と、実際の QuotaExceeded(localStorage を満杯にして再現)
//   C. applyRosterChange の正常系(スナップショット・ジャーナル・退避・各ストア・名簿・ハッシュ・ずれ0・保存待ちのflush)
//   D. 書き込みの合間の中断(強制終了)をすべて再現 → 再起動で自動復旧 → 全キーが名簿変更前と1バイトも変わらない
//   E. 書き込みの失敗(容量超過・内容の破損)を各書き込みで注入 → ロールバック → 全キーが変更前と同一
//   F. 起動時のジャーナル検出(applying / committed / rolled-back / rollback-failed / スナップショットなし / 復旧失敗)
//   G. 退避と復元(末尾に同じ studentId・ID重複は拒否・席の衝突・孤立データは復元不可・完全削除)
//   H. 取り消し(名簿変更後に入力があれば取り消さずトーストで理由・確認ダイアログは使わない)
//   I. バックアップ・端末データ消去・IndexedDBの鏡との整合
//
// 実行前提: リポジトリルートで `python3 -m http.server 8123` を起動しておくこと
// 実行: cd tests && node roster-transaction.test.js

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRaws, ownersOf, misplaced, STORE_NAMES, mkStudents, OPS } = require('./helpers/roster-data');

const BASE_URL = 'http://localhost:8123/index.html';
const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : ''));
}
const quiet = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); if (!cond) console.log('FAIL - ' + name + (detail ? ' :: ' + detail : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const NOISE = /^(migration_|scoreDataMigrated|scoreDataBackup_|spa_storage_persisted|spa_cleanup_missing_|_hb$)/;

(async () => {
    const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1180, height: 820 } });
    const page = await browser.newPage();
    const consoleErrors = [];
    let dialogCount = 0;
    page.on('console', msg => { if (msg.type() === 'error') { const l = msg.location() || {}; if ((l.url || '').indexOf('favicon.ico') === -1) consoleErrors.push(msg.text()); } });
    page.on('pageerror', err => consoleErrors.push('PAGEERROR: ' + err.message));
    page.on('dialog', d => { dialogCount++; d.accept(); });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await sleep(300);
    const K = await page.evaluate(() => KEYS);
    const realBackup = await page.evaluate(() => { const o = {}; StorageManager.getAllKeys().forEach(k => { o[k] = StorageManager.getRaw(k); }); return o; });
    const INFRA = [K.roster_snapshot, K.roster_txn];
    const TXN_KEYS = await page.evaluate(() => StudentRemap.STORES.map(s => s.key).concat([KEYS.master, KEYS.student_archive, KEYS.roster_snapshot, KEYS.roster_txn]));

    // ---------- ヘルパー ----------
    async function seed(n) {
        const students = mkStudents(n || 6);
        const raws = buildRaws(K, students);
        const extras = {
            [K.tests]: '[{"id":1,"subject":"算数","name":"t","category":"知識・技能","maxScore":100,"date":"2026-05-10","term":"1"}]',
            [K.grade_weights]: '{"算数":{"knowledge":{"k_1":2}}}',
            [K.submissions_assignments]: '[{"id":101,"subject":"算数","name":"宿題","date":"2026-05-10"}]',
            [K.forgotten_items]: '["消しゴム"]', 'doc-index-v1': 'other-app'
        };
        await page.evaluate((K, raws, extras, students) => {
            if (window.__fault) { window.__fault.restore(); window.__fault = null; }
            if (window.__quotaStub) { window.__quotaStub.restore(); window.__quotaStub = null; }
            StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k));
            localStorage.clear();
            window.__pendingIdbDeletes = [];
            Object.keys(raws).concat(Object.keys(extras)).forEach(k => storageVerifiedWrite(k, raws[k] !== undefined ? raws[k] : extras[k]));
            storageVerifiedWrite(K.master, JSON.stringify({ version: 2, classInfo: { year: 2026, grade: 5, class: 1, teacher: 'T' }, students: students, lastSync: '2026-09-01T00:00:00.000Z' }));
            masterLoadFailed = false; loadMaster();
        }, K, raws, extras, students);
        return { students, raws };
    }
    const dump = () => page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
    const diffKeys = (pre, post, ignore) => Array.from(new Set(Object.keys(pre).concat(Object.keys(post)))).filter(k => INFRA.indexOf(k) === -1 && !NOISE.test(k) && (ignore || []).indexOf(k) === -1 && pre[k] !== post[k]);
    const applyNS = (ns, opts) => page.evaluate((ns, opts) => window.applyRosterChange(ns, opts), ns, opts || { reload: false });
    // 書き込み・削除の障害注入(localStorage層)。txn関連キーだけを数える。
    //   crash: at回の書き込みが成功したあと、以降の書き込み・削除はすべて例外(=プロセスが死んだ状態と同じ永続状態)
    //   probe-quota: 容量確認の書き込みだけ QuotaExceededError / probe-ignore: 容量確認の書き込みを素通り(実際の書き込みだけ検証)
    //   quota: (at+1)回目の書き込みだけ QuotaExceededError  /  corrupt: (at+1)回目の書き込みだけ末尾が欠けて保存される  /  count: 数えるだけ
    const fault = (mode, at) => page.evaluate((mode, at, keys) => {
        const set = new Set(keys), state = { n: 0, log: [] };
        const oSet = Storage.prototype.setItem, oRem = Storage.prototype.removeItem;
        window.__fault = { state: state, restore() { Storage.prototype.setItem = oSet; Storage.prototype.removeItem = oRem; } };
        Storage.prototype.setItem = function(k, v) {
            if (mode === 'probe-quota' && k === 'spa_capacity_probe') throw new DOMException('quota', 'QuotaExceededError');
            if (mode === 'probe-ignore' && k === 'spa_capacity_probe') return; // 容量確認の書き込みを素通りさせ、実際の書き込みの失敗だけを見る
            if (set.has(k)) {
                if (mode === 'crash' && state.n >= at) throw new Error('crash');
                const i = state.n++; state.log.push(k);
                if (mode === 'quota' && i === at) throw new DOMException('quota', 'QuotaExceededError');
                if (mode === 'corrupt' && i === at) return oSet.call(this, k, String(v).slice(0, Math.max(0, String(v).length - 3)));
            }
            return oSet.apply(this, arguments);
        };
        Storage.prototype.removeItem = function(k) { if (set.has(k) && mode === 'crash' && state.n >= at) throw new Error('crash'); return oRem.apply(this, arguments); };
    }, mode, at === undefined ? 1e9 : at, TXN_KEYS);
    const unfault = () => page.evaluate(() => { const s = window.__fault ? window.__fault.state : null; if (window.__fault) { window.__fault.restore(); window.__fault = null; } return s; });
    const reloadWait = async () => { await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000); };
    // トーストの表示を確認する(#toast が表示中で、#toastMsg に文言がある)。document.body.textContent は使わない:
    // インライン <script> のソース文字列も含み、文言が常に見つかってしまうため。表示中(2.5秒)を待って確認する。
    const bodyHas = (t, ms) => page.waitForFunction((t) => { const box = document.getElementById('toast'), el = document.getElementById('toastMsg') || box; return !!el && !!box && box.classList.contains('show') && el.textContent.indexOf(t) !== -1; }, { timeout: ms || 1500, polling: 50 }, t).then(() => true).catch(() => false);
    const delNS = (base) => OPS[2].make(base);    // 2番目を削除
    const owners = (raws, ids) => ownersOf(K, raws, ids);

    try {
        // ================= A. 検証付き書き込み =================
        console.log('--- A. storageVerifiedWrite ---');
        await seed();
        let a = await page.evaluate(() => {
            const o = {};
            storageVerifiedWrite('zz_a', 'v1'); o.ok = localStorage.getItem('zz_a') === 'v1' && StorageManager._cache['zz_a'] === 'v1';
            const oSet = Storage.prototype.setItem;
            Storage.prototype.setItem = function(k, v) { if (k === 'zz_q') throw new DOMException('q', 'QuotaExceededError'); return oSet.apply(this, arguments); };
            try { storageVerifiedWrite('zz_q', 'v'); o.quotaThrew = false; } catch (e) { o.quotaThrew = e.name === 'QuotaExceededError'; }
            o.quotaCache = StorageManager._cache['zz_q'];
            // 対照: setImmediate は失敗を握りつぶし、キャッシュだけ先に書き換わる(getRaw で読み戻しても失敗を検出できない)
            StorageManager.setImmediate('zz_q', 'v');
            o.immediateCache = StorageManager._cache['zz_q']; o.immediateLS = localStorage.getItem('zz_q'); o.immediateGetRaw = StorageManager.getRaw('zz_q');
            Storage.prototype.setItem = function(k, v) { if (k === 'zz_c') return oSet.call(this, k, 'broken'); return oSet.apply(this, arguments); };
            try { storageVerifiedWrite('zz_c', 'good'); o.corruptThrew = false; } catch (e) { o.corruptThrew = /verify/.test(e.message); }
            Storage.prototype.setItem = oSet;
            const oRem = Storage.prototype.removeItem;
            Storage.prototype.removeItem = function(k) { if (k === 'zz_a') return; return oRem.apply(this, arguments); };
            try { storageVerifiedRemove('zz_a'); o.removeThrew = false; } catch (e) { o.removeThrew = /verify/.test(e.message); }
            Storage.prototype.removeItem = oRem;
            storageVerifiedRemove('zz_a'); o.removed = localStorage.getItem('zz_a') === null && !('zz_a' in StorageManager._cache);
            return o;
        });
        check('検証付き書き込み: 正常に書けて、localStorage・キャッシュの両方に反映される', a.ok, '');
        check('検証付き書き込み: 容量超過(QuotaExceededError)を例外として通知し、キャッシュを先に書き換えない', a.quotaThrew && a.quotaCache === undefined, JSON.stringify([a.quotaThrew, a.quotaCache]));
        check('対照: StorageManager.setImmediate は容量超過を握りつぶし、キャッシュだけ先に更新される(getRawで読み戻しても検出不可)', a.immediateCache === 'v' && a.immediateLS === null && a.immediateGetRaw === 'v', JSON.stringify([a.immediateCache, a.immediateLS, a.immediateGetRaw]));
        check('検証付き書き込み: 内容が壊れて保存された場合(読み戻し不一致)を例外にする', a.corruptThrew, '');
        check('検証付き削除: 削除できなかった場合を例外にし、削除できれば localStorage・キャッシュから消える', a.removeThrew && a.removed, JSON.stringify([a.removeThrew, a.removed]));

        // 段階1の移行が検証付き書き込みを使う: 容量超過でキャッシュが先行せず、元へ戻る
        await seed();
        const mig = await page.evaluate(() => {
            const raw0 = JSON.stringify({ version: 2, classInfo: {}, students: [{ name: '甲' }, { name: '乙' }] });
            storageVerifiedWrite(KEYS.master, raw0); storageVerifiedRemove(KEYS.migration_backup_studentId); storageVerifiedRemove('migration_studentId_v1'); loadMaster();
            const oSet = Storage.prototype.setItem;
            Storage.prototype.setItem = function(k, v) { if (k === KEYS.master && /studentId/.test(v)) throw new DOMException('q', 'QuotaExceededError'); return oSet.apply(this, arguments); };
            let res; try { res = migrateStudentIdsV1(); } finally { Storage.prototype.setItem = oSet; }
            return { res: res, ls: localStorage.getItem(KEYS.master) === raw0, cache: StorageManager.getRaw(KEYS.master) === raw0, mem: !/studentId/.test(JSON.stringify(master.students)) };
        });
        check('段階1のID付与: 容量超過で失敗しても、localStorage・キャッシュ・メモリのすべてが付与前のまま(キャッシュだけ先行しない)', mig.res.ok === false && mig.ls && mig.cache && mig.mem, JSON.stringify(mig));

        // ================= B. 容量の事前確認(端末の実際の空きで判定) =================
        console.log('--- B. 容量の事前確認: 固定の上限ではなく、実際に書き込みを試して判定する ---');
        // 端末ごとの容量を疑似的に再現: 現在の使用量 + free 文字までしか書けない localStorage
        const limitTo = (freeChars) => page.evaluate((free) => {
            const oSet = Storage.prototype.setItem;
            const used = () => { let u = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); u += k.length + localStorage.getItem(k).length; } return u; };
            const limit = used() + free;
            window.__quotaStub = { restore() { Storage.prototype.setItem = oSet; }, limit: limit };
            Storage.prototype.setItem = function(k, v) {
                const cur = localStorage.getItem(k);
                const delta = (k.length + String(v).length) - (cur === null ? 0 : k.length + cur.length);
                if (used() + delta > limit) throw new DOMException('quota', 'QuotaExceededError');
                return oSet.apply(this, arguments);
            };
        }, freeChars);
        const unlimit = () => page.evaluate(() => { if (window.__quotaStub) { window.__quotaStub.restore(); window.__quotaStub = null; } });
        const noProbe = async () => !(await page.evaluate(() => localStorage.getItem('spa_capacity_probe') !== null));

        let s = await seed();
        let pre = await dump();
        await fault('probe-quota');
        let rb = await applyNS(delNS(s.students));
        let st = await unfault();
        let post = await dump();
        check('容量の事前確認: 空きが足りない(容量確認の書き込みが QuotaExceeded)なら error=insufficient-storage で中止(見積もりを返す)', rb.ok === false && rb.error === 'insufficient-storage' && rb.needed > 0 && rb.probed > rb.needed, JSON.stringify(rb));
        check('容量の事前確認: 中止時は名簿・記録への書き込みゼロ(スナップショット・ジャーナル・退避を含め0回)・全キーが変更前と同一・容量確認用の一時キーも残らない', st.n === 0 && JSON.stringify(pre) === JSON.stringify(post) && await noProbe(), 'writes=' + st.n + ' diff=' + JSON.stringify(diffKeys(pre, post)));

        // 端末ごとの実際の容量: 小さい容量の端末(空き20KB相当)では中止し、十分な容量(空き600KB相当)では成功する
        s = await seed(); pre = await dump();
        await limitTo(20 * 1024);
        rb = await applyNS(delNS(s.students));
        await unlimit(); post = await dump();
        check('端末の実際の空き(疑似: 空き20KB)が足りなければ、固定の上限に関係なく insufficient-storage で中止し、全キー不変', rb.ok === false && rb.error === 'insufficient-storage' && JSON.stringify(pre) === JSON.stringify(post) && await noProbe(), JSON.stringify(rb));
        s = await seed(); pre = await dump();
        await limitTo(600 * 1024);
        rb = await applyNS(delNS(s.students));
        await unlimit(); post = await dump();
        check('端末の実際の空き(疑似: 空き600KB)が十分なら、成功する(容量確認の一時キーは残らない)', rb.ok === true && diffKeys(pre, post).length > 0 && await noProbe(), JSON.stringify(rb));
        // 空きが見積もりぎりぎりの端末: 容量確認は通っても実際の書き込みで容量超過 → ロールバック(全キー不変)
        s = await seed(); pre = await dump();
        const need0 = await page.evaluate(() => { let n = 0; for (const k of [KEYS.scores, KEYS.karte_life, KEYS.master]) n += (localStorage.getItem(k) || '').length; return n; });
        await limitTo(60 * 1024); // 容量確認(見積もり+32KB余裕)は通るが、書き込みの途中で使い切る量に狭める
        await fault('quota', 8); // 8番目の書き込みで容量超過(実際の書き込みの途中で失敗)
        rb = await applyNS(delNS(s.students));
        await unfault(); await unlimit(); post = await dump();
        check('容量確認を通っても、実際の書き込みの途中で容量超過になれば、ロールバックして全キー不変', rb.ok === false && rb.error === 'apply-failed' && rb.rolledBack === true && diffKeys(pre, post).length === 0, JSON.stringify(rb));

        // 実際の QuotaExceeded(localStorage を満杯にする): 容量確認が実際の空きで失敗する
        s = await seed();
        const filled = await page.evaluate(() => {
            let big = 0, small = 0;
            try { while (true) { localStorage.setItem('zz_fill_' + big, 'x'.repeat(200000)); big++; } } catch (e) {}
            try { while (true) { localStorage.setItem('zz_pad_' + small, 'y'.repeat(500)); small++; } } catch (e) {}
            localStorage.removeItem('zz_pad_0'); // 500文字ぶんだけ空ける(スナップショットは入らない)
            return { big: big, small: small };
        });
        pre = await dump();
        rb = await applyNS(delNS(s.students));
        post = await dump();
        check('実際のQuotaExceeded(localStorage満杯): 容量確認が実際の空きで失敗し error=insufficient-storage', rb.ok === false && rb.error === 'insufficient-storage', JSON.stringify(rb) + ' 満杯まで約' + (filled.big * 200000) + '文字');
        check('実際のQuotaExceeded: 中止後、全キーが変更前と1バイトも変わらない(スナップショット・ジャーナル・容量確認用の一時キーも残らない)', JSON.stringify(pre) === JSON.stringify(post) && !(K.roster_snapshot in post) && !(K.roster_txn in post) && !('spa_capacity_probe' in post), JSON.stringify(diffKeys(pre, post)));
        // 容量確認をすり抜けた場合(確認の書き込みだけ素通り)でも、実際のスナップショット書き込みの容量超過で安全に失敗する
        await fault('probe-ignore');
        rb = await applyNS(delNS(s.students));
        await unfault(); post = await dump();
        check('容量確認をすり抜けても、実際のスナップショット書き込みで QuotaExceeded → snapshot-failed で中止し、全キー不変', rb.ok === false && rb.error === 'snapshot-failed' && JSON.stringify(pre) === JSON.stringify(post), JSON.stringify(rb));
        await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (/^zz_(fill|pad)_/.test(k)) localStorage.removeItem(k); });
        // 起動時: 容量確認用の一時キーが(書き込み直後の強制終了などで)残っていても、次の起動で消す
        s = await seed();
        await page.evaluate(() => { localStorage.setItem('spa_capacity_probe', 'x'.repeat(50000)); });
        await reloadWait();
        check('起動時: 残っていた容量確認用の一時キー(spa_capacity_probe)を削除する', !('spa_capacity_probe' in await dump()), '');

        // ================= C. 正常系 =================
        console.log('--- C. applyRosterChange の正常系 ---');
        s = await seed();
        const ids = s.students.map(x => x.studentId);
        pre = await dump();
        // 保存待ち(500msデバウンス)の入力があっても、変更の前に確定される
        await page.evaluate((K) => { const cur = JSON.parse(localStorage.getItem(K.karte_life)); cur['3'].push({ id: 2, date: '2026-05-02', summary: '保存待ち', _owner: 'pending' }); StorageManager.set(K.karte_life, JSON.stringify(cur)); }, K);
        await fault('count');
        const ns = delNS(s.students);
        const ok = await applyNS(ns);
        const wlog = await unfault();
        post = await dump();
        const j = JSON.parse(post[K.roster_txn]), snap = JSON.parse(post[K.roster_snapshot]);
        const master = JSON.parse(post[K.master]);
        check('正常系: 成功し、ジャーナルは committed でスナップショットが残る', ok.ok === true && j.state === 'committed' && !!snap.keys, JSON.stringify(ok));
        // 先頭の1件は、変更前に確定される保存待ち入力(デバウンス中だったカルテ)の書き込み。トランザクションの書き込みはその後
        const w = wlog.log.slice(1);
        check('正常系: 書き込み順は [保存待ちの確定] → スナップショット → ジャーナル → 退避 → 各ストア → 名簿 → 確定(ジャーナル)', wlog.log[0] === K.karte_life && w[0] === K.roster_snapshot && w[1] === K.roster_txn && w[2] === K.student_archive && w[w.length - 2] === K.master && w[w.length - 1] === K.roster_txn && w.slice(3, -2).length === 18 && w.slice(3, -2).every(k => k !== K.master && k !== K.student_archive), JSON.stringify(wlog.log.map(k => k.replace('spa_', ''))));
        check('正常系: スナップショットは変更前の全対象キー(18ストア+名簿+退避)の生JSON(存在しないキーは null)', Object.keys(snap.keys).length === 20 && snap.keys[K.master] === pre[K.master] && snap.keys[K.scores] === pre[K.scores] && snap.keys[K.student_archive] === null, String(Object.keys(snap.keys).length));
        check('正常系: 名簿は5名・studentIdは元のまま(削除した児童以外)・属性(視力・身長)が残る', master.students.length === 5 && master.students.every((x, i) => x.studentId === ns[i].studentId && x.visionL === 'A'), JSON.stringify(master.students.map(x => x.studentId)));
        const archive = JSON.parse(post[K.student_archive]);
        check('正常系: 削除した児童が spa_student_archive に退避される(名前・視力・身長・元の添字・全18ストア分)', archive.entries.length === 1 && archive.entries[0].studentId === ids[1] && archive.entries[0].student.name === '児童1' && archive.entries[0].student.height === 131 && archive.entries[0].sourceIndex === 1 && Object.keys(archive.entries[0].data).length === 18, JSON.stringify(archive.entries.map(e => [e.studentId, Object.keys(e.data).length])));
        const ownAfter = owners(post, ids), misAfter = misplaced(ownAfter, master.students);
        check('正常系: 6操作の途中削除で全18ストアがずれ0(削除児童のデータはどのストアにも残らない)', STORE_NAMES.every(n => misAfter[n].shifted === 0) && STORE_NAMES.every(n => !ownAfter[n].some(e => e.owner === ids[1])), JSON.stringify(STORE_NAMES.filter(n => misAfter[n].shifted !== 0)));
        check('正常系: 児童に紐づかないキー(課題・重み・提出物課題・忘れ物品目・別アプリ)は1バイトも変わらない', [K.tests, K.grade_weights, K.submissions_assignments, K.forgotten_items, 'doc-index-v1'].every(k => pre[k] === post[k]), '');
        check('正常系: 変更前の保存待ち入力(デバウンス中)も確定してから計画され、付け替え後のカルテに入っている', JSON.parse(post[K.karte_life])['2'].some(x => x.summary === '保存待ち'), '');
        check('正常系: ジャーナルの確定ハッシュが、確定後の全対象キーの内容と一致する', Object.keys(j.hashes).length === 20 && (await page.evaluate((h, keys) => keys.every(k => h[k] === srHash(localStorage.getItem(k))), j.hashes, Object.keys(j.hashes))), '');
        // 改名のみ・同一名簿
        s = await seed(); pre = await dump();
        await fault('count');
        const same = await applyNS(s.students.map(x => Object.assign({}, x)));
        const w0 = await unfault();
        check('同一名簿: 書き込みゼロ(setItem 0回)・全キー不変・noop', same.ok && same.noop && same.wrote === false && w0.n === 0 && JSON.stringify(pre) === JSON.stringify(await dump()), JSON.stringify(same) + ' writes=' + w0.n);
        await fault('count');
        const ren = await applyNS(s.students.map((x, i) => i === 1 ? Object.assign({}, x, { name: '改名後' }) : Object.assign({}, x)));
        const w1 = await unfault(); post = await dump();
        check('改名のみ: 名簿1キーだけを検証付きで書く(スナップショット・ジャーナル・再配置なし)。データキーは不変', ren.ok && ren.noop && ren.wrote && w1.log.length === 1 && w1.log[0] === K.master && diffKeys(pre, post).join() === K.master && JSON.parse(post[K.master]).students[1].name === '改名後', JSON.stringify(w1.log));
        // 転入・並べ替え
        s = await seed(); pre = await dump();
        const ins = await applyNS(OPS[3].make(s.students));
        post = await dump();
        const m3 = JSON.parse(post[K.master]).students;
        check('途中挿入: 転入生に新しいstudentIdが付き(重複なし)、転入生の添字に他の児童のデータが付かない', ins.ok && /^stu_[a-z0-9]{8}$/.test(m3[2].studentId) && new Set(m3.map(x => x.studentId)).size === 7 && STORE_NAMES.every(n => owners(post, s.students.map(x => x.studentId))[n].every(e => e.idx !== 2)), JSON.stringify(m3.map(x => x.studentId)));

        // 再読み込みと名簿設定の画面
        s = await seed();
        await applyNS(OPS[1].make(s.students), { reload: true });
        await sleep(1800);
        await page.waitForFunction(() => typeof StorageManager !== 'undefined'); await sleep(900);
        const after = await page.evaluate(() => ({ view: (document.querySelector('.view.active') || {}).id, flag: sessionStorage.getItem('spa_open_settings_after_roster'), students: master.students.map(x => x.studentId) }));
        check('成功後の自動再読み込み: 名簿設定の画面が開き、フラグは消費され、メモリ上の名簿は付け替え後', after.view === 'view-settings' && after.flag === null && after.students[0] === s.students[1].studentId, JSON.stringify(after));
        const undoAfterReload = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('再読み込み後(起動時の処理を経ても)取り消せる: 起動時に対象キーが書き換わらない', undoAfterReload.ok === true, JSON.stringify(undoAfterReload));

        // ================= D. 書き込みの合間の中断(強制終了)をすべて再現 =================
        console.log('--- D. 中断→起動時の自動ロールバック(書き込みごと) ---');
        s = await seed();
        await fault('count'); await applyNS(delNS(s.students));
        const W = (await unfault()).log;     // 実際の書き込み列(順序つき)
        check('前提: 途中削除の書き込みは 23回(スナップショット1・ジャーナル1・退避1・18ストア・名簿1・確定1)', W.length === 23, String(W.length));
        let crashOk = 0, crashBad = [];
        for (let k = 0; k < W.length; k++) {
            s = await seed(); pre = await dump();
            await fault('crash', k);
            const r = await applyNS(delNS(s.students));
            await unfault();
            const mid = await dump();
            await reloadWait();
            post = await dump();
            const d = diffKeys(pre, post);
            const cache = await page.evaluate((K) => Object.keys(StorageManager._cache).filter(x => x === K.student_archive || x === K.roster_snapshot || x === K.roster_txn), K);
            const idb = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('spa_classroom_db'); q.onsuccess = (e) => { const db = e.target.result; const g = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys(); g.onsuccess = () => { db.close(); res(g.result); }; }; }));
            const ghost = idb.filter(x => x === K.student_archive || x === K.roster_snapshot || x === K.roster_txn);
            const clean = !(K.roster_txn in post) && !(K.roster_snapshot in post) && !(K.student_archive in post);
            const good = r.ok === false && d.length === 0 && clean && cache.length === 0 && ghost.length === 0;
            if (good) crashOk++; else crashBad.push({ k: k, write: (W[k] || '').replace('spa_', ''), ok: r.ok, diff: d.slice(0, 3), clean: clean, cache: cache, ghost: ghost });
            // 中断した状態が実際に「途中」だったこと(名簿変更前に戻す意味がある)を、途中でデータキーが変わっていた場合に数える
            if (k >= 3 && k <= W.length - 2 && diffKeys(pre, mid).length === 0) crashBad.push({ k: k, note: 'no partial state observed' });
        }
        check('中断を再現(全' + W.length + '通り: 各書き込みの直前で強制終了): 再起動で自動復旧し、全キーが名簿変更前と1バイトも変わらない(ジャーナル・スナップショット・退避も残らず、キャッシュ・鏡にも復活しない)', crashOk === W.length && crashBad.length === 0, JSON.stringify(crashBad.slice(0, 2)));
        check('中断からの復旧: 「元に戻しました」の通知が起動時に出る(直前の中断が名簿を書き込んでいた場合)', await (async () => { s = await seed(); await fault('crash', 10); await applyNS(delNS(s.students)); await unfault(); await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(600); return bodyHas('元に戻しました'); })(), '');

        // ================= E. 書き込み失敗の注入(容量超過・内容破損)→ ロールバック =================
        console.log('--- E. 書き込み失敗の注入 → ロールバック ---');
        let qBad = [], cBad = [];
        for (let j = 0; j < W.length; j++) {
            for (const mode of ['quota', 'corrupt']) {
                s = await seed(); pre = await dump();
                await fault(mode, j);
                const r = await applyNS(delNS(s.students));
                await unfault();
                post = await dump();
                const clean = !(K.roster_txn in post) && !(K.roster_snapshot in post) && !(K.student_archive in post);
                const memOk = await page.evaluate((n) => master.students.length === n, s.students.length);
                const good = r.ok === false && diffKeys(pre, post).length === 0 && clean && memOk && (j === 0 ? r.error === 'snapshot-failed' : j === 1 ? r.error === 'journal-failed' : (r.error === 'apply-failed' && r.rolledBack === true));
                if (!good) (mode === 'quota' ? qBad : cBad).push({ j: j, write: W[j].replace('spa_', ''), r: r.error, diff: diffKeys(pre, post).slice(0, 3) });
            }
        }
        check('容量超過(QuotaExceeded)を各書き込みで注入(全' + W.length + '通り): 名簿変更ごと中止・ロールバックされ、全キーが変更前と同一', qBad.length === 0, JSON.stringify(qBad.slice(0, 2)));
        check('内容の破損(読み戻し不一致)を各書き込みで注入(全' + W.length + '通り): 検出してロールバックされ、全キーが変更前と同一', cBad.length === 0, JSON.stringify(cBad.slice(0, 2)));
        // 直前の取り消し点(committed)がある状態で、次の変更がスナップショット/ジャーナルの書き込み前に失敗 → 取り消し点は保たれる
        s = await seed(); await applyNS(OPS[1].make(s.students));
        const stateBefore = await dump();
        const cur = JSON.parse(stateBefore[K.master]).students;
        await fault('quota', 0);
        const rp = await applyNS(delNS(cur));
        await unfault();
        const stateAfter = await dump();
        check('取り消し点(直前の名簿変更)がある状態で、次の変更がスナップショット書き込みで失敗しても、取り消し点は保たれる', rp.ok === false && stateAfter[K.roster_txn] === stateBefore[K.roster_txn] && stateAfter[K.roster_snapshot] === stateBefore[K.roster_snapshot] && diffKeys(stateBefore, stateAfter).length === 0, JSON.stringify(rp));
        // 検証(読み戻し)を通っても不変条件が崩れる場合: 書き込まれた内容が元の意図と食い違う(正しいJSONだが1件欠落)
        s = await seed(); pre = await dump();
        await page.evaluate((K) => {
            const oSet = Storage.prototype.setItem;
            window.__fault = { restore() { Storage.prototype.setItem = oSet; }, state: {} };
            Storage.prototype.setItem = function(k, v) { if (k === K.scores && v.indexOf('"studentIndex"') !== -1 && !window.__once) { window.__once = 1; const a = JSON.parse(v); a.pop(); return oSet.call(this, k, JSON.stringify(a)); } return oSet.apply(this, arguments); };
        }, K);
        const rinv = await applyNS(delNS(s.students)); await unfault(); post = await dump();
        check('内容が食い違って保存された(正しいJSONだが1件欠落)場合も、読み戻し不一致として検出しロールバックする', rinv.ok === false && rinv.rolledBack === true && diffKeys(pre, post).length === 0, JSON.stringify(rinv));
        // ロールバック自体が失敗する場合: journal は rollback-failed(または applying)のまま残り、次の変更は拒否される
        s = await seed(); pre = await dump();
        await fault('crash', 5);
        const rdead = await applyNS(delNS(s.students));
        await unfault();
        const j2 = JSON.parse((await dump())[K.roster_txn]);
        const again = await applyNS(delNS(s.students));
        check('ロールバック自体が失敗した場合: rollbackFailed を返し、ジャーナルが残り、次の名簿変更は txn-pending として拒否される', rdead.ok === false && rdead.rollbackFailed === true && (j2.state === 'applying' || j2.state === 'rollback-failed') && again.error === 'txn-pending', JSON.stringify([rdead.error, rdead.rollbackFailed, j2.state, again.error]));
        await reloadWait();
        check('  → 再起動で自動復旧し、全キーが変更前と同一になる', diffKeys(pre, await dump()).length === 0, '');

        // ================= F. 起動時のジャーナル検出 =================
        console.log('--- F. 起動時のジャーナル検出 ---');
        const withJournal = async (state, opts) => {
            opts = opts || {};
            s = await seed(); pre = await dump();
            await applyNS(delNS(s.students));                    // 正常に適用(committed)して変更後の状態にする
            const after = await dump();
            await page.evaluate((state, corruptSnap, noSnap, K) => {
                const j = JSON.parse(localStorage.getItem(K.roster_txn)); j.state = state; localStorage.setItem(K.roster_txn, JSON.stringify(j));
                if (corruptSnap) localStorage.setItem(K.roster_snapshot, '{broken');
                if (noSnap) localStorage.removeItem(K.roster_snapshot);
            }, state, !!opts.corruptSnap, !!opts.noSnap, K);
            await reloadWait();
            return { pre: pre, after: after, now: await dump() };
        };
        let f = await withJournal('applying');
        check('起動時: applying のジャーナル+スナップショット → 自動ロールバックして全キーが変更前と同一、ジャーナル・スナップショット・退避は消える', diffKeys(f.pre, f.now).length === 0 && !(K.roster_txn in f.now) && !(K.roster_snapshot in f.now) && !(K.student_archive in f.now), JSON.stringify(diffKeys(f.pre, f.now)));
        f = await withJournal('rollback-failed');
        check('起動時: rollback-failed のジャーナル → 再度ロールバックされる', diffKeys(f.pre, f.now).length === 0 && !(K.roster_txn in f.now), '');
        f = await withJournal('committed');
        check('起動時: committed のジャーナルは何もしない(変更後のデータのまま・取り消し用にジャーナルとスナップショットを残す)', diffKeys(f.after, f.now).length === 0 && f.now[K.roster_txn] === f.after[K.roster_txn] && f.now[K.roster_snapshot] === f.after[K.roster_snapshot], JSON.stringify(diffKeys(f.after, f.now)));
        f = await withJournal('rolled-back');
        check('起動時: rolled-back のジャーナルは後始末だけ(データは変更後のまま)', diffKeys(f.after, f.now).length === 0 && !(K.roster_txn in f.now) && !(K.roster_snapshot in f.now), '');
        f = await withJournal('applying', { noSnap: true });
        const barA = await page.evaluate(() => { const b = document.getElementById('recoveryBar'); return { shown: b && b.style.display === 'block', text: b ? b.textContent : '', failed: masterLoadFailed }; });
        check('起動時: applying なのにスナップショットが無い → 復旧できない旨の赤いバー(バックアップから復元)を出し、保存を停止(masterLoadFailed)', barA.shown && /バックアップから復元/.test(barA.text) && barA.failed === true, JSON.stringify(barA));
        check('  → 復旧できないときは、データもジャーナルも一切書き換えない', diffKeys(f.after, f.now).length === 0 && K.roster_txn in f.now, JSON.stringify(diffKeys(f.after, f.now)));
        f = await withJournal('applying', { corruptSnap: true });
        const barB = await page.evaluate(() => ({ shown: document.getElementById('recoveryBar').style.display === 'block', failed: masterLoadFailed }));
        check('起動時: スナップショットが壊れている → 同様に赤いバーで停止し、データは書き換えない', barB.shown && barB.failed && diffKeys(f.after, f.now).length === 0, JSON.stringify(barB));
        const blocked = await page.evaluate(() => { const before = localStorage.getItem(KEYS.master); saveMaster(); return localStorage.getItem(KEYS.master) === before; });
        check('  → 復旧に失敗した状態では、名簿の保存(saveMaster)も拒否される(壊れた状態の上に書かない)', blocked, '');
        // ロールバックの書き込みが起動時に失敗する場合(sessionStorage のフラグで起動前から書き込みを妨害)
        s = await seed(); pre = await dump(); await applyNS(delNS(s.students));
        await page.evaluate((K) => { const j = JSON.parse(localStorage.getItem(K.roster_txn)); j.state = 'applying'; localStorage.setItem(K.roster_txn, JSON.stringify(j)); sessionStorage.setItem('__block_master_write', '1'); }, K);
        const stubId = await page.evaluateOnNewDocument(() => {
            const oSet = Storage.prototype.setItem;
            Storage.prototype.setItem = function(k, v) { if (k === 'spa_master' && sessionStorage.getItem('__block_master_write') === '1') throw new DOMException('q', 'QuotaExceededError'); return oSet.apply(this, arguments); };
        });
        await reloadWait();
        const barC = await page.evaluate(() => ({ shown: document.getElementById('recoveryBar').style.display === 'block', failed: masterLoadFailed, journal: (JSON.parse(localStorage.getItem(KEYS.roster_txn) || '{}')).state }));
        check('起動時のロールバックの書き込みが失敗する場合: 赤いバーで停止し、ジャーナルは rollback-failed で残る(スナップショットも残る)', barC.shown && barC.failed && barC.journal === 'rollback-failed' && K.roster_snapshot in await dump(), JSON.stringify(barC));
        await page.evaluate(() => sessionStorage.removeItem('__block_master_write'));
        await page.removeScriptToEvaluateOnNewDocument(stubId.identifier);
        await reloadWait();
        check('  → 妨害を外して再起動すると復旧し、全キーが変更前と同一になる', diffKeys(pre, await dump()).length === 0, '');

        // ================= G. 退避と復元 =================
        console.log('--- G. 退避(spa_student_archive)と復元 ---');
        s = await seed(); pre = await dump();
        const ids2 = s.students.map(x => x.studentId);
        await applyNS(delNS(s.students));
        const sum = await page.evaluate(() => studentArchiveSummary());
        check('退避中の児童の一覧: 1名(名前・退避日つき)。設定画面の「退避中の児童 N名」用', sum.length === 1 && sum[0].studentId === ids2[1] && sum[0].name === '児童1' && !!sum[0].archivedAt, JSON.stringify(sum));
        const rs = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), sum[0].archiveId);
        post = await dump();
        const mR = JSON.parse(post[K.master]).students;
        check('復元: 名簿の末尾に同じ studentId・元の属性で戻る(6名)', rs.ok && mR.length === 6 && mR[5].studentId === ids2[1] && mR[5].name === '児童1' && mR[5].height === 131 && rs.index === 5, JSON.stringify(rs));
        const oR = owners(post, ids2), misR = misplaced(oR, mR);
        check('復元: 全18ストアで、復元した児童のデータが新しい添字(5)に戻り、他の児童のデータはずれない(ずれ0)', STORE_NAMES.every(n => misR[n].shifted === 0 && oR[n].filter(e => e.owner === ids2[1]).every(e => e.idx === 5) && oR[n].some(e => e.owner === ids2[1])), JSON.stringify(STORE_NAMES.filter(n => misR[n].shifted !== 0 || !oR[n].some(e => e.owner === ids2[1]))));
        const oPre = owners(pre, ids2);
        check('復元: 削除→復元で、各ストアの項目数が元と同じ(保存則。データを失っていない)', STORE_NAMES.every(n => oR[n].length === oPre[n].length), JSON.stringify(STORE_NAMES.filter(n => oR[n].length !== oPre[n].length)));
        check('復元: 退避から取り除かれ(0名)、ジャーナルは committed', (await page.evaluate(() => studentArchiveSummary())).length === 0 && JSON.parse(post[K.roster_txn]).state === 'committed', '');
        check('復元: 座席は元の席(seat1)に戻る', JSON.parse(post[K.seating]).seat1 === 5, JSON.stringify(JSON.parse(post[K.seating])));
        // 重複ID・存在しない・孤立データ・席の衝突・完全削除
        s = await seed(); await applyNS(delNS(s.students));
        const arch0 = JSON.parse(await page.evaluate((K) => localStorage.getItem(K.student_archive), K));
        const idDup = arch0.entries[0].studentId;
        // 名簿に同じ studentId の児童を(別経路で)入れてしまった状態を作る
        await page.evaluate((K, idDup) => { const m = JSON.parse(localStorage.getItem(K.master)); m.students.push({ name: '同じID', studentId: idDup }); localStorage.setItem(K.master, JSON.stringify(m)); }, K, idDup);
        pre = await dump();
        const rdup = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), arch0.entries[0].archiveId);
        check('復元: studentId が名簿に既にいる場合は拒否(duplicate-id)し、何も書き込まない', rdup.ok === false && rdup.error === 'duplicate-id' && JSON.stringify(pre) === JSON.stringify(await dump()), JSON.stringify(rdup));
        check('復元: 存在しない archiveId は not-found', (await page.evaluate(() => window.restoreArchivedStudent('arc_none', { reload: false }))).error === 'not-found', '');
        // 孤立データ(旧人数以上の添字)を持つデータで削除 → 孤立は復元不可
        s = await seed();
        await page.evaluate((K) => { const a = JSON.parse(localStorage.getItem(K.scores)); a.push({ id: 99, studentIndex: 42, testId: 1, score: 1, _owner: 'orphan' }); localStorage.setItem(K.scores, JSON.stringify(a)); }, K);
        await applyNS(delNS(s.students));
        const arch1 = JSON.parse(await page.evaluate((K) => localStorage.getItem(K.student_archive), K));
        const orph = arch1.entries.find(e => e.reason === 'orphan');
        check('孤立データ(添字42)は退避に「orphan」として残り(消えない)、退避中の児童の数には数えない', !!orph && orph.orphanIndex === 42 && (await page.evaluate(() => studentArchiveSummary())).length === 1, JSON.stringify(arch1.entries.map(e => e.reason)));
        const rorph = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), orph.archiveId);
        check('孤立データは復元できない(orphan-not-restorable)', rorph.ok === false && rorph.error === 'orphan-not-restorable', JSON.stringify(rorph));
        // 席の衝突: 元の席(seat1)が別の児童で埋まっている
        s = await seed(); await applyNS(delNS(s.students));
        await page.evaluate((K) => { const st = JSON.parse(localStorage.getItem(K.seating)); st.seat1 = 3; localStorage.setItem(K.seating, JSON.stringify(st)); }, K);
        const arch2 = await page.evaluate(() => studentArchiveSummary());
        const rseat = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), arch2[0].archiveId);
        const seatAfter = JSON.parse(await page.evaluate((K) => localStorage.getItem(K.seating), K));
        check('席の衝突: 元の席が埋まっていれば席だけ戻さず(他の児童の席を奪わない)、結果に skipped で通知する', rseat.ok && seatAfter.seat1 === 3 && rseat.skipped.some(x => x.key === K.seating), JSON.stringify([rseat.skipped, seatAfter.seat1]));
        // 失敗注入: 復元の途中で書き込み失敗 → ロールバック
        s = await seed(); await applyNS(delNS(s.students)); pre = await dump();
        const arch3 = await page.evaluate(() => studentArchiveSummary());
        await fault('corrupt', 6);
        const rfail = await page.evaluate((id) => window.restoreArchivedStudent(id, { reload: false }), arch3[0].archiveId);
        await unfault();
        check('復元の途中で書き込みが破損 → 検出してロールバックし、名簿・データ・退避が復元前のまま', rfail.ok === false && rfail.rolledBack === true && diffKeys(pre, await dump()).length === 0, JSON.stringify(rfail));
        // 完全削除
        const pg = await page.evaluate((id) => window.purgeArchivedStudent(id), arch3[0].archiveId);
        check('完全削除: 退避から取り除かれ(0名)、存在しないIDは not-found', pg.ok && (await page.evaluate(() => studentArchiveSummary())).length === 0 && (await page.evaluate(() => window.purgeArchivedStudent('arc_none'))).error === 'not-found', JSON.stringify(pg));

        // ================= H. 取り消し =================
        console.log('--- H. 取り消し ---');
        s = await seed(); pre = await dump();
        await applyNS(delNS(s.students));
        dialogCount = 0;
        const u1 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        post = await dump();
        check('取り消し(変更後に入力なし): 全キーが変更前に戻り、ジャーナル・スナップショット・退避も消える', u1.ok && diffKeys(pre, post).length === 0 && !(K.roster_txn in post) && !(K.roster_snapshot in post) && !(K.student_archive in post), JSON.stringify(u1));
        s = await seed();
        await applyNS(delNS(s.students));
        // 名簿変更のあとの入力(記録の追加)
        await page.evaluate((K) => { const a = JSON.parse(localStorage.getItem(K.scores)); a.push({ id: 500, studentIndex: 0, testId: 2, score: 9, _owner: 'new' }); storageVerifiedWrite(K.scores, JSON.stringify(a)); }, K);
        const afterInput = await dump();
        dialogCount = 0;
        const u2 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('取り消し(変更後に入力あり): 取り消さず、changed-since で拒否し、理由をトーストで表示する', u2.ok === false && u2.error === 'changed-since' && u2.keys.indexOf(K.scores) !== -1 && await bodyHas('名簿を変更したあとに入力があったため、取り消せません'), JSON.stringify(u2));
        check('  → 確認ダイアログは使わない(0回)・データは1バイトも変わらない', dialogCount === 0 && JSON.stringify(afterInput) === JSON.stringify(await dump()), 'dialogs=' + dialogCount);
        s = await seed();
        const u3 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('取り消せる変更が無いとき: nothing-to-undo とトースト', u3.ok === false && u3.error === 'nothing-to-undo' && await bodyHas('取り消せる名簿の変更がありません'), JSON.stringify(u3));
        // 名簿を再度変更すると、取り消し点は新しい変更に置き換わる(1世代)
        s = await seed(); pre = await dump();
        await applyNS(OPS[1].make(s.students));
        const mid1 = await dump();
        await applyNS(delNS(JSON.parse(mid1[K.master]).students));
        const u4 = await page.evaluate(() => window.undoRosterChange({ reload: false }));
        check('取り消しは1世代: 2回目の変更を取り消すと、1回目の変更後の状態に戻る(変更前までは戻らない)', u4.ok && diffKeys(mid1, await dump()).length === 0, JSON.stringify(u4));

        // ================= I. バックアップ・端末データ消去・IndexedDBの鏡 =================
        console.log('--- I. バックアップ・端末データ消去・鏡 ---');
        s = await seed();
        await applyNS(delNS(s.students));
        const exported = await page.evaluate(async () => { let t = null; window.universalShare = (b) => b.text().then(x => { t = x; }); await exportBackup(false); return JSON.parse(t); });
        check('バックアップ: スナップショットとジャーナルは含めず(容量が倍にならない)、退避は含める', !(K.roster_snapshot in exported.data) && !(K.roster_txn in exported.data) && !(K.roster_snapshot in exported.rawLocalStorage) && !(K.roster_txn in exported.rawLocalStorage) && (K.student_archive in exported.data) && (K.student_archive in exported.rawLocalStorage), '');
        // 端末データ消去で退避・スナップショット・ジャーナルも消える(氏名が残らない)
        await page.evaluate(() => { wipeLocalData(); });
        await sleep(3200);
        await page.waitForFunction(() => typeof StorageManager !== 'undefined'); await sleep(900);
        const wl = await dump();
        const idbAll = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('spa_classroom_db'); q.onsuccess = (e) => { const db = e.target.result; const g = db.transaction('kv', 'readonly').objectStore('kv').getAll(); g.onsuccess = () => { db.close(); res(g.result); }; }; }));
        check('端末データ消去(退勤モード): 退避・スナップショット・ジャーナルが localStorage・IndexedDB から消え、氏名が残らない', [K.student_archive, K.roster_snapshot, K.roster_txn].every(k => !(k in wl) && !idbAll.some(x => x.key === k)) && Object.keys(wl).every(k => String(wl[k]).indexOf('児童1') === -1) && idbAll.every(x => String(x.value).indexOf('児童1') === -1), JSON.stringify(Object.keys(wl)));
        // IndexedDB の鏡が localStorage と一致(変更・再読み込み後)
        s = await seed();
        await applyNS(delNS(s.students), { reload: true });
        await sleep(1800); await page.waitForFunction(() => typeof StorageManager !== 'undefined'); await sleep(900);
        const ls = await dump();
        const idb2 = await page.evaluate(() => new Promise((res) => { const q = indexedDB.open('spa_classroom_db'); q.onsuccess = (e) => { const db = e.target.result; const g = db.transaction('kv', 'readonly').objectStore('kv').getAll(); g.onsuccess = () => { db.close(); res(g.result); }; }; }));
        const mm = Object.keys(ls).filter(k => (idb2.find(x => x.key === k) || {}).value !== ls[k]);
        check('名簿変更→自動再読み込み後: IndexedDB(鏡)と localStorage の全キーの値が一致する', mm.length === 0, JSON.stringify(mm));
    } catch (e) {
        check('テスト実行中に例外なし', false, e && e.stack || String(e));
    } finally {
        try {
            await page.evaluate((bk) => {
                if (window.__fault) { window.__fault.restore(); }
                StorageManager.getAllKeys().slice().forEach(k => StorageManager.remove(k)); localStorage.clear();
                Object.keys(bk).forEach(k => { if (bk[k] !== null) localStorage.setItem(k, bk[k]); });
            }, realBackup);
        } catch (e) {}
        check('コンソールエラーなし(意図した障害注入のログを除く)', consoleErrors.filter(e => !/crash|rolling back|rollback|recoverRosterTxn|quota|Quota|容量超過|master load error|verify|Failed to load resource|localStorage/.test(e)).length === 0, consoleErrors.slice(0, 3).join(' | '));
        await browser.close();
        const fail = results.filter(r => !r.pass).length;
        console.log('\n=== roster-transaction: ' + (results.length - fail) + ' passed / ' + fail + ' failed ===');
        process.exit(fail ? 1 : 0);
    }
})();
