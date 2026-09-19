// 名簿の付け替え(H4 段階2)の検証用データ生成と「持ち主」の照合。
//
// 全18ストアに、児童ごとの持ち主の目印(studentId)を埋め込んだデータを作り、付け替え後に
// 「その添字の児童のデータか」を照合する(index.html のロジックを再実装せず、目印だけで判定する)。
// 本体に目印を持てない値(出席簿の '×' など)は、児童ごとに固有の日付/席/文字番号を割り当てて表す。
//
// 使い方(K は index.html の KEYS。page.evaluate(() => KEYS) で取得して渡す):
//   const raws = buildRaws(K, students)            // students: [{studentId, name, …}]
//   const owners = ownersOf(K, raws, originalIds)   // {ストア名: [{idx, owner}]}
//   const bad = misplaced(owners, newStudents)      // {ストア名: 'ずれ件数/総数'}(全部 '0/…' ならずれ0)

const pad = (n) => String(n).padStart(2, '0');
// 児童k(0始まり)専用の日付。最大30人(1クラスの最大児童数)を想定して 2026-04-01〜04-30
const D = (k) => '2026-04-' + pad(k + 1);
const SEAT = (k) => 'seat' + k;

// ストアの表示名(報告用)
const LABELS = {
    scores: '記録(実技記録含む)', submissions_data: '提出記録', patrol: '机間巡視', karte_recs: 'カルテ児童記録',
    karte_life: 'カルテ生活', karte_parent: 'カルテ保護者', karte_health: 'カルテ身体配慮', karte_learning: 'カルテ学習配慮',
    grades_ext_pdf_comments: '専科PDFコメント', attendance: '出席簿', attendance_notice: '出欠届', morning_prep: '朝の準備',
    forgotten_daily: '忘れ物', submissions_diary: '日記帳', forgotten_history: '忘れ物集計(派生)', kanji: '漢字チェック',
    seating: '座席', grades_external: '専科成績'
};
const STORE_NAMES = Object.keys(LABELS);

function buildRaws(K, students) {
    const n = students.length;
    const id = (i) => students[i].studentId;
    const idxs = students.map((s, i) => i);
    const byIdx = (f) => { const o = {}; idxs.forEach((i) => { o[String(i)] = f(i); }); return o; };
    const byDate = (f) => { const o = {}; idxs.forEach((k) => { o[D(k)] = {}; o[D(k)][String(k)] = f(k); }); return o; };
    const raws = {};
    raws[K.scores] = JSON.stringify(idxs.map((i) => ({ id: i + 1, studentIndex: i, testId: 1, score: 50 + i, _owner: id(i) })));
    raws[K.submissions_data] = JSON.stringify(idxs.map((i) => ({ id: i + 1, studentIndex: i, assignmentId: 101, status: 'submitted', _owner: id(i) })));
    raws[K.patrol] = JSON.stringify(idxs.map((i) => ({ id: i + 1, sessionKey: 's', studentIndex: i, subject: '算数', evals: {}, _owner: id(i) })));
    // カルテ児童記録は偶数番の児童に2件(1児童複数レコードの付け替えを確認)
    const recs = [];
    idxs.forEach((i) => { recs.push({ id: recs.length + 1, studentIndex: i, date: '2026-05-01', memo: 'a', _owner: id(i) }); if (i % 2 === 0) recs.push({ id: recs.length + 1, studentIndex: i, date: '2026-05-02', memo: 'b', _owner: id(i) }); });
    raws[K.karte_recs] = JSON.stringify(recs);
    raws[K.karte_life] = JSON.stringify(byIdx((i) => [{ id: 1, date: '2026-05-01', summary: 'x', _owner: id(i) }]));
    raws[K.karte_parent] = JSON.stringify(byIdx((i) => [{ id: 1, datetime: '2026-05-01T10:00', _owner: id(i) }]));
    raws[K.karte_health] = JSON.stringify(byIdx((i) => ({ allergies: [], medication: '', exerciseLimit: '', familyMemo: id(i) })));
    raws[K.karte_learning] = JSON.stringify(byIdx((i) => ({ characteristics: id(i) })));
    raws[K.grades_ext_pdf_comments] = JSON.stringify(byIdx((i) => id(i)));
    raws[K.attendance] = JSON.stringify(byDate(() => '×'));
    raws[K.attendance_notice] = JSON.stringify(byDate(() => true));
    raws[K.morning_prep] = JSON.stringify(byDate(() => true));
    raws[K.forgotten_daily] = JSON.stringify(byDate((k) => [id(k)]));
    raws[K.submissions_diary] = JSON.stringify(byDate((k) => k + 1));
    const hist = {}; idxs.forEach((k) => { hist[D(k)] = { total: k + 1, students: { [String(k)]: k + 1 } }; });
    raws[K.forgotten_history] = JSON.stringify(hist);
    const checks = {}; idxs.forEach((i) => { checks[String(i)] = { [String(i)]: 'o' }; }); // 児童iは「文字番号i」にだけ印がある
    raws[K.kanji] = JSON.stringify({ chars: idxs.map((i) => '字' + i), checks: checks });
    const seats = {}; idxs.forEach((k) => { seats[SEAT(k)] = k; });
    raws[K.seating] = JSON.stringify(seats);
    raws[K.grades_external] = JSON.stringify({ subjects: ['音楽'], data: { 音楽: byIdx((i) => ({ k: 'A', t: 'B', a: 'A', h: 3, _owner: id(i) })) } });
    return raws;
}

// 付け替え後の生JSON(rawMap)から、各ストアの「添字 → 持ち主(元のstudentId)」を読み出す。
// originalIds: 付け替え前の名簿の studentId 配列(日付・席・文字番号の目印を元の児童へ戻すために使う)
function ownersOf(K, rawMap, originalIds) {
    const out = {};
    const P = (key) => (rawMap[key] === undefined || rawMap[key] === null) ? null : JSON.parse(rawMap[key]);
    const arr = (key) => { const d = P(key); return (Array.isArray(d) ? d : []).map((r) => ({ idx: Number(r.studentIndex), owner: r._owner })); };
    const keyed = (key, f) => { const d = P(key); return Object.keys(d || {}).map((k) => ({ idx: Number(k), owner: f(d[k]) })); };
    const dateKeyed = (key, dateOwner) => {
        const d = P(key) || {}; const list = [];
        Object.keys(d).forEach((date) => Object.keys(d[date] || {}).forEach((k) => list.push({ idx: Number(k), owner: dateOwner(date) })));
        return list;
    };
    const ownerOfDate = (date) => originalIds[parseInt(date.slice(-2), 10) - 1];
    out.scores = arr(K.scores); out.submissions_data = arr(K.submissions_data); out.patrol = arr(K.patrol); out.karte_recs = arr(K.karte_recs);
    out.karte_life = keyed(K.karte_life, (v) => v[0]._owner);
    out.karte_parent = keyed(K.karte_parent, (v) => v[0]._owner);
    out.karte_health = keyed(K.karte_health, (v) => v.familyMemo);
    out.karte_learning = keyed(K.karte_learning, (v) => v.characteristics);
    out.grades_ext_pdf_comments = keyed(K.grades_ext_pdf_comments, (v) => v);
    out.attendance = dateKeyed(K.attendance, ownerOfDate);
    out.attendance_notice = dateKeyed(K.attendance_notice, ownerOfDate);
    out.morning_prep = dateKeyed(K.morning_prep, ownerOfDate);
    out.forgotten_daily = dateKeyed(K.forgotten_daily, ownerOfDate);
    out.submissions_diary = dateKeyed(K.submissions_diary, ownerOfDate);
    const h = P(K.forgotten_history) || {}; out.forgotten_history = [];
    Object.keys(h).forEach((date) => Object.keys(h[date].students || {}).forEach((k) => out.forgotten_history.push({ idx: Number(k), owner: ownerOfDate(date) })));
    const kj = P(K.kanji) || { checks: {} }; out.kanji = [];
    Object.keys(kj.checks || {}).forEach((k) => Object.keys(kj.checks[k]).forEach((c) => out.kanji.push({ idx: Number(k), owner: originalIds[Number(c)] })));
    const st = P(K.seating) || {}; out.seating = Object.keys(st).map((seat) => ({ idx: Number(st[seat]), owner: originalIds[parseInt(seat.slice(4), 10)] }));
    const ge = P(K.grades_external) || { data: {} }; out.grades_external = [];
    Object.keys(ge.data || {}).forEach((subj) => Object.keys(ge.data[subj]).forEach((k) => out.grades_external.push({ idx: Number(k), owner: ge.data[subj][k]._owner })));
    return out;
}

// 付け替え後の名簿(newStudents)に対し、各ストアで「添字iのデータの持ち主 ≠ newStudents[i].studentId」の件数を数える。
// 転入生(studentId無し)の添字にデータがあればずれとして数える。戻り値: {ストア名: {shifted, total}}
function misplaced(owners, newStudents) {
    const res = {};
    Object.keys(owners).forEach((name) => {
        let shifted = 0;
        owners[name].forEach((e) => {
            const s = newStudents[e.idx];
            if (!s || !s.studentId || s.studentId !== e.owner) shifted++;
        });
        res[name] = { shifted: shifted, total: owners[name].length };
    });
    return res;
}

// 名簿操作(6種類)。base: 付け替え前の名簿(studentId付き)。戻り値: 新しい名簿(転入生は studentId 無し)
const OPS = [
    { name: 'R0 同一名簿(何も変えない)', make: (b) => b.map((s) => Object.assign({}, s)) },
    { name: 'R1 並べ替え(先頭2名を入替)', make: (b) => { const c = b.map((s) => Object.assign({}, s)); const t = c[0]; c[0] = c[1]; c[1] = t; return c; } },
    { name: 'R2 途中削除(2番目を削除)', make: (b) => b.filter((s, i) => i !== 1).map((s) => Object.assign({}, s)) },
    { name: 'R3 途中挿入(3番目に転入生)', make: (b) => { const c = b.map((s) => Object.assign({}, s)); c.splice(2, 0, { name: '転入生', gender: '男' }); return c; } },
    { name: 'R4 末尾追加(転入生を最後に)', make: (b) => b.map((s) => Object.assign({}, s)).concat([{ name: '転入生', gender: '男' }]) },
    { name: 'R5 改名(位置・IDは同じ)', make: (b) => b.map((s, i) => Object.assign({}, s, i === 1 ? { name: s.name + '（改名）' } : {})) }
];

const mkStudents = (n) => Array.from({ length: n }, (_, i) => ({ studentId: 'stu_' + String(i).padStart(8, '0'), name: '児童' + i, gender: i % 2 ? '女' : '男', visionL: 'A', height: 130 + i }));

module.exports = { buildRaws, ownersOf, misplaced, OPS, LABELS, STORE_NAMES, mkStudents, D, SEAT };
