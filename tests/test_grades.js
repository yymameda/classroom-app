// ===== 抽出した純粋関数のテストハーネス =====
function abcTo10(val) {
    if (val === 'A' || val === '◎') return 10;
    if (val === 'B' || val === '○') return 7;
    if (val === 'C' || val === '△') return 3;
    if (val === 3) return 10; if (val === 2) return 7; if (val === 1) return 3;
    return null;
}
function scoreTo10(score, maxScore) {
    if (score === null || score === undefined || !maxScore || maxScore <= 0) return null;
    return Math.min(10, (score / maxScore) * 10);
}
function score10ToABC(score10, aThresh, bThresh) {
    if (score10 === null || score10 === undefined) return '';
    var pct = score10 / 10 * 100;
    if (pct >= aThresh) return 'A';
    if (pct >= bThresh) return 'B';
    return 'C';
}
function abcToNum(abc) { return abc === 'A' ? 3 : abc === 'B' ? 2 : abc === 'C' ? 1 : 0; }
function calcWeightedScore(items) {
    if (!items || !items.length) return null;
    var valid = items.filter(function(it) { return it.score10 !== null && it.score10 !== undefined; });
    if (!valid.length) return null;
    var hasW = valid.some(function(it) { return it.weight !== null && it.weight !== undefined; });
    if (!hasW) { var s = 0; valid.forEach(function(it) { s += it.score10; }); return s / valid.length; }
    var wS = 0, sS = 0;
    valid.forEach(function(it) { var w = (it.weight !== null && it.weight !== undefined) ? it.weight : 0; wS += w; sS += it.score10 * w; });
    if (wS <= 0) { var s2 = 0; valid.forEach(function(it) { s2 += it.score10; }); return s2 / valid.length; }
    return sS / wS;
}
function nawatobiToScore10(grade) {
    if (grade === undefined || grade === null) return null;
    if (grade <= 0) return 10;
    if (grade > 20) return 0;
    if (grade <= 7)  return Math.round(10 - (grade - 1) * (2 / 6));
    if (grade <= 17) return Math.round(7  - (grade - 8) * (3 / 9));
    return Math.round(3 - (grade - 18) * (2 / 2));
}
var PF_EVAL_TABLE_LOCAL = {6:[39,33,27,22],7:[47,41,34,27],8:[53,46,39,32],9:[59,52,45,38],10:[65,58,50,42],11:[71,63,55,46]};
function calcPfEval(total, grade) {
    var age = parseInt(grade) + 5;
    var th = PF_EVAL_TABLE_LOCAL[age] || PF_EVAL_TABLE_LOCAL[10];
    if (total >= th[0]) return 'A';
    if (total >= th[1]) return 'B';
    if (total >= th[2]) return 'C';
    if (total >= th[3]) return 'D';
    return 'E';
}
function grdExtSuggestHyoutei(k, t, a) {
    var total = abcToNum(k) + abcToNum(t) + abcToNum(a);
    if (!k || !t || !a) return '';
    return total >= 8 ? 3 : total >= 5 ? 2 : 1;
}
// 学期判定（master をパラメータ化）
function grdGetCurrentTerm(master, now) {
    var ts = (master && master.classInfo && master.classInfo.termSystem) || 3;
    var m = now.getMonth() + 1;
    if (Number(ts) === 2) { return (m >= 4 && m <= 9) ? '1' : '2'; }
    if (m >= 4 && m <= 8) return '1';
    if (m >= 9 && m <= 12) return '2';
    return '3';
}
function grdGetTermRange(term, master, now) {
    var ts = (master && master.classInfo && master.classInfo.termSystem) || 3;
    var fy = now.getFullYear();
    if (now.getMonth() + 1 <= 3) fy--;
    if (Number(ts) === 2) {
        if (term === '1') return { start: fy+'-04-01', end: fy+'-09-30' };
        return { start: fy+'-10-01', end: (fy+1)+'-03-31' };
    }
    if (term === '1') return { start: fy+'-04-01', end: fy+'-08-31' };
    if (term === '2') return { start: fy+'-09-01', end: fy+'-12-31' };
    return { start: (fy+1)+'-01-01', end: (fy+1)+'-03-31' };
}

var pass=0, fail=0;
function eq(name, got, want) {
    var ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log('❌', name, '→ got', JSON.stringify(got), 'want', JSON.stringify(want)); }
}

// --- abcTo10 ---
eq('A→10', abcTo10('A'), 10); eq('◎→10', abcTo10('◎'), 10);
eq('B→7', abcTo10('B'), 7); eq('C→3', abcTo10('C'), 3);
eq('数値3→10', abcTo10(3), 10); eq('数値1→3', abcTo10(1), 3);
eq('不正値→null', abcTo10('D'), null);
eq('空文字→null', abcTo10(''), null);
eq('小文字a→null(要確認)', abcTo10('a'), null);   // 小文字は変換されない
eq('文字列"3"→null(要確認)', abcTo10('3'), null); // 文字列数字は変換されない

// --- scoreTo10 ---
eq('80/100→8', scoreTo10(80,100), 8);
eq('0点→0', scoreTo10(0,100), 0);
eq('満点超過はクランプ', scoreTo10(120,100), 10);
eq('max=0→null', scoreTo10(50,0), null);
eq('負の点数(検証なし)', scoreTo10(-10,100), -1);  // ← 下限クランプなし

// --- score10ToABC 境界 ---
eq('8.0/A閾値80→A', score10ToABC(8.0,80,50), 'A');
eq('7.9→B', score10ToABC(7.9,80,50), 'B');
eq('5.0→B', score10ToABC(5.0,80,50), 'B');
eq('4.9→C', score10ToABC(4.9,80,50), 'C');
eq('0→C(空でない)', score10ToABC(0,80,50), 'C');
eq('null→空', score10ToABC(null,80,50), '');
// 丸め起因の境界: 平均7.95→四捨五入で8.0→A になる
eq('7.95を丸めてから判定するとA', score10ToABC(Math.round(7.95*10)/10,80,50), 'A');

// --- calcWeightedScore ---
eq('全員重みなし→単純平均', calcWeightedScore([{score10:10},{score10:5}]), 7.5);
eq('重み付き', calcWeightedScore([{score10:10,weight:2},{score10:4,weight:1}]), 8);
eq('重み0の項目は除外扱い', calcWeightedScore([{score10:10,weight:1},{score10:0,weight:0}]), 10);
eq('全重み0→単純平均へフォールバック', calcWeightedScore([{score10:10,weight:0},{score10:4,weight:0}]), 7);
eq('null項目は除外', calcWeightedScore([{score10:null},{score10:6}]), 6);
eq('空→null', calcWeightedScore([]), null);
// ⚠️ 混在ケース: 一部だけ重み指定→未指定はw=0扱い
eq('重み一部指定: 未指定はw=0扱い', calcWeightedScore([{score10:10,weight:2},{score10:4}]), 10);

// --- nawatobi (B-2修正確認: 級が小さい=上手→高得点) ---
eq('1級→10', nawatobiToScore10(1), 10);
eq('7級→8', nawatobiToScore10(7), 8);
eq('8級→7', nawatobiToScore10(8), 7);
eq('17級→4', nawatobiToScore10(17), 4);
eq('18級→3', nawatobiToScore10(18), 3);
eq('20級→1', nawatobiToScore10(20), 1);
eq('21級→0', nawatobiToScore10(21), 0);
eq('0級→10', nawatobiToScore10(0), 10);

// --- 新体力テスト評価(5年生=10歳) ---
eq('65点→A', calcPfEval(65,5), 'A');
eq('64点→B', calcPfEval(64,5), 'B');
eq('42点→D', calcPfEval(42,5), 'D');
eq('41点→E', calcPfEval(41,5), 'E');
eq('6年生(11歳)71点→A', calcPfEval(71,6), 'A');

// --- 専科評定提案 ---
eq('AAA(9)→3', grdExtSuggestHyoutei('A','A','A'), 3);
eq('AAB(8)→3', grdExtSuggestHyoutei('A','A','B'), 3);
eq('ABB(7)→2', grdExtSuggestHyoutei('A','B','B'), 2);
eq('BBC(5)→2', grdExtSuggestHyoutei('B','B','C'), 2);
eq('BCC(4)→1', grdExtSuggestHyoutei('B','C','C'), 1);
eq('未入力→空', grdExtSuggestHyoutei('A','','A'), '');

// --- 学期判定・期間 ---
var m3 = {classInfo:{termSystem:3}}, m2 = {classInfo:{termSystem:2}};
eq('3学期制 7月→1学期', grdGetCurrentTerm(m3, new Date(2026,6,5)), '1');
eq('3学期制 9月→2学期', grdGetCurrentTerm(m3, new Date(2026,8,1)), '2');
eq('3学期制 1月→3学期', grdGetCurrentTerm(m3, new Date(2027,0,15)), '3');
eq('2学期制 9月→前期', grdGetCurrentTerm(m2, new Date(2026,8,30)), '1');
eq('2学期制 10月→後期', grdGetCurrentTerm(m2, new Date(2026,9,1)), '2');
eq('1学期範囲(3学期制)', grdGetTermRange('1', m3, new Date(2026,6,5)), {start:'2026-04-01',end:'2026-08-31'});
eq('3学期範囲: 1月に見ると正しい年度', grdGetTermRange('3', m3, new Date(2027,0,15)), {start:'2027-01-01',end:'2027-03-31'});
eq('2学期範囲: 1月に見ても前年9-12月', grdGetTermRange('2', m3, new Date(2027,0,15)), {start:'2026-09-01',end:'2026-12-31'});

console.log('\n===== 結果: PASS ' + pass + ' / FAIL ' + fail + ' =====');
