// 学期をまたいで実行しても学期フィルタ(grdCalculate/grdItemTerm等)で項目が隠れないよう、
// 実行時点の学期開始日を基準に動的に日付を生成する共通ヘルパー。
//
// index.htmlのgrdGetCurrentTerm()/grdGetTermRange()と同じ境界条件(termSystem:3の規則:
// 4〜8月=1学期・9〜12月=2学期・1〜3月=3学期)を使って学期の開始日を求め、そこからの
// 日数オフセットで日付を組み立てる。「今日がどの学期の何日目か」に関わらず常に学期の
// 冒頭付近を指すため、学期境界(4/1・8/31・9/1・12/31・1/7・3/31等)をまたいで実行しても
// 生成される日付が学期外になることはない(検証: tests/term-date-boundary.verify.js)。
//
// offsetDaysは呼び出し側が意味を持たせてよい(単一日付なら10、複数の相対日付が必要な
// 場合は10+N のように基準をずらして順序関係を保つ)。
//
// nowはテスト用の差し替え(Dateモック)のためだけの引数。省略時は実際の現在日時を使う。
function termSafeDate(offsetDays, now) {
    now = now || new Date();
    var m = now.getMonth() + 1, fy = now.getFullYear();
    if (m <= 3) fy -= 1;
    var startMonth = (m >= 4 && m <= 8) ? 4 : (m >= 9 && m <= 12) ? 9 : 1;
    var startYear = startMonth === 1 ? fy + 1 : fy;
    var d = new Date(startYear, startMonth - 1, 1);
    d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = { termSafeDate };
