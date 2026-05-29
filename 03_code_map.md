# コード地図 (index.html v1.8.0 / フェーズ3a)

**ファイル**: index.html
**総行数**: 約13,638行（フェーズ3aで増加。編集でズレるため目安。関数は `grep -n` で再特定）
**総サイズ**: 約760KB

このドキュメントは、12,000行のコードのどこに何があるかを示す索引。
監査作業中、目的の関数を素早く特定するために使う。

---

## ファイル全体の構造

```
L1     <!DOCTYPE html>
L17    <style>                         ← CSS（約1738行）
L1755  </style>
L1758  <body>
L1760    <nav class="sidebar">         ← サイドバーメニュー
L1782    <div class="content">         ← メインビュー群（11ビュー）
L2920    </div>
L3087    <script>                      ← JavaScript本体（約9000行）
L12182 </script>
L12183 </html>
```

---

## ビュー構造（HTMLセクション）

| 行 | ビューID | 内容 | 概算行数 |
|---|---|---|---|
| L1784 | view-dashboard | 統合ダッシュボード | 48 |
| L1832 | view-settings | 名簿・設定 | 86 |
| L1918 | view-attendance | 出席簿 | 107 |
| L2025 | view-seating | 座席表 | 48 |
| L2073 | view-records | 児童の記録（含むカルテ） | 334 |
| L2407 | view-submissions | 提出物チェック | 121 |
| L2528 | view-forgotten | 忘れ物チェック | 92 |
| L2620 | view-grades | 成績処理統合 | 122 |
| L2742 | view-kanji | 漢字チェック | 30 |
| L2772 | view-export | データ出力 | 77 |
| L2849 | view-pf | 新体力テスト | 73 |

---

## JavaScriptモジュール構造

各モジュールは `// ▼▼▼ MODULE:NAME ▼▼▼` と `// ▲▲▲ MODULE:NAME ▲▲▲` で囲まれている。

| 行範囲 | モジュール | 行数 | 主な役割 |
|---|---|---|---|
| L3087-3243 | SAFE_HELPERS | 156 | escapeHtml, showToast, safeSetItem, getStorageUsage |
| L3245-3463 | STORAGE_MANAGER | 218 | IndexedDB + localStorage の統合管理 |
| L3465-3506 | KEYS | 41 | localStorageキーの定義 |
| L3508-3692 | INIT | 184 | DOMContentLoaded ハンドラ、起動時処理 |
| L3694-3769 | MASTER | 75 | 名簿・学級情報の管理 |
| L3771-3972 | DASHBOARD | 201 | ダッシュボード描画 |
| L3974-4525 | SEATING | 551 | 座席表（ドラッグ&ドロップ含む） |
| L4527-4702 | BACKUP | 175 | バックアップ・復元（AES-GCM暗号化） |
| L4705-5146 | ATTENDANCE | 441 | 出席簿 |
| **L5148-7622** | **RECORDS** | **2474** | **テスト記録、点数入力、机間巡視、カルテ** |
| **L7624-8546** | **SUBMISSIONS** | **922** | **提出物チェック** |
| **L8548-9955** | **GRADES** | **1407** | **成績処理統合（監査対象の核心）** |
| L9957-10496 | FORGOTTEN | 539 | 忘れ物チェック |
| L10498-10921 | KANJI | 423 | 漢字チェック |
| L10923-11199 | CSV_EXPORT | 276 | CSV出力 |
| L11201-11579 | WINDOW_EXPORTS | 378 | グローバル関数公開・新体力テスト |

---

## 監査の核心：GRADES モジュール

成績計算の中核は L8548-9955 の GRADES モジュール。
さらにその中の関数を詳細に。

### データアクセス層

| 行 | 関数 | 役割 |
|---|---|---|
| L8561 | grdInvalidate | キャッシュクリア |
| L8566 | grdGetStudents | 名簿取得 |
| L8567 | grdGetTests | テスト一覧取得 |
| L8571 | grdGetScores | スコア一覧取得 |
| L8575 | grdGetPatrol | 机間巡視取得 |
| L8579 | grdGetAssignments | 課題一覧取得 |
| L8583 | grdGetSubmissions | 提出記録取得 |
| L8587 | grdGetThresholds | 閾値設定取得 |
| L8599 | grdSaveThresholds | 閾値設定保存 |
| L8600 | grdGetSubjectWeights | 教科の重み取得 |
| L8604 | grdSaveSubjectWeights | 教科の重み保存 |
| L8609 | grdGetItemWeight | 項目ごとの重み取得 |

### 換算ロジック層（監査必須）

| 行 | 関数 | 役割 | 監査項目 |
|---|---|---|---|
| L8619-8625 | nawatobiToScore10 | なわとび級 → 10点 | B-2 |
| L8627-8635 | peRecordToScore10 | 体育実技 → 10点 | B-1 |
| L8636-8642 | abcTo10 | ABC → 10点 | B-3 |
| L8643-8646 | scoreTo10 | 素点 → 10点 | B-1 |
| L8647-8653 | score10ToABC | 10点 → ABC | B-8 |
| L8654 | abcToNum | ABC → 数値 | B-8 |
| L8655-8665 | calcWeightedScore | 重み付き平均 | B-4 |
| L8666-8687 | _matomeExtract | まとめテスト観点抽出 | A-5 |

> **更新（フェーズ3a / v1.8.0）**: `peRecordToScore10` は検定カード対応に改修済み（`kenteiGetConfig` 経由で score10/stage/passData を優先）。B-2 の「なわとび合格技数を級と誤解釈」バグは **修正済み**。旧 `nawatobiToScore10` は後方互換のデッドコードとして残置。検定カードの整合性は監査診断セクション9（`checkKenteiIntegrity`）で検査できる。※上表の行番号はフェーズ3aの追記でズレているため `grep -n 関数名` で再特定すること。

### 学期・期間判定

| 行 | 関数 | 役割 | 監査項目 |
|---|---|---|---|
| L8690 | grdGetCurrentTerm | 現在学期判定 | B-7 |
| L8691-8697 | grdGetTermRange | 学期の日付範囲 | B-7 |

### 派生スコア計算

| 行 | 関数 | 役割 | 監査項目 |
|---|---|---|---|
| L8700-8715 | grdGetSubmissionScore10 | 提出物 → 10点 | B-5 |
| L8718-8742 | grdGetPatrolScore10 | 机間巡視 → 10点 | B-6 |

### **成績計算コア**

| 行 | 関数 | 役割 |
|---|---|---|
| **L8747-8844** | **grdCalculate** | **教科の成績を全児童分一括計算** |

これが監査の最重要関数。

### 描画関数

| 行 | 関数 | 役割 |
|---|---|---|
| L9037 | grdRenderOverview | 概観表示 |
| L9073 | grdRenderDataStatus | データ状況 |
| L9102 | grdRenderGradeTable | 成績一覧表 |
| L9141 | grdRenderKarte | カルテ表示 |
| L9203 | grdRenderStats | 統計表示 |
| L9256 | grdRenderSettings | 設定画面 |
| L9285 | grdSaveAllThresholds | 閾値一括保存 |
| L9307 | grdRenderWeights | 重み設定描画 |

### エクスポート関数

| 行 | 関数 | 役割 | 監査項目 |
|---|---|---|---|
| L9399 | grdExportCSV | CSV出力 | E-2 |
| L9426 | grdExportExcel | Excel出力 | E-2 |
| L9546 | grdRenderKarteCenter | カルテ印刷準備 | |

---

## RECORDS モジュール（テスト・スコア・カルテ）

成績計算の「材料」を作る場所。

### スコア管理（監査関連）

| 行 | 関数 | 役割 | 監査項目 |
|---|---|---|---|
| L5164 | _invalidate | キャッシュクリア | |
| L5166-5169 | recGetTests | テスト一覧（キャッシュ付） | |
| L5170-5174 | recSaveTests | テスト保存 | |
| L5175-5178 | recGetScores | スコア一覧（キャッシュ付） | |
| **L5179-5189** | **recSaveScores** | **スコア保存（重複除去あり）** | **A-3** |
| L5190-5193 | recGetMatomeQ | まとめ問題取得 | |
| L5194-5198 | recSaveMatomeQ | まとめ問題保存 | |

### 検定カード共通モジュール（フェーズ3a / v1.8.0）

なわとび・泳力など「級判定型」の実技記録を統一的に扱う共通基盤。
プリセット（KenteiPresets: nawatobi=21技 / swimming=24技）から config を構築し、
passData（合格技の集合）→ stage（合格累計技数）→ score10（換算表引き）の順で換算する。

| 行 | 関数 | 役割 | 監査 |
|---|---|---|---|
| L5722 | KenteiPresets | なわとび/泳力プリセット（カテゴリ・技・換算表） | |
| L5823 | kenteiNawatobiStageScore10 | なわとび stage → 10点（旧級換算を stage基準で写経） | B-2 |
| L5836 | kenteiGetPresetId | peUnit → プリセットID（'なわとびカード' / '検定:swimming'） | |
| L5844 | kenteiGetConfig | テスト → config（kenteiConfig優先、なければプリセット構築） | |
| L5852 | kenteiBuildFromPreset | プリセットID → config | |
| L5864 | kenteiTotalSkills | config の総技数 | |
| L5870 | kenteiCalcStage | passData → stage（カテゴリ順に進み未完了で打切り） | |
| L5883 | kenteiStageToLabel | stage → 級ラベル | |
| L5893 | kenteiStageToScore10 | stage → 10点（conversionTable を引く） | B-2 |
| L5900 | kenteiIsLocked | カテゴリのロック判定 | |
| **L5913** | **window.kentei* 公開** | **getConfig/totalSkills/calcStage/stageToScore10/getPresetId を監査診断（別IIFE）へ公開** | Step6-1 |

**重要**: 検定ヘルパは RECORDS の IIFE（L5181〜L6847）内に閉じている。監査診断は別IIFEのため、
L5913 で `window.*` 公開して参照可能にしている。**公開を IIFE 外（例: モジュール末尾 L8010 付近）に置くと
未定義参照で ReferenceError → アプリ全体が停止する**ので、必ず IIFE 内（kenteiIsLocked 直後）で公開する。

### 検定カードの入力・換算表編集UI（フェーズ3a Step5）

| 行 | 関数 | 役割 |
|---|---|---|
| L5988 | recNwToggle | 技の合否トグル → stage/score10/passData を保存 |
| L6690 | テスト行「換算表」ボタン | kenteiGetConfig があるテストに表示 |
| L6701 | recKenteiRecalcScores | 換算表変更時に全スコアの score10 を再計算 |
| L6722 | recEditKenteiTable | 換算表編集モーダルを開く |
| L6769 | recSaveKenteiTable | 換算表を保存 → recKenteiRecalcScores |
| L6786 | recResetKenteiTable | プリセットに戻す |
| L6800 | recCloseKenteiTableModal | モーダルを閉じる |
| L6824 | migrateKenteiCardScores | 既存スコアに stage/score10/passData を付与（`migration_kenteiCard_v1` で冪等） |

### 監査診断の検定カードチェック（フェーズ3a Step6-1）

| 行 | 関数 | 役割 |
|---|---|---|
| L11955 | checkKenteiIntegrity | 検定カードの整合性検査（監査診断セクション9）。stage⇔passData / score10⇔換算表 の不整合、kenteiConfig 妥当性（技数・換算表行数）、`migration_kenteiCard_v1` を確認。`window.kentei*` を typeof ガード付きで呼ぶ |

### カルテ関連

| 行 | 関数 | 役割 |
|---|---|---|
| L6783-6814 | karteSafeGet系・karteGet系 | カルテデータ取得 |
| L6815-6868 | initKarteView, applyKarteMode, showKarte等 | カルテ表示制御 |
| L6892-7131 | renderKarteSummary | カルテサマリー描画（評価エビデンス） |
| L7132-7220 | renderKarteRecords | 児童記録描画 |
| L7276-7412 | renderKarteLife | 生活記録描画 |
| L7413-7503 | renderKarteParent | 保護者連絡描画 |
| L7504-7549 | renderKarteHealth | 健康・配慮描画 |
| L7550-7604 | renderKarteLearning | 学習配慮描画 |
| L7221-7274 | karteRec*（保存・編集・削除） | 児童記録の操作 |
| L7605-7633 | karteUndoLast | 削除アンドゥ |

### 机間巡視（評価データ源）

| 行 | 関数 | 役割 |
|---|---|---|
| L6467-6478 | getPatrolData, savePatrolData | 巡視データ管理 |
| L6512-6655 | renderPatrolGrid, openPatrolModal, setPatrolEval | 巡視入力UI |
| L6685-6782 | clearPatrolSession, showPatrolHistory等 | 履歴管理 |

---

## SUBMISSIONS モジュール（提出物）

成績計算の主体性評価データ源。

| 行 | 関数 | 役割 |
|---|---|---|
| L7634-7642 | subGet*, subSave* | データアクセス |
| L7704-7707 | subGetRoot | ルート要素 |
| L7768-7849 | subRenderAssignList, subAddAssign | 課題管理 |
| L7922-8002 | subInitInput, subRenderInputList | 入力UI |
| L8003-8084 | subSelectStatus, subClearStatus, subToggleLate, subToggleAbsent | ステータス操作 |
| L8193-8289 | subRenderStats | 統計表示 |
| L8290-8540 | subInitDiary, subRenderDiary | 日記管理 |

---

## INIT モジュール（起動処理）

| 行 | 内容 | 監査項目 |
|---|---|---|
| L3514-3574 | migrateScoreData | A-1 |
| L3577-3691 | DOMContentLoaded ハンドラ | |
| L3610-3620 | StorageManager の段階的初期化 | |

---

## バックアップ（データ消失対策の核）

| 行 | 関数 | 役割 |
|---|---|---|
| L4531-4540 | openBackupModal, closeBackupModal | UI |
| L4542-4549 | deriveEncKey | PBKDF2鍵導出 |
| L4550-4565 | encryptData | AES-GCM暗号化 |
| L4566-4576 | decryptData | 復号 |
| L4578-4623 | exportBackup | バックアップ書き出し |
| L4624-4678 | importBackup | バックアップ復元 |
| L4679-4701 | wipeLocalData | 全データ消去 |

---

## 監査作業で頻繁にアクセスする箇所トップ10

1. **L8747-8844 grdCalculate** — 成績計算の核心
2. **L8619-8665 換算関数群** — 各データ型の10点換算
3. **L3514-3574 migrateScoreData** — 過去データの変換
4. **L5179-5189 recSaveScores** — 重複除去ロジック
5. **L8666-8687 _matomeExtract** — まとめテストの観点抽出
6. **L8700-8715 grdGetSubmissionScore10** — 提出物換算
7. **L8718-8742 grdGetPatrolScore10** — 巡視換算
8. **L8690-8697 学期判定** — 期間フィルタ
9. **L6892-7131 renderKarteSummary** — 評価エビデンス表示
10. **L9426以降 grdExportExcel** — エクスポート整合性

---

## 監査時の view コマンドの目安

各関数を読むときの推奨範囲（コンテキスト節約のため、必要分だけ読む）:

```
grdCalculate           : L8747-8844 (約100行)
換算関数全部           : L8619-8687 (約70行)
migrateScoreData       : L3514-3574 (約60行)
recSaveScores周辺      : L5160-5200 (約40行)
派生スコア             : L8700-8742 (約45行)
renderKarteSummary要点 : L6892-6970 (約80行)
```
