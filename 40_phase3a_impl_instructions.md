# フェーズ3a 実装指示書(Claude Code 用)

**作成日**: 2026-05-28
**対象**: index.html v1.7.61 → v1.8.0
**前提資料**: `30_phase3_plan.md`, `31_phase3a_design.md`
**この指示書の役割**: 設計書(31)を実コード(v1.7.61)に照らして検証し、Claude Code が `str_replace` で迷わず実装できる具体指示に落とし込んだもの。

---

## ⚠️ 最重要: 設計書との差異(実コード検証で判明)

設計書 `31_phase3a_design.md` は概念設計として正しいが、コード断片が実コードと細部で異なる。**以下の差異を必ず優先**すること。

### 差異1: `recNwCalcGrade` は「級」を返す(stage ではない)

実コード(L5714-5725):
```javascript
function recNwCalcGrade(passData) {
    var catOrder = ['hop', 'step', 'jump', 'high'];
    var total = 0;
    for (var ci = 0; ci < catOrder.length; ci++) {
        var catId = catOrder[ci];
        var catSkills = REC_NW_SKILLS.filter(function(s) { return s.cat === catId; });
        var passed = catSkills.filter(function(s) { return passData[s.id] === 1; }).length;
        total += passed;
        if (passed < catSkills.length) break;
    }
    return Math.max(21 - total, 0);   // ← 「級」を返す(total=合格累計、21-totalが級)
}
```

**関係の整理**:
- `total`(合格累計技数) = 設計書の **stage**
- `recNwCalcGrade` の戻り値 = **級**(`21 - total`、最大21技で0=マスター)
- なわとびは総21技。stage=21 で grade=0(マスター)

### 差異2: `REC_NW_SKILLS` は `{id, short, cat}` のみ

実コード(L5690-5712)は `name`/`desc` を持たない。設計書 §3.1 の `name` 付き定義は採用せず、**実コードの形式 `{id, short, cat}` に泳力検定も合わせる**。ただし泳力検定は説明文が教育上有用なので、任意フィールド `desc` のみ追加してよい(UI で使うかは Step 5 で判断)。

### 差異3: peUnit の選択肢に「タイム差」は存在しない

実コードの peUnit select(L2217-2220)の値は:
`秒` / `分秒` / `回` / `m` / `cm` / `点` / `なわとびカード`

設計書 §4.2 の `peRecordToScore10` 修正案にある `'タイム差'` 分岐は **実コードには無い**。実コードの `peRecordToScore10`(L8657-8665)を正確な改修ベースにすること。

### 差異4: バグ確定箇所

- **保存側 L5797-5798**: `score: totalPassed` ← 合格技数を保存
- **換算側 L8659**: `nawatobiToScore10(sr.score)` ← それを級として解釈
- `recNwCalcGrade` で級を計算しているのに(L5794)、保存していない(捨てている)

---

## 実装の基本ルール(累積運用ルールより)

- **str_replace 差分編集のみ**。create_file での全書き換え禁止。
- **各 Step 完了ごとに `node --check index.html` で構文確認**してからコミット。
- **毎プッシュで sw.js の CACHE_VERSION を更新**。
- **`_VER`(L11240)も各 Step で更新**: 'v1.7.61' → 各 Step のバージョン。
- **各 Edit で old_str / new_str を必ず目視確認**。
- トークン節約のため、必要箇所のみ view する。

---

## Step 1: KenteiCard 共通モジュール骨格(v1.7.62)

### 目的
なわとび・泳力共通の検定カード抽象を導入。**この Step では既存のなわとび動作を一切変えない**(新モジュールを追加するだけ)。

### 1-1. KenteiPresets と共通関数を追加

**挿入位置**: L5712(`REC_NW_SKILLS` 配列の閉じ括弧 `];` の直後、`recNwCalcGrade` の直前)

**old_str**(L5711-5713 を目印に):
```javascript
            { id: 'x3', short: '連続難',     cat: 'high' }
        ];

        function recNwCalcGrade(passData) {
```

**new_str**: 上記に続けて、`recNwCalcGrade` の前に以下を挿入。

```javascript
            { id: 'x3', short: '連続難',     cat: 'high' }
        ];

        // ============================================================
        // KenteiCard 共通モジュール (フェーズ3a, v1.8.0)
        // なわとび・泳力検定など「級ベース検定カード」の汎用基盤
        // ============================================================
        var KenteiPresets = {
            nawatobi: {
                id: 'nawatobi',
                name: 'なわとびカード',
                emoji: '🪢',
                // 実コードの REC_NW_CATS / REC_NW_SKILLS と完全一致させる
                categories: [
                    { id: 'hop',  name: 'ホップ',       color: '#4CAF50', skills: [
                        { id: 'h1', short: '両足前' }, { id: 'h2', short: '両足後' },
                        { id: 'h3', short: 'かけ足前' }, { id: 'h4', short: 'かけ足後' },
                        { id: 'h5', short: '片足前' }, { id: 'h6', short: '片足後' }
                    ]},
                    { id: 'step', name: 'ステップ',     color: '#2196F3', skills: [
                        { id: 's1', short: 'ｸﾞｰﾊﾟｰ前' }, { id: 's2', short: 'ｸﾞｰﾊﾟｰ後' },
                        { id: 's3', short: 'ｸﾞｰﾁｮｷ前' }, { id: 's4', short: 'ｸﾞｰﾁｮｷ後' },
                        { id: 's5', short: 'あや前' }, { id: 's6', short: 'こうさ前' }
                    ]},
                    { id: 'jump', name: 'ジャンプ',     color: '#FF9800', skills: [
                        { id: 'j1', short: 'あや後' }, { id: 'j2', short: 'こうさ後' },
                        { id: 'j3', short: 'ｻｲﾄﾞ前' }, { id: 'j4', short: 'ｻｲﾄﾞ後' },
                        { id: 'j5', short: 'ﾏﾘｰﾅ前' }, { id: 'j6', short: '二重前' }
                    ]},
                    { id: 'high', name: 'ハイジャンプ', color: '#E91E63', isMaster: true, skills: [
                        { id: 'x1', short: '二重後' }, { id: 'x2', short: '連続易' },
                        { id: 'x3', short: '連続難' }
                    ]}
                ],
                // stage(=合格累計技数) → ラベル。なわとびは総21技。
                stageToLabel: function(stage) {
                    if (stage <= 0) return '-';
                    if (stage >= 21) return 'マスター';
                    return (21 - stage) + '級';
                },
                // 換算表プリセット: 既存 nawatobiToScore10(級) を stage ベースに写経
                defaultConversionTable: function() {
                    var self = this; var table = [];
                    for (var stage = 0; stage <= 21; stage++) {
                        table.push({ stage: stage, label: self.stageToLabel(stage),
                            score10: kenteiNawatobiStageScore10(stage) });
                    }
                    return table;
                }
            },
            swimming: {
                id: 'swimming',
                name: '泳力検定カード',
                emoji: '🏊',
                // PDF(R8 泳力検定カード)に基づく。総24技。
                categories: [
                    { id: 'hop',  name: 'ホップ',       color: '#4CAF50', skills: [
                        { id: 'sh1', short: 'かけっこ',   desc: '水中を10m走る' },
                        { id: 'sh2', short: 'もぐる易',   desc: '水中にもぐる' },
                        { id: 'sh3', short: 'もぐる難',   desc: '水中に5秒もぐる' },
                        { id: 'sh4', short: 'バブリング', desc: '水中で息をはく(細く長く、3秒)' },
                        { id: 'sh5', short: 'ボビング',   desc: '水中で息をはき、とびあがって空気中で息を吸う' },
                        { id: 'sh6', short: 'ふしうき易', desc: 'かべにつかまって伏し浮き' }
                    ]},
                    { id: 'step', name: 'ステップ',     color: '#2196F3', skills: [
                        { id: 'ss1', short: 'ふしうき難', desc: '伏し浮きを5秒' },
                        { id: 'ss2', short: 'せうき',     desc: '背浮きを5秒' },
                        { id: 'ss3', short: 'け伸び',     desc: 'かべをけって、体を一直線にする' },
                        { id: 'ss4', short: '面ｸﾛｰﾙ',   desc: '呼吸をしないクロールをする' },
                        { id: 'ss5', short: '面平泳',    desc: '呼吸をしない平泳ぎをする' },
                        { id: 'ss6', short: 'かんたん泳', desc: '呼吸をしながら25m泳ぐ(背泳ぎ・ドル平も可)' }
                    ]},
                    { id: 'jump', name: 'ジャンプ',     color: '#FF9800', skills: [
                        { id: 'sj1', short: 'ｸﾛｰﾙ',     desc: 'クロールで25m泳ぐ' },
                        { id: 'sj2', short: '平泳ぎ',     desc: '平泳ぎで25m泳ぐ' },
                        { id: 'sj3', short: 'ｸﾛｰﾙ長',   desc: 'クロールで50m泳ぐ' },
                        { id: 'sj4', short: '平泳長',     desc: '平泳ぎで50m泳ぐ' },
                        { id: 'sj5', short: 'ｸﾛｰﾙ速',   desc: '25mを30秒以内' },
                        { id: 'sj6', short: '平泳速',     desc: '25mを40秒以内' }
                    ]},
                    { id: 'high', name: 'ハイジャンプ', color: '#E91E63', isMaster: true, skills: [
                        { id: 'sx1', short: 'M6', desc: 'マスター6: クロールで100m泳ぐ' },
                        { id: 'sx2', short: 'M5', desc: 'マスター5: 平泳ぎで100m泳ぐ' },
                        { id: 'sx3', short: 'M4', desc: 'マスター4: 25mを25秒以内' },
                        { id: 'sx4', short: 'M3', desc: 'マスター3: 25mを35秒以内' },
                        { id: 'sx5', short: 'M2', desc: 'マスター2: クロールで50m泳ぐ' },
                        { id: 'sx6', short: 'M1', desc: 'マスター1: 平泳ぎで50m泳ぐ(究極)' }
                    ]}
                ],
                // stage(=合格累計技数) → ラベル。総24技。stage19-24がマスター6-1。
                stageToLabel: function(stage) {
                    if (stage <= 0) return '-';
                    if (stage >= 19) return 'マスター' + (25 - stage);  // 19→M6 ... 24→M1
                    return (19 - stage) + '級';                          // 1→18級 ... 18→1級
                },
                // 換算表プリセット: 倍率1(上から10、下を0)
                defaultConversionTable: function() {
                    var self = this; var table = []; var maxStage = 24;
                    for (var stage = 0; stage <= maxStage; stage++) {
                        var score10 = Math.round((stage / maxStage) * 10 * 10) / 10;
                        table.push({ stage: stage, label: self.stageToLabel(stage), score10: score10 });
                    }
                    return table;
                }
            }
        };

        // なわとび専用: stage(合格累計) → 10点。既存 nawatobiToScore10(級) と等価になるよう写経。
        function kenteiNawatobiStageScore10(stage) {
            if (stage === undefined || stage === null) return null;
            if (stage >= 21) return 10;     // マスター
            if (stage <= 0) return 0;       // 何も合格していない(旧 grade>20 → 0 に対応)
            var grade = 21 - stage;         // stage → 級
            if (grade <= 0) return 10;
            if (grade > 20) return 0;
            if (grade <= 7)  return Math.round(10 - (grade - 1) * (2 / 6));
            if (grade <= 17) return Math.round(7  - (grade - 8) * (3 / 9));
            return Math.round(3 - (grade - 18) * (2 / 2));
        }

        // peUnit 文字列 → プリセットID。後方互換: 'なわとびカード' は nawatobi。
        function kenteiGetPresetId(peUnit) {
            if (!peUnit) return null;
            if (peUnit === 'なわとびカード') return 'nawatobi';
            if (peUnit.indexOf('検定:') === 0) return peUnit.substring(3);
            return null;
        }

        // テストオブジェクト → config。kenteiConfig があれば優先、なければプリセットから構築。
        function kenteiGetConfig(test) {
            if (!test) return null;
            if (test.kenteiConfig) return test.kenteiConfig;
            var pid = kenteiGetPresetId(test.peUnit);
            if (pid && KenteiPresets[pid]) return kenteiBuildFromPreset(pid);
            return null;
        }

        function kenteiBuildFromPreset(presetId) {
            var preset = KenteiPresets[presetId];
            if (!preset) return null;
            return {
                presetId: presetId,
                categories: JSON.parse(JSON.stringify(preset.categories)),
                _presetId: presetId,
                conversionTable: preset.defaultConversionTable()
            };
        }

        // config の総技数
        function kenteiTotalSkills(config) {
            if (!config) return 0;
            return config.categories.reduce(function(n, c) { return n + c.skills.length; }, 0);
        }

        // passData → stage(合格累計技数)。カテゴリ順に進み、未完了カテゴリで打ち切り。
        function kenteiCalcStage(config, passData) {
            if (!config || !passData) return 0;
            var total = 0;
            for (var ci = 0; ci < config.categories.length; ci++) {
                var cat = config.categories[ci];
                var passed = cat.skills.filter(function(s) { return passData[s.id] === 1; }).length;
                total += passed;
                if (passed < cat.skills.length) break;
            }
            return total;
        }

        // stage → ラベル
        function kenteiStageToLabel(config, stage) {
            if (!config) return '-';
            if (config._presetId && KenteiPresets[config._presetId]) {
                return KenteiPresets[config._presetId].stageToLabel(stage);
            }
            var row = (config.conversionTable || []).find(function(r) { return r.stage === stage; });
            return row ? row.label : (stage + '段階');
        }

        // stage → 10点。conversionTable を引く。
        function kenteiStageToScore10(config, stage) {
            if (!config || stage === null || stage === undefined) return null;
            var row = (config.conversionTable || []).find(function(r) { return r.stage === stage; });
            return row ? row.score10 : null;
        }

        // カテゴリがロック(前カテゴリ未完了)か
        function kenteiIsLocked(config, catId, passData) {
            if (!config) return false;
            var idx = config.categories.findIndex(function(c) { return c.id === catId; });
            if (idx <= 0) return false;
            for (var i = 0; i < idx; i++) {
                var prev = config.categories[i];
                var cnt = prev.skills.filter(function(s) { return passData[s.id] === 1; }).length;
                if (cnt < prev.skills.length) return true;
            }
            return false;
        }
        // ============================================================
        // KenteiCard 共通モジュール ここまで
        // ============================================================

        function recNwCalcGrade(passData) {
```

### 1-2. 検証(Step 1)

- `node --check index.html` が通ること
- ブラウザで既存のなわとびテストを開き、**動作が変わっていないこと**(まだ既存コードを使っているため当然変わらない)
- コンソールで以下を確認:
  ```javascript
  var c = kenteiBuildFromPreset('swimming');
  kenteiTotalSkills(c);                    // → 24
  kenteiCalcStage(c, {});                  // → 0
  kenteiStageToLabel(c, 24);               // → 'マスター1'
  kenteiStageToLabel(c, 18);               // → '1級'
  kenteiStageToScore10(c, 24);             // → 10
  var n = kenteiBuildFromPreset('nawatobi');
  kenteiStageToScore10(n, 21);             // → 10 (マスター)
  kenteiStageToScore10(n, 0);              // → 0
  ```

### 1-3. バージョン更新とコミット
- `_VER` を 'v1.7.62' に、sw.js の CACHE_VERSION を更新
- コミット: `feat: KenteiCard共通モジュール追加 (フェーズ3a Step1) v1.7.62`

---

## Step 2: B-2 なわとび級換算バグ修正(v1.7.63)

### 目的
合格技数を級と誤解釈するバグを根治。`peRecordToScore10` を検定カード対応にする。**保存側はまだ変えない**(Step 4 で対応)。換算側だけ先に正す。

### 2-1. `peRecordToScore10` の修正

**old_str**(L8657-8665):
```javascript
        function peRecordToScore10(sr, test) {
            if (!sr || sr.score === null || sr.score === undefined) return null;
            if (test.peUnit === 'なわとびカード') return nawatobiToScore10(sr.score);
            if (test.peUnit === 'タイム差') { var s = sr.finalScore !== undefined ? sr.finalScore : sr.score; return s !== null ? Math.min(10, s) : null; }
            if (test.peUnit === '回' && sr.peManualABC) return sr.peManualABC === 'A' ? 10 : sr.peManualABC === 'B' ? 7 : 4;
            var max = test.maxScore || 10;
            if (max > 0 && typeof sr.score === 'number') return Math.min(10, Math.round(sr.score / max * 10 * 10) / 10);
            return null;
        }
```

**new_str**:
```javascript
        function peRecordToScore10(sr, test) {
            if (!sr) return null;
            // === 検定カード型(なわとび・泳力など) ===
            var kConfig = kenteiGetConfig(test);
            if (kConfig) {
                // 優先順位: 1)保存済 score10  2)保存済 stage  3)passData から再計算
                if (typeof sr.score10 === 'number') return sr.score10;
                var pd = sr.passData || sr.nawatobiData || null;
                var stage;
                if (typeof sr.stage === 'number') {
                    stage = sr.stage;
                } else if (pd) {
                    stage = kenteiCalcStage(kConfig, pd);
                } else {
                    // 旧データ救済: score に合格技数(totalPassed)が入っている前提で stage とみなす
                    stage = (typeof sr.score === 'number') ? sr.score : 0;
                }
                return kenteiStageToScore10(kConfig, stage);
            }
            // === 以下、従来の実技記録ロジック(変更なし) ===
            if (sr.score === null || sr.score === undefined) return null;
            if (test.peUnit === 'タイム差') { var s = sr.finalScore !== undefined ? sr.finalScore : sr.score; return s !== null ? Math.min(10, s) : null; }
            if (test.peUnit === '回' && sr.peManualABC) return sr.peManualABC === 'A' ? 10 : sr.peManualABC === 'B' ? 7 : 4;
            var max = test.maxScore || 10;
            if (max > 0 && typeof sr.score === 'number') return Math.min(10, Math.round(sr.score / max * 10 * 10) / 10);
            return null;
        }
```

**注**: 旧 `nawatobiToScore10`(L8649-8656)は **削除しない**。他から呼ばれていないか grep で確認し、呼び出しが L8659 のみだったなら未使用になるが、後方互換のため残置でよい(デッドコードコメントを付ける程度)。

### 2-2. バグ修正の意味(検証時の理解用)

旧データ(`score`=合格技数、`nawatobiData`あり)に対して:
- 新ロジックは `sr.nawatobiData` から `kenteiCalcStage` で正しい stage を計算
- もし nawatobiData が無い古いデータでも、`score`(=合格技数=stage)を救済利用
- **結果**: 合格技数0 → stage0 → 0点(旧: 級0=10点だった誤りを修正)

### 2-3. 検証(Step 2)
- `node --check`
- 既存なわとびテストを開いて成績計算 → 修正前と点数が変わることを確認(特に合格技数が少ない児童が低点になる)
- 監査診断機能(データ出力タブ)でエラーが出ないこと

### 2-4. バージョン更新とコミット
- `_VER` 'v1.7.63'、sw.js 更新
- コミット: `fix: B-2 なわとび級換算バグ修正 (フェーズ3a Step2) v1.7.63`

---

## Step 3: マイグレーション実装(v1.7.64)

### 目的
既存の検定カードスコアに `stage` / `score10` / `passData` を付与して正規化。冪等性確保。

### 3-1. マイグレーション関数を追加

**挿入位置**: `migrateScoreData` 関数(L3544-)の直後。まず L3544 周辺を view して関数の閉じ括弧位置を特定し、その直後に挿入すること。

挿入する関数:
```javascript
        function migrateKenteiCardScores() {
            try {
                if (localStorage.getItem('migration_kenteiCard_v1')) return; // 冪等
                var rawT = localStorage.getItem('spa_tests');
                var rawS = localStorage.getItem('spa_scores');
                if (!rawT || !rawS) { localStorage.setItem('migration_kenteiCard_v1', JSON.stringify({skipped:true, ts:new Date().toISOString()})); return; }
                var tests = JSON.parse(rawT);
                var scores = JSON.parse(rawS);
                var kmap = {};
                tests.forEach(function(t) {
                    var cfg = kenteiGetConfig(t);
                    if (cfg) kmap[t.id] = cfg;
                });
                var migrated = 0, changed = false;
                scores.forEach(function(sc) {
                    var cfg = kmap[sc.testId];
                    if (!cfg) return;
                    if (typeof sc.stage === 'number' && typeof sc.score10 === 'number') return;
                    var pd = sc.passData || sc.nawatobiData || {};
                    sc.passData = pd;
                    sc.stage = kenteiCalcStage(cfg, pd);
                    sc.score10 = kenteiStageToScore10(cfg, sc.stage);
                    sc.score = sc.stage;            // score の意味を段階番号に統一
                    if (!sc.nawatobiData) sc.nawatobiData = pd;
                    migrated++; changed = true;
                });
                if (changed) localStorage.setItem('spa_scores', JSON.stringify(scores));
                localStorage.setItem('migration_kenteiCard_v1', JSON.stringify({ count: migrated, ts: new Date().toISOString() }));
                if (migrated > 0) console.log('migrateKenteiCardScores: ' + migrated + '件を正規化');
            } catch(e) { console.error('migrateKenteiCardScores error', e); }
        }
```

**注意**: この関数は localStorage を直接読む。StorageManager 経由が望ましい場合は実コードの `migrateScoreData` の流儀(L3556 周辺)に合わせること。**migrateScoreData がどうデータを読み書きしているか L3544-3604 を view して同じ方式に揃える**こと。

### 3-2. INIT に組み込み

**old_str**(L3607-3608):
```javascript
    document.addEventListener('DOMContentLoaded', function() {
        migrateScoreData();
```

**new_str**:
```javascript
    document.addEventListener('DOMContentLoaded', function() {
        migrateScoreData();
        migrateKenteiCardScores();
```

### 3-3. 検証(Step 3)
- `node --check`
- **実バックアップで検証**(y.y さんの環境):
  - マイグレーション前にバックアップ取得(必須)
  - 監査診断で現状記録
  - リロードしてマイグレーション実行
  - 監査診断で stage/score10 が付与されたか確認
  - 2回リロード → 2回目はスキップ(冪等性)
- なわとびスコアの旧 `score`(合格技数)と新 `stage` が一致することを確認

### 3-4. バージョン更新とコミット
- `_VER` 'v1.7.64'、sw.js 更新
- コミット: `feat: 検定カードスコアのマイグレーション (フェーズ3a Step3) v1.7.64`

---

## Step 4: UI 汎用化 + 保存側修正(v1.7.65)

### 目的
なわとびカードUI を検定カード汎用に拡張。保存処理(L5786 recNwToggle)を stage/score10 保存に修正。**既存なわとびの見た目・動作は維持**。

### 4-1. 保存処理 recNwToggle の修正

**old_str**(L5786-5803):
```javascript
        window.recNwToggle = function(studentIndex, skillId) {
            var test = recGetTests().find(function(t) { return t.id === recCurrentTestId; });
            if (!test || test.peUnit !== 'なわとびカード') return;
            var scores = recGetScores();
            var ei = scores.findIndex(function(s) { return s.studentIndex === studentIndex && s.testId === recCurrentTestId; });
            var sc = ei >= 0 ? scores[ei] : null;
            var passData = (sc && sc.nawatobiData) ? JSON.parse(JSON.stringify(sc.nawatobiData)) : {};
            passData[skillId] = passData[skillId] === 1 ? 0 : 1;
            var grade = recNwCalcGrade(passData);
            var totalPassed = REC_NW_SKILLS.filter(function(s) { return passData[s.id] === 1; }).length;
            var hasRecord = totalPassed > 0;
            var rec = { id: Date.now(), studentIndex: studentIndex, testId: recCurrentTestId,
                score: totalPassed, nawatobiData: passData, createdAt: new Date().toISOString() };
            if (ei >= 0) scores[ei] = rec; else scores.push(rec);
            recSaveScores(scores);
            recNwUpdateCardUI(studentIndex, passData, grade, hasRecord);
            recUpdateProgressByCount();
        };
```

**new_str**:
```javascript
        window.recNwToggle = function(studentIndex, skillId) {
            var test = recGetTests().find(function(t) { return t.id === recCurrentTestId; });
            if (!test) return;
            var config = kenteiGetConfig(test);
            if (!config) return;
            var scores = recGetScores();
            var ei = scores.findIndex(function(s) { return s.studentIndex === studentIndex && s.testId === recCurrentTestId; });
            var sc = ei >= 0 ? scores[ei] : null;
            var passData = (sc && (sc.passData || sc.nawatobiData)) ? JSON.parse(JSON.stringify(sc.passData || sc.nawatobiData)) : {};
            passData[skillId] = passData[skillId] === 1 ? 0 : 1;
            var stage = kenteiCalcStage(config, passData);
            var score10 = kenteiStageToScore10(config, stage);
            var grade = recNwCalcGrade(passData); // 既存UI(なわとび)互換のため級も計算
            var hasRecord = stage > 0;
            var rec = { id: Date.now(), studentIndex: studentIndex, testId: recCurrentTestId,
                passData: passData, stage: stage, score10: score10,
                nawatobiData: passData, score: stage,
                createdAt: new Date().toISOString() };
            if (ei >= 0) scores[ei] = rec; else scores.push(rec);
            recSaveScores(scores);
            recNwUpdateCardUI(studentIndex, passData, grade, hasRecord);
            recUpdateProgressByCount();
        };
```

**重要**: `if (!test || test.peUnit !== 'なわとびカード') return;` を `kenteiGetConfig` 判定に変えることで、泳力検定でもこのトグルが動くようになる。

### 4-2. カード描画・UI更新の汎用化(慎重に)

`recBuildNawatobiCard`(L5744-)と `recNwUpdateCardUI`(L5805-)は `REC_NW_SKILLS` / `REC_NW_CATS` をハードコード参照している。これを **test の config 参照に変える**。

この改修は影響が大きいため、**まず L5744-5830 全体を view してから**、以下の方針で進める:
- `REC_NW_SKILLS` → `config.categories.flatMap(c => c.skills)` 相当
- `REC_NW_CATS` → `config.categories`
- スキル要素は `{id, short}` を使う(泳力も同形式)
- **ロック判定は `kenteiIsLocked(config, ...)` に置換**(既存 `recNwIsLocked` は残置可)

この Step は既存なわとびの見た目を壊さないことが最優先。**Step 4 着手時に現物コードを見て、差分を最小化する**こと。指示書のこの部分は方針提示にとどめ、具体 old_str/new_str は実コード確認後に確定する。

### 4-3. isNawatobi 判定の汎用化(L5425, L5578)

2箇所の `var isNawatobi = ... test.peUnit === 'なわとびカード';` を、検定カード全般を捕捉するよう変更:

L5578 の例:
**old_str**: `var isNawatobi = test.testType === '実技記録' && test.peUnit === 'なわとびカード';`
**new_str**: `var isNawatobi = test.testType === '実技記録' && kenteiGetPresetId(test.peUnit) !== null;`

L5425 も同様(`isPE &&` の形を維持しつつ peUnit 判定を `kenteiGetPresetId(...) !== null` に)。変数名 isNawatobi はそのままでよい(意味は「検定カードか」に拡張)。

### 4-4. 検証(Step 4)
- `node --check`
- 既存なわとびテスト: カード表示・トグル・級表示が**従来通り**動くこと
- トグル後、保存データに stage / score10 が入ること
- 監査診断でエラーなし

### 4-5. バージョン更新とコミット
- `_VER` 'v1.7.65'、sw.js 更新
- コミット: `refactor: 検定カードUIの汎用化と保存正規化 (フェーズ3a Step4) v1.7.65`

---

## Step 5: 泳力検定の組み込み(v1.7.66)

### 目的
テスト作成画面から泳力検定を選べるようにする。換算表編集UIを追加。

### 5-1. peUnit select に泳力検定を追加

**old_str**(L2220):
```javascript
                                        <option value="なわとびカード">🪢 なわとびカード（級判定）</option>
```

**new_str**:
```javascript
                                        <option value="なわとびカード">🪢 なわとびカード（級判定）</option>
                                        <option value="検定:swimming">🏊 泳力検定カード（級判定）</option>
```

**注**: なわとびの value は後方互換のため `'なわとびカード'` のまま。泳力は `'検定:swimming'`。`kenteiGetPresetId` が両方を解決する。

### 5-2. テスト保存処理で kenteiConfig を保存

L6308 周辺(`test.peUnit = document.getElementById('recTestPeUnit').value;`)を view し、その近くで検定カードなら config を埋める:

方針(実コード確認後に確定):
```javascript
test.peUnit = document.getElementById('recTestPeUnit').value;
var _pid = kenteiGetPresetId(test.peUnit);
if (_pid && !test.kenteiConfig) {
    test.kenteiConfig = kenteiBuildFromPreset(_pid);
}
```
これにより、テスト作成時点で換算表(プリセット初期値)が test に保存され、後から編集可能になる。

### 5-3. 換算表編集UI(モーダル)

設計書 §5.2 のモーダルを実装。**ただし2週間の期限と慎重スタイルを踏まえ、Step 5 ではプリセット既定値のまま動く状態を優先**し、編集モーダルは以下のいずれかで判断:
- (a) Step 5 で簡易版(conversionTable の score10 を数値入力で編集)を入れる
- (b) Step 6 または別 Step に回し、まずプリセット固定で泳力検定を動かす

y.y さんは「換算表は手入力したい」希望なので (a) が望ましいが、実装難度を見て判断。最低限、プリセット倍率1で正しく動くことを先に確保する。

### 5-4. 検証(Step 5)
- `node --check`
- 新規で泳力検定テストを作成 → 24技のカードが表示される
- 各カテゴリ6技ずつ、ロック挙動が正しい
- 全技合格で stage=24・マスター1・10点
- 18技目で1級・7.5点

### 5-5. バージョン更新とコミット
- `_VER` 'v1.7.66'、sw.js 更新
- コミット: `feat: 泳力検定カードの実装 (フェーズ3a Step5) v1.7.66`

---

## Step 6: 検証と仕上げ(v1.8.0)

### 6-1. 監査診断機能へのチェック項目追加
- stage と score10 が conversionTable と整合しているか
- マイグレーション完了フラグの確認
- 検定カードテストの config 妥当性(カテゴリ・技数)

実コードの監査診断セクション(grep `監査診断` または `checkStructuralIntegrity` 周辺、L11264/L11391 付近)を view してから追加。

### 6-2. 全体回帰確認
- 既存なわとび: 完全に従来通り
- 新規泳力: 仕様通り
- マイグレーション: 冪等
- 監査診断: エラーなし、新項目が機能

### 6-3. ドキュメント更新
- `03_code_map.md`: KenteiCard モジュール(L5712 周辺)を追記、関数表に kentei* 系追加
- `04_data_schema.md`: spa_tests に kenteiConfig、spa_scores に passData/stage/score10 を追記
- `24_phase2_5_final_handover.md`: B-2 を「v1.8.0 修正済み」にマーク

### 6-4. リリースコミット
- `_VER` 'v1.8.0'、sw.js 更新
- コミット: `release: v1.8.0 検定カード型統合 (フェーズ3a完了)`

---

## 全 Step 共通チェックリスト

各 Step で:
- [ ] view で old_str の実在を確認(行番号は Step ごとにズレる。前 Step の編集で全行ズレる点に注意)
- [ ] str_replace で old_str/new_str を目視確認
- [ ] `node --check index.html` 成功
- [ ] `_VER` 更新
- [ ] sw.js CACHE_VERSION 更新
- [ ] ブラウザで既存なわとび動作の非回帰確認
- [ ] 監査診断でエラーなし
- [ ] コミット(指定メッセージ)

## ⚠️ 行番号ズレへの注意

Step 1 で約280行を挿入するため、**Step 2 以降の行番号(L8657 等)はすべて後方にズレる**。各 Step 着手時は行番号を頼らず、`grep -n` で関数名を再検索してから view すること。指示書の old_str(コード文字列)は行番号がズレても有効。

## マイグレーション実行の運用注意

Step 3 デプロイ後、y.y さんがアプリをリロードした瞬間にマイグレーションが走る。**事前にバックアップ取得**を必ず案内すること。なわとびデータは現状ほぼ無い(使用は半年後)ため実害は小さいが、原則を守る。
