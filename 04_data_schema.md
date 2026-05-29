# データ構造の図解

このドキュメントは、アプリが localStorage / IndexedDB に保存している
各データキーの構造と意味を説明する。

監査の際、「このデータはどんな形式か」を素早く把握するための参照ドキュメント。

---

## 全体像

```
spa_master                  ← 名簿・学級情報（全データの起点）
spa_tests                   ← テスト・課題の定義
spa_scores                  ← テスト・課題の点数記録
spa_matome_questions        ← まとめテストの問題定義
spa_submissions_assignments ← 提出物課題の定義
spa_submissions_data        ← 提出状況の記録
spa_submissions_diary       ← 日記の記録
spa_patrol                  ← 机間巡視の記録
spa_karte_recs              ← 児童記録（評価付き）
spa_karte_life              ← 生活記録
spa_karte_parent            ← 保護者連絡
spa_karte_health            ← 健康・配慮
spa_karte_learning          ← 学習配慮
spa_karte_archive           ← カルテ削除アーカイブ
spa_attendance              ← 出席記録
spa_attendance_notice       ← 出席連絡の有無
spa_morning_prep            ← 朝の準備チェック
spa_kanji                   ← 漢字到達状況
spa_forgotten_history       ← 忘れ物履歴
spa_forgotten_daily         ← 忘れ物日次
spa_forgotten_items         ← 忘れ物項目定義
spa_seating                 ← 座席配置
spa_seating_groups          ← 座席グループ
spa_grade_thresholds        ← 観点別A/B/C閾値
spa_grade_weights           ← 項目ごとの重み
pf_records_YYYY             ← 新体力テスト記録（年度別）
pf_roster                   ← 新体力テスト名簿
pf_setting                  ← 新体力テスト設定
```

---

## 成績計算に直接関わるキーの詳細

### `spa_master` （名簿・学級情報）

```javascript
{
  classInfo: {
    schoolName: "鎌倉女子大学初等部",
    year: "2026",
    grade: 5,
    class: "...",
    termSystem: { ... }   // 学期設定
  },
  students: [
    { name: "山田太郎", number: 1, gender: "男", ... },
    { name: "鈴木花子", number: 2, gender: "女", ... },
    ...
  ]
}
```

**重要**: `students` 配列のインデックス（0, 1, 2...）が `studentIndex` として
他の全データで参照される。

### `spa_tests` （テスト・課題定義）

```javascript
[
  {
    id: <数値>,              // 一意ID（タイムスタンプ等）
    name: "国語テスト第3回",  // テスト名
    subject: "国語",          // 教科
    category: "知識・技能",   // 観点（'知識・技能' / '思考・判断・表現' / '主体性'）
    testType: "テスト",       // タイプ（後述）
    maxScore: 100,           // 満点
    matomePoints: [...],     // まとめテストの場合：問題ごとの配点
    matomeQuestionTypes: [], // まとめテストの場合：問題ごとの観点
    kenteiConfig: {...},     // 検定カードの場合：カテゴリ・技・換算表（フェーズ3a。後述）
    date: "2026-05-20",      // 実施日
    ...
  },
  ...
]
```

**testType の種類**（コード上で確認された値）:
- `"テスト"` — 通常のテスト（素点）
- `"matome"` — まとめテスト（問題ごとに観点と配点）
- `"授業態度"` — ○/△/× で評価
- `"実技記録"` — 体育の実技（peUnit と組み合わせ）
- `"振り返り"` — 体育の振り返り（思考評価）
- その他（マル付け、ABC評価など）

**peUnit の種類**（実技記録の場合）:
- `"なわとびカード"` — 検定カード（なわとび・21技）→ kenteiCalcStage/kenteiStageToScore10 で換算（フェーズ3aで級換算バグ B-2 を修正）
- `"検定:swimming"` — 検定カード（泳力・24技）→ 同上（フェーズ3aで追加）
- `"タイム差"` — finalScore を使用
- `"回"` — peManualABC があれば優先
- その他 — maxScore で正規化

### `spa_scores` （点数記録）

```javascript
[
  {
    studentIndex: 7,         // 児童番号（master.students の配列インデックス）
    testId: 1234567890,      // テストID
    score: 85,               // 点数 / 'A','B','C' / '○','△','×'
    answers: [3, 2, 5, ...], // まとめテストの場合：問題ごとの得点
    matomeAnswers: [...],    // 旧フィールド名（古いデータ）
    finalScore: 8.5,         // 体育タイム差用
    peManualABC: 'A',        // 体育で手動ABC設定
    passData: {h1:1,...},    // 検定カード：技ごとの合否（1=合格）（フェーズ3a）
    stage: 7,                // 検定カード：合格累計技数（passDataから算出）
    score10: 8.5,            // 検定カード：stage→換算表で求めた10点
    nawatobiData: {...},     // 旧フィールド名（passDataと同値で併存）
    date: "2026-05-20",
    ...
  },
  ...
]
```

**重要な観察**:
- 同じ `studentIndex` × `testId` の組み合わせが複数あった場合、
  `recSaveScores` で **配列の末尾のみが残る**（L5179-5189）
- 過去に `answers` が `[0,1,0,1,...]` のバイナリ形式だったが、
  `migrateScoreData` で実点数に変換されている可能性
- `score` フィールドの型は混在（number / string）
- 検定カード（なわとび・泳力）の場合は `score = stage`（合格累計技数）。詳細は次節。

### 検定カード（なわとび・泳力）のデータ構造（フェーズ3a / v1.8.0）

「級判定型」の実技記録。`spa_tests` の `kenteiConfig` と `spa_scores` の
`passData` / `stage` / `score10` で構成される。

**kenteiConfig（spa_tests 内）**:
```javascript
{
  presetId: "swimming",          // 'nawatobi' / 'swimming'
  _presetId: "swimming",         // ラベル算出に使用
  categories: [                  // ホップ/ステップ/ジャンプ/ハイジャンプ
    { id: "hop", name: "ホップ", color: "#4CAF50",
      skills: [ { id: "sh1", short: "かけっこ", desc: "..." }, ... ] },
    ...
  ],
  conversionTable: [             // stage → score10 の換算表（手動編集可）
    { stage: 0,  label: "-",         score10: 0 },
    { stage: 1,  label: "18級",      score10: 0.4 },
    ...
    { stage: 24, label: "マスター1",  score10: 10 }
  ]
}
```

**換算の流れ**:
```
passData（技ごとの合否）
   │  kenteiCalcStage: カテゴリ順に合格を数え、未完了カテゴリで打ち切り
   ▼
stage（合格累計技数。なわとび 0〜21 / 泳力 0〜24）
   │  kenteiStageToScore10: conversionTable を引く
   ▼
score10（成績計算で使う10点換算値）
```

**整合性のルール（監査診断セクション9 `checkKenteiIntegrity` で検査）**:
- `stage` は常に `kenteiCalcStage(config, passData)` と一致するはず
- `score10` は常に `conversionTable[stage].score10` と一致するはず
- 換算表を編集すると `recKenteiRecalcScores` が全スコアの score10 を再計算する
  （再計算漏れがあると「score10⇔換算表 不整合」として検出される）

**マイグレーション**: `migration_kenteiCard_v1`（localStorage の冪等フラグ）。
既存スコアに stage/score10/passData を付与済み。

### `spa_matome_questions` （まとめテストの問題定義）

```javascript
{
  "1234567890": [   // testId をキーとするマップ
    { points: 5, type: "知" },   // 1問目: 配点5、知識
    { points: 3, type: "思" },   // 2問目: 配点3、思考
    { points: 2 },               // 3問目: 配点2、type未設定 → デフォルト「知」扱い
    ...
  ],
  ...
}
```

**監査ポイント**:
- `type` の値: `"知"` / `"思"` / `"主"`
- `type` 未設定の場合、_matomeExtract で `"知"` 扱いになる（A-5の懸念）

### `spa_submissions_assignments` （提出物の課題定義）

```javascript
[
  {
    id: <数値>,
    name: "計算ドリル1",
    subject: "算数",
    due: "2026-05-22",
    ...
  },
  ...
]
```

### `spa_submissions_data` （提出記録）

```javascript
[
  {
    studentIndex: 5,
    assignmentId: 1234567890,
    status: "submitted",  // 'submitted' / 'resubmit' / 'missing' / 'late' / 旧:'○','△','×','A','◎'
    absent: false,        // 欠席フラグ
    correctionDone: true, // お直し完了
    lateOnDue: false,     // 当日未提出
    timestamp: "...",
    ...
  },
  ...
]
```

**監査ポイント**:
- status の旧形式が残っているデータがあり得る（'○', '△', 'A', '◎' など）
- grdGetSubmissionScore10 では `'submitted', '○', 'A', '◎', 'late'` 全てを「提出済み」扱い
- `'late'`（遅れて提出）も完全提出扱い ← 教育的妥当性は要確認

### `spa_patrol` （机間巡視記録）

```javascript
[
  {
    studentIndex: 12,
    subject: "国語",
    date: "2026-05-20",
    evals: {
      "発言": "○",      // '○' or '△' or 未設定
      "集中": "○",
      "協働": "△",
      "態度": "○",
      "思考": "○"
    },
    memo: "...",
    ...
  },
  ...
]
```

**監査ポイント**:
- evalsの「項目」と「観点」のマッピングは grdGetPatrolScore10 で定義
  - attitude: ['発言','集中','協働','態度','思考']
  - thinking: ['思考','発言','集中','協働']
- 重複している項目（発言、集中、協働、思考）が両観点に影響する仕様

### `spa_grade_thresholds` （ABC閾値）

```javascript
{
  "国語": {
    knowledge: { aThreshold: 80, bThreshold: 50 },
    thinking:  { aThreshold: 80, bThreshold: 50 },
    attitude:  { aThreshold: 80, bThreshold: 50 },
    final:     { grade3: 7, grade2: 5 }  // 評定3には合計7以上、評定2には合計5以上
  },
  "default": { ... },
  ...
}
```

**監査ポイント**:
- final.grade3 / grade2 のデフォルト値は何か
- 3観点合計の最大は3+3+3=9、最小は1+1+1=3

### `spa_grade_weights` （項目ごとの重み）

```javascript
{
  "国語": {
    knowledge: {
      "k_1234567890": 2,    // 'k_' + testId
      "mk_1234567891": 1,   // 'mk_' + testId (まとめテスト知識)
      ...
    },
    thinking: {
      "t_1234567890": 1,
      "mt_1234567891": 2,
      "patrol_thinking": 0.5,
      ...
    },
    attitude: {
      "a_1234567890": 1,
      "ma_1234567891": 1,
      "submission": 1,
      "patrol_attitude": 0.5,
      ...
    }
  },
  ...
}
```

**監査ポイント**:
- 重み未設定の項目は計算上どう扱われるか（B-4参照）
- itemKey の命名規則
  - `k_<testId>`: 知識のテスト
  - `t_<testId>`: 思考のテスト
  - `a_<testId>`: 主体性のテスト
  - `mk_<testId>`: まとめテストの知識部分
  - `mt_<testId>`: まとめテストの思考部分
  - `ma_<testId>`: まとめテストの主体性部分
  - `submission`: 提出物
  - `patrol_thinking`: 机間巡視（思考）
  - `patrol_attitude`: 机間巡視（主体性）

### `spa_attendance` （出席記録）

```javascript
{
  "2026-05-20": {
    "0": "○",
    "1": "×",
    "5": "／",   // 早退
    "8": "チ",   // 遅刻
    "12": "ソ",  // ソ?
    ...
  },
  "2026-05-21": { ... },
  ...
}
```

**ステータス記号**:
- `○`: 出席
- `×`: 欠席
- `／`: 早退
- `チ`: 遅刻
- `ソ`: 早退
- `チソ`: 遅刻+早退
- `忌`: 忌引
- `停`: 出席停止
- `休`: 欠席（その他）

---

## カルテ系データ

### `spa_karte_recs` （児童記録）

```javascript
[
  {
    id: <数値>,
    studentIndex: 7,
    date: "2026-05-20",
    rating: "excellent",  // 'excellent' / 'good' / 'concern' / 'action'
    category: "発言",     // '発言' / '友人関係' / '体調' / '提出物' / '学習態度' / 'その他'
    memo: "...",
    absent: false,
    createdAt: "..."
  },
  ...
]
```

**評価とemoji**:
- excellent: ◎
- good: ○
- concern: △
- action: ×

### `spa_karte_life` （生活記録）

```javascript
{
  "0": [   // studentIndex
    {
      id: <数値>,
      date: "2026-05-20",
      categories: ["健康", "提出物"],  // 複数カテゴリ
      summary: "...",
      detail: "...",
      createdAt: "..."
    },
    ...
  ],
  ...
}
```

---

## データの関係図

```
spa_master.students[i]   ←──── studentIndex（数値）で全データから参照
       │
       ├── spa_attendance[date][i]                  出席
       ├── spa_morning_prep[date][i]                朝の準備
       │
       ├── spa_scores (filter by studentIndex)      テスト点数
       │       └── testIdで spa_tests と結合
       │              └── matome の場合 spa_matome_questions と結合
       │
       ├── spa_submissions_data (filter by studentIndex)  提出記録
       │       └── assignmentIdで spa_submissions_assignments と結合
       │
       ├── spa_patrol (filter by studentIndex)      机間巡視
       │
       ├── spa_karte_recs (filter by studentIndex)  児童記録
       ├── spa_karte_life[i]                        生活記録
       ├── spa_karte_parent[i]                      保護者連絡
       ├── spa_karte_health[i]                      健康
       ├── spa_karte_learning[i]                    学習配慮
       │
       ├── spa_kanji ... ?                          漢字
       └── spa_forgotten_history ... ?              忘れ物
```

---

## 監査時に注意すべきデータ品質パターン

### パターン1: studentIndex のズレ

名簿を編集した時に発生する可能性:
```
編集前: students = [太郎, 花子, 次郎]   (index 0,1,2)
編集後: students = [太郎, 次郎]         (花子を削除、次郎が index 1 に)

→ 過去の「studentIndex: 2」の記録（次郎のもの）が、新しい index 1 とズレる
```

### パターン2: score の型の混在

```
{ studentIndex: 0, testId: X, score: 85 }    ← number
{ studentIndex: 1, testId: X, score: "A" }   ← string (古いデータ)
{ studentIndex: 2, testId: X, score: 90 }    ← number
```

### パターン3: status の旧値が残る

```
{ ..., status: "submitted" }    ← 新形式
{ ..., status: "○" }            ← 旧形式
{ ..., status: "A" }            ← 旧旧形式?
{ ..., status: "◎" }            ← 同上
```

### パターン4: category 欠損

```
{ id: X, name: "...", subject: "国語" }                          ← category 欠損
{ id: Y, name: "...", subject: "国語", category: "知識・技能" }   ← 正常
```

### パターン5: matomeQuestions の type 欠損

```javascript
[
  { points: 5, type: "知" },
  { points: 3 },              ← type 欠損 → デフォルト「知」扱い
  { points: 2, type: "思" }
]
```

### パターン6: 検定カードの score10 が換算表とズレる（フェーズ3a）

換算表を編集したのに再計算（`recKenteiRecalcScores`）が走らなかった場合、
保存済み `score10` が現在の `conversionTable` と食い違う。
監査診断セクション9の「score10⇔換算表 不整合」で検出される。

```
保存済み:  score10 = 1.3   （旧換算表で計算）
現在の表:  conversionTable[stage].score10 = 2.1
→ 不整合（再計算漏れの疑い）
```
