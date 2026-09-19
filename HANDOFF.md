# classroom-app 引き継ぎメモ（2026-09-20 時点・公開済みは v1.53.1／手元は v1.54.0）

次のセッションは、まずこのファイルと `CLAUDE.md`、`UI_WORKLOG.md`（末尾の最新セッション）、
`DATA_FLOW_AUDIT.md`（該当章）を読む。`push` は先生の承認が出るまでしない。

## 1. 現在の状態

- 公開済み: **v1.53.1**（iPad 確認済み）。手元の `main` は **v1.54.0（4c。commit 済み・push は先生の承認待ち）**。`git log origin/main..HEAD` で確認する。
- 端末は先生の iPad（PWA・DevTools なし。確認は必ず画面操作で案内する）。1クラス最大30人。
- 先生は 4b（v1.53.0）以降を入れる前にバックアップ済み。**iPad（v1.53.1）で確認済み（2026-09-20・問題なし）**:
  バージョン表示 v1.53.1／起動直後に「新しい方式に更新しました」の通知／診断カードが「児童ごと（新方式）」「一致しています」／
  新体力テストの記録が更新前と同じ児童に付いている／変更なしで保存すると「変更はありません」／気になった点なし。
  → pf の新方式への自動移行は実機で成功。以後、先生の端末は新方式（v2）。
- 先生の端末の実測（4a）: 名簿は pf と一致・27名・単体ページ pf.html の使用の痕跡なし・手入力の児童なし・記録は2026年度27名。

## 2. H4（児童ID化）の進捗 — 詳細は DATA_FLOW_AUDIT.md 7〜20章

| 段階 | 内容 | 版 | 章 |
|---|---|---|---|
| 1 | 児童ID（`studentId`）付与・起動時移行・退避コピー | v1.51.0 | 9 |
| 2a/2b | 付け替えの純関数・18ストア登録表／トランザクション・退避・復元・取り消し | v1.51.1/2 | 11, 13 |
| 2c | pf 連携（旧方式で一致するときだけ追従） | v1.51.3 | 14 |
| 3 | 名簿編集をリスト編集UI（下書き→保存）へ。退避カード | v1.52.0 | 15 |
| 4a | pf 連携状態の診断表示（読み取り専用） | v1.52.1 | 17 |
| 4d-1 | `importBackup` の安全化（復元前の退避・検証付き書き込み・取り消し） | v1.52.2 | 18 |
| 4b | pf の記録を studentId キーへ（起動時移行・名簿変更・復元・取り込み・pf画面） | v1.53.0 | 19 |
| 追加 | 通知がボタンを隠す不具合の修正／起動直後の競合の修正／`pf.html` 暫定ガード | v1.53.1 | 20 |
| 4c | 旧方式の記録の「氏名で引き継ぐ」・`pf-residual` の単体復元・`pf-unlinked` | v1.54.0（未push） | 21 |

関連: H8（IndexedDB の鏡に氏名が残る）は 12 章で対応済み（v1.51.2・v1.51.3）。

### 残り（実施順: 4d-2 → 4e。4c は実装済み・push 待ち）

- 4c の実装内容は DATA_FLOW_AUDIT.md 21章。先生の端末は名簿が一致して自動移行済みのため、4c の画面は今の端末には出ない。
- **4d-2**（16.6）: バックアップに `version: 11`・`studentIdSchema: 1`・`pfSchema: 2` の印を付け、
  `importBackup` で版を判別。復元後の整合性検査（`studentId` の重複・欠落、pf の新旧混在、退避の孤立）。
  現状の書き出しは version 10 のまま。
- **4e**（16.7 案P1・決定 a）: `pf.html` 本体を「アプリのタブへ移動する」案内ページに置き換える
  （JSONバックアップ機能はSPA本体のバックアップに一本化）。今は暫定ガード（20.3）のみ。

## 3. 未対応項目（DATA_FLOW_AUDIT.md 3章。行番号は調査時点）

- **M2** 提出率の定義が3系統（成績・カルテ・ダッシュボード）で不一致。方針確認が必要。
- **M3** 面談用テキストの学期が混在。**M4** レーダーPDFの教科カードの学期・遅れ係数・主体性の扱い。
- **M5** 同僚用テンプレートxlsxの学期フィルタなし・得点方式の誤分類・算出根拠の `1→4点` ラベル。
- **M7** 専科成績に学期がない。**M8** 主体性の得点方式・まとめテストに `lateSubmit ×0.8` が未適用。
- **M9** テスト成績/提出物CSVが生データのみ（提出物CSVの欠席セルだけ M6 で対応済み）。
- **L1〜L7**（将来リスク。3章「低」）: 未使用キー `spa_grades`、授業態度記号の変換、専科の評定しきい値固定、
  課題保存時の `createdAt` 上書き、名簿縮小後の範囲外 studentIndex の混入、「入力済 x/N」の数え方、主体性得点の文字列 score。
- **`tests/test_grades.js` が2件失敗（v1.49.0・コミット 5ac43ca から。H4 とは無関係。21.1）**。「category復帰後の割合(87%)」「別の課題に切り替えてから戻っても割合」。
  `*.test.js` の名前規則から外れるため全体実行から漏れていた。アプリの不具合かテストの期待の古さかは未調査。
- **メモリ記載の予定**: Step4-D — `recNwUpdateCardUI` 汎用化時に `recNwCalcGrade` → `kenteiStageToLabel` へ置き換える。
- **H4 の既知の制約**（19章・18章）: 旧方式で一致しない端末で pf の「名簿を読み込む」を押すと、従来どおり記録が別の児童に付く
  （10.5。次の起動でその状態を忠実に新方式へ移行するだけで、新たなずれは作らない。4c で解消）。
  取り消し点は1つで、名簿変更とバックアップ復元で共用（起動時の pf 移行は取り消し点を残さない）。
  旧版（v1.52.x 以前）へ戻すのは非推奨。
- 診断ツールの `spa_migration_backup_studentId` は氏名を含むため内容を出さない（文字数のみ）。

## 4. 確定済みの設計判断（要点）

- フィールド名は **`studentId`**（`stu_`+8桁）。`students[].id` は増やさない（pf の `s.id` と衝突するため）。
- 保存形式は**添字キーのまま**（案B）。名簿変更時に `applyRosterChange` が18ストアを一括付け替え
  （登録表 `STUDENT_KEYED_STORES`・不変条件 I1〜I7）。案C（全面のID化）は必要性を再評価してから。
- **localStorage が真実、IndexedDB は鏡**。書き込みは `storageVerifiedWrite/Remove`（直接読み戻して検証）。
  `StorageManager.setImmediate` は容量超過を握りつぶすため、重要な書き込みには使わない。
- トランザクション: 容量の実測確認 → スナップショット（`spa_roster_snapshot`・1世代）→ ジャーナル（`spa_roster_txn`）→
  書き込み → 検証 → 確定。失敗はロールバック、強制終了は次の起動（`loadMaster` より前）で自動復旧。
  名簿変更・復元・pf 移行が同じ仕組み（`kind` で区別）。
- 名簿編集UI: 下書き→保存ボタン（1回の保存＝1トランザクション＝取り消し1回）。確認ダイアログは使わない。
  完全削除は**2回タップ**。名簿を変える直前にバックアップを促すトースト（操作は止めない）。
- 削除した児童のデータは消さず `spa_student_archive` に退避（復元・完全削除）。
- pf: 記録・集計のキーを **`studentId`**（`pf_key(s)`）。`id` は表示用の番号。手入力の児童は `pfm_` の ID（移行の対象外）。
  起動時の移行は、pf 名簿がSPA名簿と**氏名・順序・id とも一致するときだけ**位置で変換。一致しなければ触らない。
- バックアップ復元（18章）: 復元前に変更キーを退避。容量不足なら**警告して続行**（消す操作はしない）。
  バックアップに無い児童別キーは、名簿が違うときだけ消す（取り消しで戻る）。別アプリのキーは端末に無いときだけ書く。
- 保護者向けの出力（PDF・帳票）に内部の警告・診断を出さない。診断カード等は設定画面の中だけ。
- 通知（トースト）は下のボタンへのタップを受けない（`pointer-events: none`。「元に戻す」だけ auto）。

## 5. 開発ルール

- 大きなファイルは**差分編集**（Edit の置換や小さなスクリプト）。全文の書き直しはしない。差分の提示は `git diff` 標準形式（`-`/`+`）。
- 編集後は `node --check`（`index.html` はインラインスクリプトを取り出して検査）。テスト・スクリプトも同様。
- 変更のたびに **`sw.js` の `CACHE_VERSION` を上げる**（`pf.html` もキャッシュ対象）。版を変えないと iPad が更新されない。
- `git add` は**ファイル名を明示**（`-A`・`.` は使わない。作業ツリーには過去の未追跡ファイルが多数ある）。
  1段階1コミット以上。機能・テスト／ドキュメント／`sw.js` は別コミット。コミットの末尾に Co-Authored-By 行。
- **push は先生の承認後**。承認前は commit までで停止して報告する。実機の挙動が変わる段階は「バックアップ → 更新 → 確認」の順で案内。
- 報告は簡潔に。**末尾に必ず「先生向けまとめ」**（やさしい言葉で: 先生にとって何が変わるか／iPad での作業／決めること）。
- 調査だけの依頼ではコードを変えない。設計案 → 先生の承認 → 実装の順。判断を仰ぐ項目があれば実装前に止まる。
- テストは**失敗させてから直す**（fail-first）。実装を一時的に壊す**変異テスト**で検出できることも確認する。
- iPad に DevTools はない。確認手段は画面表示（設定の診断カードなど）とスクリーンショットで案内する。
- `classroom-app` の資料を Artifact で外部公開しない（オフライン・ローカル保存の原則）。チャットかリポジトリ内のファイルで出す。
- テストは実際の操作順序・状態遷移（blur の順序、編集・切替・削除後の再描画）を、DOM 直接代入ではなく
  `page.click()`/`type()` と実際の関数呼び出しで再現する。プリセット改修時は「プリセットに戻す」系の経路も grep で監査する。

### テストの実行

```sh
# 別ターミナルで(リポジトリのルートで):
python3 -m http.server 8123
# もう一つのターミナルで:
cd tests && npm install                # 初回のみ
node <名前>.test.js                    # 単独
for f in *.test.js; do node $f; done   # 全体(55ファイル)
node test_grades.js                    # 名前規則の外(全体に含まれない)。現在2件失敗(上記)
node attendance-snapshot.js            # 引数なし。全体実行のあとに必ず PASS を確認
```

- `*.test.js` の全体は55ファイル・1589 PASS・0 FAIL（約13分）。`tests/README.md` の表の合計（1322）は数え方が違う（PASS 行の数でなく検査の集計。`test_grades.js` を含む）ので、件数は実行結果で確認する。Chrome は `/Applications/Google Chrome.app`。
- 環境変数: `ONLY=H1,H2…`（data-reflection）、`PFM_ONLY=1,4`（pf-migration の章指定）、
  `ROSTER_SHIFT_FORCE=1`（roster-shift の実適用を強制）、`PF_BASE=http://…/`（pf-guard の接続先）。
- **同じテストを並列に走らせない**（一時ファイル名の衝突）。テストの追加・`index.html`/`pf.html` の変更中に全体実行をしない。
- 落とし穴: 日本語入力欄の置き換えは `element.select()`（トリプルクリックは不可）。通知の確認は `#toast.show #toastMsg`
  （`document.body.textContent` はスクリプトの文字列を含み常に真）。再読み込み後の通知は数秒遅れて出るので、
  次の操作の前に `#toast` が消えるのを待つ。テストの初期データの児童IDは固定する（起動時の採番で毎回変わるため）。

## 6. テスト専用フック・内部フラグ

| 名前 | 場所 | 用途 |
|---|---|---|
| `window.__spaSkipPfMigration = true` | `index.html`（`migratePfStudentIdV1` の先頭） | 起動時の pf 新方式への移行を無効にする。**テスト専用**。`page.evaluateOnNewDocument` で再読み込みをまたいで設定する（`roster-pf`・`backup-restore` が使用）。戻すときは `removeScriptToEvaluateOnNewDocument` |
| `window.__spaWasWiped` | `index.html` | 内部フラグ（直前が退勤モード消去か）。`idbGhostPurgeDue` が参照。テストで書き換えない |
| `window.__pendingIdbDeletes` | `index.html` | 内部。IndexedDB の準備前に検証付きで削除したキーの一覧（準備後に鏡から消す）。テストの seed 前に `[]` へ戻すことがある |
| `window.__PF_GUARD` | `pf.html` | 内部フラグ。新方式のデータを検出したときだけ true（本体スクリプトを止める） |
| `window.__fault` / `window.__marker` / `__w` など | テスト側で定義 | 失敗注入・再読み込み検出・書き込み監視。アプリ本体には無い |

- 公開している内部関数（テストから呼ぶ）: `applyRosterChange`・`restoreArchivedStudent`・`undoRosterChange`・`brRestoreFromBackup`・
  `brPlanRestore`・`buildBackupObject`・`planPfMigration`・`migratePfStudentIdV1`・`pfDiagnose`・`grdImportFitnessTest`・
  `StudentRemap`（`planRosterChange` など）。失敗注入は `Storage.prototype.setItem/removeItem` の差し替えで行う。
- `tests/helpers/roster-ui.js`（名簿UIの操作）と `tests/helpers/roster-data.js`（18ストアの合成データ・持ち主の目印・6操作）が共通ヘルパー。

## 7. 主なキーと関数の地図

- キー: `spa_master`（名簿・classInfo）、`spa_student_archive`（退避）、`spa_roster_snapshot`/`spa_roster_txn`（取り消し点・
  ジャーナル。バックアップに含めない）、`pf_roster`・`pf_records_年度`・`pf_fitness_年度`・`pf_setting`（新体力テスト。`StorageManager` を通らず
  localStorage 直）、`migration_studentId_v1`・`migration_pfStudentId_v1`（完了の印。診断カードが表示）。
- 名簿系は `index.html` の MASTER モジュール（`applyRosterChange`・`srRunTransaction`・`planPfChange`/`planPfChangeV2`・
  `recoverRosterTxnOnStartup`）、復元は BACKUP モジュール（`brRestoreFromBackup`・`importBackup`）、pf 画面は末尾の `pf_*` 関数群。
- 起動順: `DOMContentLoaded` で同期的に 復旧 → 各種移行 → `loadMaster` → `migrateStudentIdsV1` → `migratePfStudentIdV1`、
  そのあと非同期で IndexedDB（`migrateFromLS` → `loadCache` → `flushPendingIdbDeletes`）。詳細は 20.2。

## 8. 次の一手（推奨）

1. 4c（v1.54.0）の push を先生に承認してもらう（承認後に push → 先生の端末は変化なし・確認は「バージョン表示が v1.54.0 になり、いつもの操作が変わらない」）。
2. 4d-2 の設計を確認して実装（commit まで → 報告 → 承認 → push）。
3. 4e。4e の後で `pf-residual`・暫定ガードの整理と、DATA_FLOW_AUDIT.md の 7.5 の実施順の更新。
4. H4 完了後に M2〜M5・M7〜M9・L1〜L7 の優先順位を先生と決める（成績値が変わるものは方針確認が先）。
