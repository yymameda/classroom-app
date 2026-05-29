# フェーズ3a 詳細設計仕様書

## 検定カード型 統合設計(泳力検定実装 + B-2 修正 + データ構造見直し)

**作成日**: 2026-05-28
**対象バージョン**: v1.7.61 → v1.8.0
**期限**: 2週間後(2026-06-11 目標)
**前提**: フェーズ3 全体計画書(`30_phase3_plan.md`)

---

## 1. 設計の目的

### 1.1 解決する3つの問題

| # | 問題 | 現状 | 解決後 |
|---|---|---|---|
| **P1** | **泳力検定が未実装** | なし | 24段階の検定カードとして実装 |
| **P2** | **B-2 なわとび級換算バグ** | score(=合格技数)を grade(=級)として誤解釈 | score の意味を明確化、正しく換算 |
| **P3** | **検定カードの汎用性不足** | なわとび専用の作り込み | 設定駆動型の汎用構造、将来の検定追加に対応 |

### 1.2 P2(B-2 バグ)の正体

**現状コード(L5797-5798)**:
```javascript
var rec = { id: Date.now(), studentIndex: studentIndex, testId: recCurrentTestId,
    score: totalPassed,           // ← 合格技数(0〜21)を保存
    nawatobiData: passData, createdAt: new Date().toISOString() };
```

**現状コード(L8649-8659)**:
```javascript
function nawatobiToScore10(grade) {     // ← 引数名は grade(級)
    if (grade <= 0) return 10;
    if (grade > 20) return 0;
    if (grade <= 7)  return Math.round(10 - (grade - 1) * (2 / 6));
    ...
}
// 呼び出し側
if (test.peUnit === 'なわとびカード') return nawatobiToScore10(sr.score);
//                                                            ^^^^^^^^
//                                  ← 合格技数を grade として渡している
```

**バグの現象**:
- 児童A: 合格技数 0 → score=0 → grade=0 として処理 → **10点満点**(逆転)
- 児童B: 合格技数 21 → score=21 → grade=21 として処理 → **0点**(逆転)

実際の級は `recNwCalcGrade(passData)` で別途算出されているが、保存・換算経路には反映されていない。

### 1.3 採用する設計方針(確定)

| 項目 | 方針 |
|---|---|
| データ構造 | `testType="実技記録"` + `peUnit` で検定カード型に統一 |
| 設計アプローチ | **案A 設定駆動型**(検定設定を `test.kenteiConfig` に保持) |
| UI | なわとびカードの UI を踏襲(体裁統一) |
| 換算表 | 上から10点、下を0点(倍率1)を初期プリセット、テスト作成時に手入力で調整可 |
| 既存データ | マイグレーションで新形式に変換(後方互換) |
| なわとび | 「組み込みプリセット」として残す(既存ユーザー影響ゼロ) |

---

## 2. アーキテクチャ設計

### 2.1 全体構成

```
┌─────────────────────────────────────────────────┐
│ 検定カード抽象化レイヤー (新規)                  │
│  KenteiCard モジュール                           │
│  - プリセット定義 (なわとび, 泳力, 将来追加可)   │
│  - 級計算ロジック (汎用)                         │
│  - 級 → 10点換算 (汎用)                          │
└─────────────────────────────────────────────────┘
           ▲                  ▲
           │                  │
┌──────────┴────────┐  ┌──────┴────────┐
│ なわとびカード     │  │ 泳力検定カード │
│ (既存・移行)       │  │ (新規)         │
└────────────────────┘  └────────────────┘
           ▼                  ▼
┌─────────────────────────────────────────────────┐
│ 既存の RECORDS / GRADES モジュール (最小変更)   │
└─────────────────────────────────────────────────┘
```

### 2.2 新規データ構造

#### 2.2.1 `test.kenteiConfig`(検定設定)

```javascript
test = {
  id: 1234567890,
  name: "泳力検定 第1回",
  subject: "体育",
  category: "知識・技能",
  testType: "実技記録",
  peUnit: "検定カード",           // ← 新規: 汎用識別子(後方互換: "なわとびカード" も継続サポート)
  kenteiConfig: {                  // ← 新規
    presetId: "swimming",          // 'nawatobi' / 'swimming' / 'custom'
    categories: [
      { id: 'hop',  name: 'ホップ',       color: '#4CAF50', skills: [...] },
      { id: 'step', name: 'ステップ',     color: '#2196F3', skills: [...] },
      { id: 'jump', name: 'ジャンプ',     color: '#FF9800', skills: [...] },
      { id: 'high', name: 'ハイジャンプ', color: '#E91E63', skills: [...], isMaster: true }
    ],
    gradeLabel: {                  // 級の表示形式
      type: "japanese",            // 'japanese' (n級・マスターN)
      maxGrade: 18,                // 数字の級の最大値
      masterLabels: ["マスター6","マスター5","マスター4","マスター3","マスター2","マスター1"]
    },
    conversionTable: [             // 級 → 10点換算表
      // index 0 がもっとも下、最後がもっとも上
      // 表示順序とは独立、内部段階番号(stage)で管理
      { stage: 1,  label: "18級",        score10: 0.0 },
      { stage: 2,  label: "17級",        score10: 0.5 },
      ...
      { stage: 18, label: "1級",         score10: 7.0 },
      { stage: 19, label: "マスター6",    score10: 7.5 },
      ...
      { stage: 24, label: "マスター1",    score10: 10.0 }
    ]
  },
  date: "2026-06-15",
  ...
}
```

#### 2.2.2 `score` レコード(検定カード型)

```javascript
score = {
  id: 1234567891,
  studentIndex: 5,
  testId: 1234567890,
  
  // ===== 新規・正規化フィールド =====
  passData: {                  // 各技の合格状況(既存 nawatobiData を改名)
    "hop_1": 1, "hop_2": 1, "hop_3": 0, ...
  },
  stage: 13,                   // ← 新規: 段階番号(1=最下、24=最上)
  score10: 5.5,                // ← 新規: 換算後の10点満点
  
  // ===== 後方互換フィールド(マイグレーション後も保持) =====
  nawatobiData: { ... },       // 旧データのまま残す(passData と同期)
  score: 13,                   // ← 旧 score の意味を「段階番号」に変更
  
  // ===== その他既存フィールド =====
  createdAt: "...",
  ...
}
```

**重要な設計判断**:
- 新フィールド `stage` を導入し、「段階番号」を明示的に保存
- 旧 `score` フィールドの意味を「段階番号」に揃える(マイグレーションで変換)
- `score10` を事前計算して保存(換算表変更時の再計算は別途実装)
- `nawatobiData` は後方互換のため残す(`passData` と同じ内容を保持)

### 2.3 段階番号(stage)の設計

「段階番号」は、検定カードを抽象化するための **共通の物差し** です。

```
カテゴリ      技数  段階番号  級表示(なわとび)  級表示(泳力)
ホップ        6     1〜6      20級〜15級         18級〜13級
ステップ      6     7〜12     14級〜9級          12級〜7級
ジャンプ      6     13〜18    8級〜3級           6級〜1級
ハイジャンプ  3/6   19〜21/24 2級〜マスター      マスター6〜マスター1

合格技数 0    → stage = 0(まだ最下級にも届いていない)
合格技数 1    → stage = 1
合格技数 21   → stage = 21(なわとびの場合、マスター達成)
合格技数 24   → stage = 24(泳力の場合、マスター1達成)
```

つまり **stage = 合格累計技数** という単純なマッピング。

級表示は `kenteiConfig.gradeLabel` から逆算:
- なわとび: `stage 0` → '取得なし'、`stage 1〜20` → '20級〜1級'、`stage 21` → 'マスター'
- 泳力: `stage 0` → '取得なし'、`stage 1〜18` → '18級〜1級'、`stage 19〜24` → 'マスター6〜マスター1'

---

## 3. プリセット定義

### 3.1 なわとびプリセット(既存からの移植)

```javascript
KenteiPresets.nawatobi = {
  id: 'nawatobi',
  name: 'なわとびカード',
  emoji: '🪢',
  categories: [
    { id: 'hop',  name: 'ホップ',       color: '#4CAF50', skills: [
      { id: 'h1', short: '両足前',   name: '両足跳び 前回し' },
      { id: 'h2', short: '両足後',   name: '両足跳び 後回し' },
      { id: 'h3', short: 'かけ足前', name: 'かけ足跳び 前回し' },
      { id: 'h4', short: 'かけ足後', name: 'かけ足跳び 後回し' },
      { id: 'h5', short: '片足前',   name: '片足跳び 前回し' },
      { id: 'h6', short: '片足後',   name: '片足跳び 後回し' }
    ]},
    { id: 'step', name: 'ステップ',     color: '#2196F3', skills: [
      { id: 's1', short: 'ｸﾞｰﾊﾟｰ前',  name: 'グーパー跳び 前回し' },
      { id: 's2', short: 'ｸﾞｰﾊﾟｰ後',  name: 'グーパー跳び 後回し' },
      { id: 's3', short: 'ｸﾞｰﾁｮｷ前',  name: 'グーチョキ跳び 前回し' },
      { id: 's4', short: 'ｸﾞｰﾁｮｷ後',  name: 'グーチョキ跳び 後回し' },
      { id: 's5', short: 'あや前',     name: 'あや跳び 前回し' },
      { id: 's6', short: 'こうさ前',   name: '交差跳び 前回し' }
    ]},
    { id: 'jump', name: 'ジャンプ',     color: '#FF9800', skills: [
      { id: 'j1', short: 'あや後',     name: 'あや跳び 後回し' },
      { id: 'j2', short: 'こうさ後',   name: '交差跳び 後回し' },
      { id: 'j3', short: 'ｻｲﾄﾞ前',    name: 'サイドクロス 前回し' },
      { id: 'j4', short: 'ｻｲﾄﾞ後',    name: 'サイドクロス 後回し' },
      { id: 'j5', short: 'ﾏﾘｰﾅ前',    name: 'マリーナ 前回し' },
      { id: 'j6', short: '二重前',     name: '二重跳び 前回し' }
    ]},
    { id: 'high', name: 'ハイジャンプ', color: '#E91E63', isMaster: true, skills: [
      { id: 'x1', short: '二重後',     name: '二重跳び 後回し' },
      { id: 'x2', short: '連続易',     name: '連続二重(易)' },
      { id: 'x3', short: '連続難',     name: '連続二重(難)' }
    ]}
  ],
  gradeLabel: {
    type: 'japanese',
    stageToLabel: function(stage, total) {
      if (stage <= 0) return '-';
      if (stage >= 21) return 'マスター';
      return (21 - stage) + '級';
    }
  },
  // 換算表(プリセット初期値、テスト作成時に編集可)
  defaultConversionTable: function() {
    // 既存の nawatobiToScore10(grade) を 段階番号ベースに変換
    // stage = 21 - grade (grade <= 0 のときは stage = 21)
    var table = [];
    for (var stage = 0; stage <= 21; stage++) {
      var grade = stage === 0 ? 21 : (21 - stage);
      var score10 = computeNawatobiScore10ByGrade(grade);
      table.push({ stage: stage, label: this.gradeLabel.stageToLabel(stage), score10: score10 });
    }
    return table;
  }
};
```

### 3.2 泳力検定プリセット(新規)

```javascript
KenteiPresets.swimming = {
  id: 'swimming',
  name: '泳力検定カード',
  emoji: '🏊',
  categories: [
    { id: 'hop',  name: 'ホップ',       color: '#4CAF50', skills: [
      { id: 'sh1', short: 'かけっこ',     name: 'かけっこ', desc: '水中を10m走る' },
      { id: 'sh2', short: 'もぐる易',     name: 'もぐる(やさしい)', desc: '水中にもぐる' },
      { id: 'sh3', short: 'もぐる難',     name: 'もぐる(むずかしい)', desc: '水中に5秒もぐる' },
      { id: 'sh4', short: 'バブリング',   name: 'バブリング', desc: '水中で息をはく(細く長く、3秒)' },
      { id: 'sh5', short: 'ボビング',     name: 'ボビング', desc: '水中で息をはき、とびあがって空気中で息を吸う' },
      { id: 'sh6', short: 'ふしうき易',   name: 'ふしうき(やさしい)', desc: 'かべにつかまって伏し浮き' }
    ]},
    { id: 'step', name: 'ステップ',     color: '#2196F3', skills: [
      { id: 'ss1', short: 'ふしうき難',   name: 'ふしうき(むずかしい)', desc: '伏し浮きを5秒' },
      { id: 'ss2', short: 'せうき',       name: 'せうき', desc: '背浮きを5秒' },
      { id: 'ss3', short: 'け伸び',       name: 'け伸び', desc: 'かべをけって、体を一直線にする' },
      { id: 'ss4', short: '面ｸﾛｰﾙ',     name: '面かぶりクロール', desc: '呼吸をしないクロールをする' },
      { id: 'ss5', short: '面平泳',      name: '面かぶり平泳ぎ', desc: '呼吸をしない平泳ぎをする' },
      { id: 'ss6', short: 'かんたん泳',   name: 'かんたん泳ぎ', desc: '呼吸をしながら25m泳ぐ(背泳ぎ・ドル平も可)' }
    ]},
    { id: 'jump', name: 'ジャンプ',     color: '#FF9800', skills: [
      { id: 'sj1', short: 'ｸﾛｰﾙ',       name: 'クロール', desc: 'クロールで25m泳ぐ' },
      { id: 'sj2', short: '平泳ぎ',       name: '平泳ぎ', desc: '平泳ぎで25m泳ぐ' },
      { id: 'sj3', short: 'ｸﾛｰﾙ長',     name: 'クロール(長く)', desc: 'クロールで50m泳ぐ' },
      { id: 'sj4', short: '平泳長',       name: '平泳ぎ(長く)', desc: '平泳ぎで50m泳ぐ' },
      { id: 'sj5', short: 'ｸﾛｰﾙ速',     name: 'クロール(はやく)', desc: '25mを30秒以内' },
      { id: 'sj6', short: '平泳速',       name: '平泳ぎ(はやく)', desc: '25mを40秒以内' }
    ]},
    { id: 'high', name: 'ハイジャンプ', color: '#E91E63', isMaster: true, skills: [
      { id: 'sx1', short: 'M6',           name: 'マスター6: クロール(もっと長く)', desc: 'クロールで100m泳ぐ' },
      { id: 'sx2', short: 'M5',           name: 'マスター5: 平泳ぎ(もっと長く)', desc: '平泳ぎで100m泳ぐ' },
      { id: 'sx3', short: 'M4',           name: 'マスター4: クロール(もっとはやく)', desc: '25mを25秒以内' },
      { id: 'sx4', short: 'M3',           name: 'マスター3: 平泳ぎ(もっとはやく)', desc: '25mを35秒以内' },
      { id: 'sx5', short: 'M2',           name: 'マスター2: クロール(50m)', desc: 'クロールで50m泳ぐ' },
      { id: 'sx6', short: 'M1',           name: 'マスター1: 平泳ぎ(50m)', desc: '平泳ぎで50m泳ぐ(究極)' }
    ]}
  ],
  gradeLabel: {
    type: 'japanese',
    stageToLabel: function(stage, total) {
      if (stage <= 0) return '-';
      if (stage >= 19) {
        // マスター区間: stage 19→M6, 20→M5, ..., 24→M1
        return 'マスター' + (25 - stage);
      }
      // 通常級: stage 1→18級, 2→17級, ..., 18→1級
      return (19 - stage) + '級';
    }
  },
  // 換算表(プリセット初期値、倍率1: 上から10、下を0)
  defaultConversionTable: function() {
    var table = [];
    var maxStage = 24;
    for (var stage = 0; stage <= maxStage; stage++) {
      // 倍率1: stage / maxStage * 10
      var score10 = Math.round((stage / maxStage) * 10 * 10) / 10;
      table.push({ stage: stage, label: this.gradeLabel.stageToLabel(stage, maxStage), score10: score10 });
    }
    return table;
  }
};
```

### 3.3 泳力検定の換算表プリセット(倍率1)

| stage | 級表示 | score10 |
|---|---|---|
| 0 | -(未取得) | 0.0 |
| 1 | 18級 | 0.4 |
| 2 | 17級 | 0.8 |
| 3 | 16級 | 1.3 |
| 4 | 15級 | 1.7 |
| 5 | 14級 | 2.1 |
| 6 | 13級 | 2.5 |
| 7 | 12級 | 2.9 |
| 8 | 11級 | 3.3 |
| 9 | 10級 | 3.8 |
| 10 | 9級 | 4.2 |
| 11 | 8級 | 4.6 |
| 12 | 7級 | 5.0 |
| 13 | 6級 | 5.4 |
| 14 | 5級 | 5.8 |
| 15 | 4級 | 6.3 |
| 16 | 3級 | 6.7 |
| 17 | 2級 | 7.1 |
| 18 | 1級 | 7.5 |
| 19 | マスター6 | 7.9 |
| 20 | マスター5 | 8.3 |
| 21 | マスター4 | 8.8 |
| 22 | マスター3 | 9.2 |
| 23 | マスター2 | 9.6 |
| 24 | マスター1 | 10.0 |

**注**: テスト作成時に y.y さんが手入力で調整可能(例: マスター区間を全部10点にする等)。

---

## 4. 共通モジュール(新規)

### 4.1 KenteiCard モジュール

新規ヘルパー関数群を `index.html` の RECORDS モジュール内(L5681 周辺の「なわとびカード」セクションを拡張)に配置。

```javascript
// ============================================================
// KenteiCard 共通モジュール (新規)
// ============================================================

var KenteiPresets = {
  nawatobi: { /* §3.1 で定義 */ },
  swimming:  { /* §3.2 で定義 */ }
};

/**
 * 検定設定を取得する(テストオブジェクトから、なければプリセットから)
 */
function kenteiGetConfig(test) {
  if (test.kenteiConfig) return test.kenteiConfig;
  // 後方互換: 旧 "なわとびカード" テストに対する暗黙のプリセット適用
  if (test.peUnit === 'なわとびカード') {
    return kenteiBuildFromPreset('nawatobi');
  }
  return null;
}

/**
 * プリセットから完全な config を構築
 */
function kenteiBuildFromPreset(presetId) {
  var preset = KenteiPresets[presetId];
  if (!preset) return null;
  return {
    presetId: presetId,
    categories: JSON.parse(JSON.stringify(preset.categories)),
    gradeLabel: { type: preset.gradeLabel.type, _presetId: presetId },
    conversionTable: preset.defaultConversionTable()
  };
}

/**
 * passData から段階番号(stage = 合格累計技数)を計算
 * カテゴリは順番に進む。前カテゴリ未完了で打ち切り。
 */
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

/**
 * 段階番号から級表示ラベルを生成
 */
function kenteiStageToLabel(config, stage) {
  if (!config) return '-';
  // プリセット由来の場合、プリセット側の stageToLabel を使う
  if (config.gradeLabel._presetId && KenteiPresets[config.gradeLabel._presetId]) {
    var totalStages = 0;
    KenteiPresets[config.gradeLabel._presetId].categories.forEach(function(c) {
      totalStages += c.skills.length;
    });
    return KenteiPresets[config.gradeLabel._presetId].gradeLabel.stageToLabel(stage, totalStages);
  }
  // カスタム/手入力の場合、conversionTable の label を引く
  var row = (config.conversionTable || []).find(function(r) { return r.stage === stage; });
  return row ? row.label : (stage + '段階目');
}

/**
 * 段階番号 → 10点換算
 */
function kenteiStageToScore10(config, stage) {
  if (!config || stage === null || stage === undefined) return null;
  var row = (config.conversionTable || []).find(function(r) { return r.stage === stage; });
  return row ? row.score10 : null;
}

/**
 * カテゴリがロック状態(前カテゴリ未完了)か判定
 */
function kenteiIsLocked(config, catId, passData) {
  if (!config) return false;
  var idx = config.categories.findIndex(function(c) { return c.id === catId; });
  if (idx <= 0) return false;
  for (var i = 0; i < idx; i++) {
    var prev = config.categories[i];
    var passedCnt = prev.skills.filter(function(s) { return passData[s.id] === 1; }).length;
    if (passedCnt < prev.skills.length) return true;
  }
  return false;
}
```

### 4.2 既存関数の修正(後方互換維持)

#### `nawatobiToScore10` の修正(L8649)

```javascript
// 修正前
function nawatobiToScore10(grade) {
    if (grade === undefined || grade === null) return null;
    if (grade <= 0) return 10;
    if (grade > 20) return 0;
    if (grade <= 7)  return Math.round(10 - (grade - 1) * (2 / 6));
    if (grade <= 17) return Math.round(7  - (grade - 8) * (3 / 9));
    return Math.round(3 - (grade - 18) * (2 / 2));
}

// 修正後(段階番号ベース、なわとび専用)
function nawatobiStageToScore10(stage) {
    if (stage === undefined || stage === null) return null;
    if (stage >= 21) return 10;       // マスター達成
    if (stage <= 0) return 0;         // 何も合格していない
    // stage 1 → 20級, stage 20 → 1級, stage 21 → マスター
    var grade = 21 - stage;
    if (grade <= 0) return 10;
    if (grade > 20) return 0;
    if (grade <= 7)  return Math.round(10 - (grade - 1) * (2 / 6));
    if (grade <= 17) return Math.round(7  - (grade - 8) * (3 / 9));
    return Math.round(3 - (grade - 18) * (2 / 2));
}

// 後方互換用ラッパー(旧 nawatobiToScore10 を呼ぶ既存コードのため)
function nawatobiToScore10(grade) {
    // 旧仕様: grade を直接受け取る
    // ただし新コードは nawatobiStageToScore10 を使うこと
    return nawatobiToScore10Legacy(grade);
}
function nawatobiToScore10Legacy(grade) { /* 旧コードのまま */ }
```

#### `peRecordToScore10` の修正(L8657)

```javascript
// 修正前
function peRecordToScore10(sr, test) {
    if (!sr || sr.score === null || sr.score === undefined) return null;
    if (test.peUnit === 'なわとびカード') return nawatobiToScore10(sr.score);
    ...
}

// 修正後
function peRecordToScore10(sr, test) {
    if (!sr || sr.score === null || sr.score === undefined) return null;
    
    // 検定カード型(新): kenteiConfig がある場合
    var config = kenteiGetConfig(test);
    if (config) {
        // 優先順位:
        // 1. score10 が事前計算されていればそれを使う
        // 2. stage が保存されていれば換算
        // 3. 後方互換: passData / nawatobiData から再計算
        if (typeof sr.score10 === 'number') return sr.score10;
        if (typeof sr.stage === 'number') return kenteiStageToScore10(config, sr.stage);
        var pd = sr.passData || sr.nawatobiData || {};
        var stage = kenteiCalcStage(config, pd);
        return kenteiStageToScore10(config, stage);
    }
    
    // 以下、既存ロジック(タイム差・回・素点)
    if (test.peUnit === 'タイム差') {
        var s = sr.finalScore !== undefined ? sr.finalScore : sr.score;
        return s !== null ? Math.min(10, s) : null;
    }
    if (test.peUnit === '回' && sr.peManualABC) {
        return sr.peManualABC === 'A' ? 10 : sr.peManualABC === 'B' ? 7 : 4;
    }
    var max = test.maxScore || 10;
    if (max > 0 && typeof sr.score === 'number') {
        return Math.min(10, Math.round(sr.score / max * 10 * 10) / 10);
    }
    return null;
}
```

### 4.3 セル押下時の保存処理の修正(L5786 周辺)

```javascript
// 修正前
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
    ...
};

// 修正後(汎用版・関数名も改名)
window.kenteiToggle = function(studentIndex, skillId) {
    var test = recGetTests().find(function(t) { return t.id === recCurrentTestId; });
    if (!test) return;
    var config = kenteiGetConfig(test);
    if (!config) return;
    
    var scores = recGetScores();
    var ei = scores.findIndex(function(s) { return s.studentIndex === studentIndex && s.testId === recCurrentTestId; });
    var sc = ei >= 0 ? scores[ei] : null;
    var passData = (sc && (sc.passData || sc.nawatobiData))
        ? JSON.parse(JSON.stringify(sc.passData || sc.nawatobiData)) : {};
    passData[skillId] = passData[skillId] === 1 ? 0 : 1;
    
    var stage = kenteiCalcStage(config, passData);          // 段階番号
    var score10 = kenteiStageToScore10(config, stage);      // 10点換算
    var hasRecord = stage > 0;
    
    var rec = {
        id: Date.now(),
        studentIndex: studentIndex,
        testId: recCurrentTestId,
        // === 新規・正規化フィールド ===
        passData: passData,
        stage: stage,
        score10: score10,
        // === 後方互換フィールド ===
        nawatobiData: passData,  // 同じ内容を保持
        score: stage,            // ← 旧 score の意味を「段階番号」に変更
        createdAt: new Date().toISOString()
    };
    if (ei >= 0) scores[ei] = rec; else scores.push(rec);
    recSaveScores(scores);
    
    kenteiUpdateCardUI(studentIndex, passData, stage, hasRecord, config);
    recUpdateProgressByCount();
};

// 旧名の後方互換ラッパー
window.recNwToggle = window.kenteiToggle;
```

---

## 5. UI 設計

### 5.1 テスト作成画面の拡張(L2210 周辺)

```html
<!-- 修正前: peUnit の選択肢に「なわとびカード」だけ -->
<option value="なわとびカード">🪢 なわとびカード(級判定)</option>

<!-- 修正後: 検定カードの選択肢を増やす -->
<option value="検定:nawatobi">🪢 なわとびカード(級判定)</option>
<option value="検定:swimming">🏊 泳力検定カード(級判定)</option>
<!-- 将来の追加用 -->
<!-- <option value="検定:vault">🤸 跳び箱検定カード(級判定)</option> -->
```

**peUnit の保存値の方針**:
- 新規作成時: `"検定:swimming"` のように `"検定:"` 接頭辞 + プリセットID
- 既存データ: `"なわとびカード"` をそのまま残す(後方互換)

判定ロジック:
```javascript
function kenteiGetPresetIdFromPeUnit(peUnit) {
    if (!peUnit) return null;
    if (peUnit === 'なわとびカード') return 'nawatobi';
    if (peUnit.indexOf('検定:') === 0) return peUnit.substring(3);
    return null;
}
```

### 5.2 換算表の編集UI

テスト作成画面に「換算表を編集」ボタンを追加。クリックでモーダル表示:

```
┌──────────────────────────────────────┐
│ 換算表の編集(泳力検定カード)         │
├──────────────────────────────────────┤
│ stage  級表示       score10           │
│ ───────────────────────────────────── │
│ 0      -            [0.0   ]          │
│ 1      18級         [0.4   ]          │
│ 2      17級         [0.8   ]          │
│ ...                                    │
│ 24     マスター1    [10.0  ]          │
├──────────────────────────────────────┤
│ [プリセットに戻す] [保存] [キャンセル] │
└──────────────────────────────────────┘
```

数値入力で y.y さんが各段階の点数を自由に設定可能。

### 5.3 検定カード入力UI

なわとびカードの UI(L5744-5784 `recBuildNawatobiCard`)を汎用化して `kenteiBuildCard` に改名。CSS クラスは流用(`rec-nawatobi-card`, `rec-nw-skills` 等)。

機能はそのまま、内部で `KenteiPresets` を参照する形に変更。

---

## 6. マイグレーション設計

### 6.1 マイグレーション対象

| データ | 旧形式 | 新形式 | 影響件数(実データ) |
|---|---|---|---|
| `spa_tests`(なわとび) | `peUnit: "なわとびカード"` | そのまま(後方互換) | 推定数件 |
| `spa_scores`(なわとびスコア) | `score: totalPassed, nawatobiData: {...}` | `stage: ..., score10: ..., passData: {...}` 追加 | 4月のなわとびスコア記録(現年度未計上のため少数) |

### 6.2 マイグレーション関数

```javascript
function migrateKenteiCardScores() {
    var migrated = 0;
    var tests = recGetTests();
    var scores = recGetScores();
    
    // 検定カード型のテストID一覧
    var kenteiTestIds = {};
    tests.forEach(function(t) {
        var config = kenteiGetConfig(t);
        if (config) kenteiTestIds[t.id] = { test: t, config: config };
    });
    
    var changed = false;
    scores.forEach(function(sc) {
        var info = kenteiTestIds[sc.testId];
        if (!info) return;
        
        // 既に新形式の場合はスキップ
        if (typeof sc.stage === 'number' && typeof sc.score10 === 'number') return;
        
        // passData を取得(旧 nawatobiData から、なければ空)
        var pd = sc.passData || sc.nawatobiData || {};
        sc.passData = pd;
        sc.stage = kenteiCalcStage(info.config, pd);
        sc.score10 = kenteiStageToScore10(info.config, sc.stage);
        // score を「段階番号」に揃える(旧 totalPassed と同じ値)
        sc.score = sc.stage;
        // nawatobiData は後方互換で残す
        if (!sc.nawatobiData) sc.nawatobiData = pd;
        
        migrated++;
        changed = true;
    });
    
    if (changed) {
        recSaveScores(scores);
        StorageManager.set('migration_kenteiCard_v1', JSON.stringify({
            timestamp: new Date().toISOString(),
            count: migrated
        }));
    }
    return migrated;
}
```

### 6.3 マイグレーション実行タイミング

`DOMContentLoaded` ハンドラ内(L3577 周辺の INIT モジュール)で、`migrateScoreData` の直後に実行。

```javascript
// INIT モジュール内
migrateScoreData();
migrateKenteiCardScores();  // ← 新規追加
```

実行条件:
- `localStorage.migration_kenteiCard_v1` が未設定なら実行
- 既に実行済みならスキップ(冪等性確保)

### 6.4 マイグレーション前後の検証

監査診断機能(フェーズ2.5)を活用:
- マイグレーション前に診断実行(現状記録)
- マイグレーション実行
- マイグレーション後に診断実行(変化を確認)
- 段階番号と score10 の整合性を新しい診断項目として追加

---

## 7. 影響分析

### 7.1 影響を受けるコード箇所

| 行番号 | 関数/箇所 | 変更内容 |
|---|---|---|
| L2220 | テスト作成 peUnit select | 選択肢追加 |
| L5425, L5578 | isNawatobi 判定 | isKentei 判定に汎用化 |
| L5682-5810 | なわとびカード関連すべて | KenteiCard モジュールに移植 |
| L6308 | テスト保存処理 | kenteiConfig 保存追加 |
| L8649-8665 | nawatobiToScore10, peRecordToScore10 | 段階ベースに修正、後方互換ラッパー追加 |
| L3577 周辺 | INIT モジュール | マイグレーション呼び出し追加 |

### 7.2 影響を受けないコード箇所(後方互換)

- 既存のなわとびテスト・スコアデータは、マイグレーション後も `peUnit: "なわとびカード"` のまま使える
- 既存の `nawatobiData` フィールドはそのまま残る
- 既存の `nawatobiToScore10(grade)` ラッパーで旧呼び出しコードは動く

### 7.3 監査診断機能との整合性(フェーズ2.5 連携)

監査診断機能に以下のチェック項目を追加(フェーズ3g で正式実装):

1. **段階番号と score10 の整合性**: stage と score10 が conversionTable と一致しているか
2. **マイグレーション完了確認**: 旧形式の残存件数
3. **kenteiConfig の妥当性**: カテゴリ・技数・換算表の構造チェック

---

## 8. 実装ステップ(段階的コミット計画)

### Step 1: 共通モジュール骨格(v1.7.62)
- KenteiPresets 定義(なわとび・泳力)
- 共通関数(kenteiGetConfig, kenteiCalcStage, etc.)
- 単体動作確認(なわとびの既存動作が変わらないこと)
- **コミット**: 「feat: KenteiCard 共通モジュール追加」

### Step 2: B-2 修正(v1.7.63)
- nawatobiStageToScore10 の新規追加
- peRecordToScore10 の新ロジック
- 後方互換ラッパー
- **コミット**: 「fix: B-2 なわとび級換算バグ修正」

### Step 3: マイグレーション実装(v1.7.64)
- migrateKenteiCardScores 関数
- INIT への組み込み
- 実データでの動作確認(バックアップから検証)
- **コミット**: 「feat: 検定カードスコアのマイグレーション」

### Step 4: UI 汎用化(v1.7.65)
- なわとびカードUI の関数名・変数名を kentei 系に改名
- CSS クラスはそのまま(影響範囲を最小化)
- 既存なわとびテストでの動作確認
- **コミット**: 「refactor: 検定カードUI の汎用化」

### Step 5: 泳力検定の組み込み(v1.7.66)
- テスト作成画面に泳力検定の選択肢追加
- 換算表編集モーダル
- 動作確認
- **コミット**: 「feat: 泳力検定カードの実装」

### Step 6: 検証と仕上げ(v1.8.0)
- 監査診断機能のチェック項目追加
- 全体動作確認
- ドキュメント更新(04_data_schema.md, 03_code_map.md)
- **コミット**: 「release: v1.8.0 検定カード型統合(フェーズ3a完了)」

### スケジュール目安

| 週 | 進捗目標 |
|---|---|
| 1週目 | Step 1〜3 完了(共通モジュール・B-2 修正・マイグレーション) |
| 2週目 | Step 4〜6 完了(UI汎用化・泳力検定・仕上げ) |

---

## 9. テスト計画

### 9.1 単体テスト(各 Step で実施)

| テスト項目 | 期待結果 |
|---|---|
| `kenteiCalcStage` で passData={} | stage = 0 |
| `kenteiCalcStage` でホップ全合格 | stage = 6 |
| `kenteiCalcStage` でステップ全合格(ホップ未完了) | ホップで打ち切り、stage = ホップ合格数 |
| `kenteiStageToScore10` で stage=0 | score10 = 0 |
| `kenteiStageToScore10` で stage=最大 | score10 = 10 |
| なわとびプリセットで stage=21 | label = 'マスター', score10 = 10 |
| 泳力プリセットで stage=24 | label = 'マスター1', score10 = 10 |
| 泳力プリセットで stage=18 | label = '1級', score10 ≒ 7.5 |

### 9.2 統合テスト

| テストシナリオ | 期待結果 |
|---|---|
| 既存なわとびテストに点数入力→成績計算 | バグ修正前と後で異なる結果(B-2 解消の確認) |
| 新規泳力検定テスト作成→24技に○をつける→成績計算 | マスター1相当 = 10点 |
| 既存なわとびデータでマイグレーション実行 | 旧score = 新stage が一致 |
| マイグレーション2回実行 | 2回目はスキップ(冪等性) |

### 9.3 実データテスト

- y.y さんの実バックアップで Step 3 完了後に検証
- 監査診断機能を使って前後比較
- 4月のなわとびスコア(あれば)の score10 が妥当か確認

---

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| マイグレーションでデータ破損 | バックアップ取得を実装直前に必須化、冪等性確保 |
| 後方互換が破れる | 旧 `recNwToggle` などをラッパーとして残す、旧フィールド名を保持 |
| 2週間で間に合わない | Step 4〜5 を最小実装(換算表編集モーダルは Step 6 に回す等) |
| 既存なわとびテストへの影響 | Step 1 で既存動作を完全保証、Step 4 のリファクタは慎重に |
| 泳力検定の換算表が現場感に合わない | 換算表編集UI で y.y さんが手入力で調整可能にしておく |

---

## 11. 既存ドキュメントへの反映(フェーズ3a 完了後)

### 11.1 `03_code_map.md` 更新

- 新規モジュール `KENTEI_CARD` を追加(L5681 周辺)
- 関数表に kentei* 系を追加
- testType 実値リストに「実技記録 - 検定カード型」を明記

### 11.2 `04_data_schema.md` 更新

- `spa_tests` に `kenteiConfig` フィールドを追加記述
- `spa_scores` に `passData`, `stage`, `score10` を追加記述
- 検定カードの新データ構造図を追加

### 11.3 `24_phase2_5_final_handover.md` 更新

- 「修正必要項目 8件」のうち B-2 を「v1.8.0 で修正済み」とマーク
- フェーズ3a の成果を追記

---

## 12. y.y さんへの確認・依頼事項

実装着手前に確認したい点:

- [ ] 泳力検定の各技の **正式名称**(PDFの内容で間違いないか)
- [ ] 換算表のプリセット値(§3.3)で問題ないか、もしくは別の配分を希望するか
- [ ] マイグレーション実行のタイミング(放課後・週末など、操作中に重ならない日時)
- [ ] 泳力検定実装日(2週間後)の正確な日付
- [ ] 現在のなわとびテストデータの状態(4月以降の入力は控えている前提で正しいか)

---

## 13. まとめ

フェーズ3a は、**2週間の期限がある「泳力検定実装」と、フェーズ1 から持ち越してきた「B-2 バグ修正」を、データ構造の見直しを含めて統合的に解決する** サブフェーズです。

設計の核心は3点:

1. **段階番号(stage)** という共通の物差しを導入し、検定カードを汎用化
2. **設定駆動型(KenteiPresets)** で将来の検定追加にも対応
3. **後方互換** を維持しつつ、データ保存構造を正規化

実装は **段階的コミット**(Step 1〜6)で進め、各段階で動作確認を挟む慎重スタイルを継続します。

「徹底的に・順序よく」の精神は、フェーズ3 でも変わりません。
