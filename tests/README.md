# 機械検証ハーネス（v1.8.49〜）

puppeteer-core + ローカルChrome.app + python3 http.server を使ったブラウザE2E検証。
ロジック切り出しは行わず、index.htmlをそのまま動かして検証する。

## セットアップ

```sh
cd tests
npm install
```

Chromeのパスは `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` を前提とする
（macOS既定インストール先。別環境の場合は各テストスクリプト内の `executablePath` を変更する）。

## 実行手順

1. リポジトリルートで静的サーバを起動（別ターミナル）:
   ```sh
   cd classroom-app
   python3 -m http.server 8123
   ```
2. テストを実行:
   ```sh
   cd tests
   node v1.8.49.test.js
   ```

## 全テストの実行と一覧（`node run-all.js`）

全体実行の標準手順は **`cd tests && node run-all.js`**（リポジトリのルートで `python3 -m http.server 8123` を起動しておく）。
`tests/` 直下の `*.js` を**名前規則に頼らず**すべて順番に実行する（`*.test.js` 以外の `test_grades.js`・`attendance-snapshot.js` も含む。
`helpers/` は対象外）。ファイルごとの検査数と終了コードを表示し、合計と、下の表との照合結果を出す。
終了コードは、全ファイルが成功（終了コード0・失敗0）かつ表と一致したときだけ 0。
`--only=名前の一部` で一部だけ実行、`--list` で対象の一覧、`--write-readme` で下の表を実測値に更新（テストを追加・変更したら実行する）。
検査数は各ファイルの集計行から読み取る（形式は複数ある）。**新しいテストが読み取れない形式で出力する場合は `run-all.js` の `parseCounts` に形式を加える**。
（`node <名前>.test.js` の単独実行もこれまでどおり可能。並列には走らせない。）

<!-- run-all:table:start -->
| ファイル | 検査数(PASS) | FAIL |
|---|---|---|
| `absent.test.js` | 14 | 0 |
| `attendance-snapshot.js` | 1 | 0 |
| `attendance-stats.test.js` | 22 | 0 |
| `audit-inputmode-conflict.test.js` | 12 | 0 |
| `audit-inputmode-repair.test.js` | 43 | 0 |
| `audit-maxscore-abc-exclusion.test.js` | 10 | 0 |
| `audit-range-check.test.js` | 25 | 0 |
| `backup-restore.test.js` | 71 | 0 |
| `boot-race.test.js` | 8 | 0 |
| `category-edit-inputmode.test.js` | 14 | 0 |
| `composition-5rank.test.js` | 28 | 0 |
| `data-load-failure-guard.test.js` | 10 | 0 |
| `data-reflection.test.js` | 45 | 0 |
| `descriptive-item-5rank.test.js` | 26 | 0 |
| `emptystate.test.js` | 7 | 0 |
| `idb-residue.test.js` | 27 | 0 |
| `input-mode-fix.test.js` | 49 | 0 |
| `isabc-consolidation.test.js` | 18 | 0 |
| `isabc-editform-fix.test.js` | 10 | 0 |
| `item-input-mode.test.js` | 27 | 0 |
| `kentei-nw-delete-on-zero.test.js` | 21 | 0 |
| `list-scroll-cutoff.test.js` | 33 | 0 |
| `matome-abc-deadcode-removal.test.js` | 15 | 0 |
| `matome-abc-mode-removal.test.js` | 20 | 0 |
| `matome-range-check.test.js` | 32 | 0 |
| `pe-reflection-5rank.test.js` | 20 | 0 |
| `pe-rubric-dense-render-error.test.js` | 6 | 0 |
| `pe-rubric.test.js` | 115 | 0 |
| `pe-score10.test.js` | 25 | 0 |
| `person.test.js` | 34 | 0 |
| `pf-diagnosis.test.js` | 37 | 0 |
| `pf-guard.test.js` | 46 | 0 |
| `pf-migration.test.js` | 116 | 0 |
| `pf-takeover.test.js` | 72 | 0 |
| `rec-edit-return-flow.test.js` | 36 | 0 |
| `rec-input-term-filter.test.js` | 14 | 0 |
| `rec-save-inline-btn.test.js` | 8 | 0 |
| `recaddtest-maxscore-validation.test.js` | 16 | 0 |
| `roster-pf.test.js` | 71 | 0 |
| `roster-preserve.test.js` | 10 | 0 |
| `roster-shift.test.js` | 240 | 0 |
| `roster-transaction.test.js` | 70 | 0 |
| `roster-ui.test.js` | 71 | 0 |
| `rubric-band-move-v1.42.0.test.js` | 14 | 0 |
| `student-id-migration.test.js` | 37 | 0 |
| `student-remap.test.js` | 53 | 0 |
| `sub-progress-filter-merge-v1.47.0.test.js` | 56 | 0 |
| `sub-tile-fit.test.js` | 8 | 0 |
| `test_grades.js` | 89 | 0 |
| `tile-btns-oneline.test.js` | 14 | 0 |
| `tile-vheight-v1.41.0.test.js` | 28 | 0 |
| `toast-passthrough.test.js` | 8 | 0 |
| `undo.test.js` | 32 | 0 |
| `v1.8.49.test.js` | 24 | 0 |
| `v1.8.51.test.js` | 8 | 0 |
| `v1.8.51_commit2.test.js` | 20 | 0 |
| `v1.8.51_commit3.test.js` | 14 | 0 |
| `v1.8.52.test.js` | 13 | 0 |
| `v1.8.54_cleanup.test.js` | 13 | 0 |
| **合計（59ファイル）** | **2026** | **0** |
<!-- run-all:table:end -->

`roster-shift.test.js` は付け替え計画レベル(有効)と実適用レベル(`applyRosterChange` 経由。v1.51.2 から有効。未実装の環境ではSKIP、`ROSTER_SHIFT_FORCE=1` で強制実行)の2部構成。共有データ生成は `helpers/roster-data.js`。

`pf-diagnosis.test.js`(v1.52.1)は設定の「新体力テストの連携状態」表示を検証する。読み取り専用(localStorage/IndexedDBへの書き込み0回)・氏名を表示しない・一致/不一致の理由・pf_fitness の痕跡・SPAにいない児童の人数を、実際に画面を開いて確認する。

`pf-takeover.test.js`(v1.54.0)は、旧方式の記録の「氏名で引き継ぐ」(計画・実行・全キー比較・失敗注入・画面)と、退避した pf-residual の単体復元を検証する。

`toast-passthrough.test.js`(v1.53.1)は、通知(トースト)が保存ボタンなどへのタップを受けないことを、保存ボタンの真上に通知を重ねた状態で確認する(全体実行で一度だけ失敗した原因の再現テスト)。`boot-race.test.js` は IndexedDB の準備を遅らせた起動で、準備前に書き直されたキーが消されないことを確認する。`pf-guard.test.js` は新方式の端末で pf.html を開いても何も書き込まないこと(案内だけ表示)を確認する。

`pf-migration.test.js`(v1.53.0)は新体力テストの児童ID化を検証する。起動時の移行(全キー比較・失敗注入)・新方式の名簿変更6操作・取り込み・pf画面の実操作・旧方式のバックアップの復元後の再移行。`PFM_ONLY=2,4 node pf-migration.test.js` のように章を指定して実行できる(変異テスト用)。`roster-pf.test.js` は旧方式(v1)の動作の検証のため、テスト専用フック `window.__spaSkipPfMigration` で起動時の移行を無効にしている。

`backup-restore.test.js`(v1.52.2)はバックアップの復元の安全化を検証する。計画・退避(スナップショット/ジャーナル kind:backup-restore)・検証付き書き込み・ロールバック・起動時の自動復旧・取り消し・退避できないときの警告と続行を、容量超過15通り・内容破損15通り・強制終了18通りの失敗注入と、実際の画面(バックアップ画面のファイル選択→復元ボタン)で確認する。再読み込み後の通知は表示が数秒遅れて出るため、次の操作の前に `#toast` が消えるのを待つこと。

名簿編集UIは v1.52.0 でリスト編集UIに変わった。`roster-ui.test.js` は実際のタップ・入力でUI操作を行い(`helpers/roster-ui.js`)、6操作×18ストア＋pfのずれ0・取り消し・退避の復元/完全削除・再読み込み後の画面を検証する。`roster-preserve.test.js` と `student-id-migration.test.js` の名簿変更もこのUI操作経由。日本語入力欄の置き換えは `element.select()` を使うこと(トリプルクリックでは全選択にならない)。トーストは `#toast.show #toastMsg` を確認する。

`data-reflection.test.js`（v1.50.0〜）は `ONLY=H1,H2,H3,M1,M6` で項目別に実行できる。

`test_grades.js`（v1.54.1 で 89/89。v1.49.0〜v1.54.0 は2件失敗していたが、旧データの観点変更の不具合の修正と、古くなっていた期待の更新で解消。DATA_FLOW_AUDIT.md 22章）は、全体実行（`run-all.js`）に含まれる。`test_grades.js` のみファイル名が `*.test.js` 命名規則から外れている（成績入力形式統一
プロジェクト開始前からの既存ファイル名を踏襲）。abcTo10・scoreTo10・score10ToABC・
abcToNum・calcWeightedScore・grdGetCurrentTerm など成績計算コア(grdCalculate)の
換算値を、window公開済みの実装関数を直接呼ぶ形で検証する（ロジックのハードコピーはしない）。

上記すべてが全件PASSであることに加え、リポジトリ直下で
`node attendance-snapshot.js`（引数なし）を実行して `PASS` になることも、
push前の必須確認手順とする。`FAIL` の場合は `--update` せず、まず原因を
報告すること（出欠の集計値が実際に変わったのか、テスト側の不備かを
切り分けるまで基準ファイルを書き換えない）。

## 確立済みノウハウ

- `Date` のモック: `window.__RealDate` に元のDateを保存し、`class MockDate extends RealDate` で
  `new Date()` / `Date.now()` を固定タイムスタンプに差し替える（引数ありの`new Date(...)`は素通し）。
- `StorageManager` の保存は `safeSetItem` により500msデバウンスで `localStorage` に書き込まれる。
  保存値を確認する際は、表示切替ボタンのクリック（`subFlushAutoSave`発火）→ 700ms程度待機してから
  `localStorage.getItem(...)` を読む。
- 実データのキー（`KEYS.*` / `ATT_KEY` / 成績のrec系キー等）を触るテストは、
  ケースごとに元の値を退避して `try/finally` で必ず復元し、節の最後に
  「触れた全キーが元の値に戻っている」ことを確認する check を1件足す
  （`undo.test.js`「実データ往復」節を参照）。
- 実装の内部状態（`StorageManager._cacheLoaded`、`attCurrentDate` 等）に
  一時的に依存する検証は、そのケースが落ちたときに「実装の退行」と
  誤読されないよう、何に依存しているか・落ちたら何をまず疑うべきかを
  コメントで明記する。
- ストレージキー名をテストコード側に直書きする場合（`REC_KEYS` のように
  実装側がモジュール内部のprivate変数でwindowから参照できない等）、
  キーの存在確認だけでは実装側のキー名変更をすり抜けてPASSし続けてしまう。
  必ず実装関数（`recDeleteTest`等）を実際に通し、その結果が直書きした
  キーに反映されるかどうかで一致を確認すること。
- トースト（`#toastUndoBtn`等）のクリックは、`.toast.show` のCSSトランジション
  （0.3s）が完了してから行う。待たずにクリックすると要素がまだ画面外にあり
  Puppeteerの `page.click()` が「Node is either not clickable」で失敗する。
- 破棄関数・確定フックの例外耐性など、意図的に例外を発生させるテストは、
  専用のマーカー文字列（例: `__uiUndoTest_intentional_throw__`）を仕込み、
  末尾の「コンソールエラーなし」チェックからそのマーカーを含むエラーだけを
  除外する。
- `grdCalculate`は同じ`subject`の全テストを`studentIndex`単位で集計するため、
  test_grades.jsに新しいテストケースを追加する際、既存ケースが使っている
  `studentIndex`を同じ教科で再利用すると、既存の集計結果(kAvg/kABC等)が
  無言で汚染される。特にまとめテスト(`type:'matome'`)は要注意で、
  `matomeQuestionTypes`を設定しない場合、`_matomeExtract()`は
  `category`が「思考・判断・表現」「主体性」のいずれでもなければ
  「知識・技能」として計上してしまう（category:'複合'でも同様）。
  新しいケースは、その教科で未使用のstudentIndexを使うこと
  （grdCalculateを呼ばずrecRenderList側のDOM表示だけを見るテストケースでも、
  同じstorageを共有する以上この汚染は起きる）。
- 同じ入力欄を複数のイベントハンドラ（`onblur`と保存ボタンの`onclick`等）が
  扱う機能を検証する際は、実際のユーザー操作の順序を再現すること。保存ボタンの
  クリックは、押す前にフォーカスされていた入力欄の`blur`を必ず先に発火させる。
  DOMに直接値を代入してから対象の関数を直接呼ぶだけのテスト（`page.click()`/
  `page.type()`を使わない形）は、この`blur`が先に発火する順序を再現できず、
  もう一方のハンドラに残っていた重複バリデーションを見逃した実例がある
  （段階1やり直し、2026-08-25）。
- 「一度描画された画面に対する操作」だけでなく、**状態遷移**（設定変更・
  課題の切り替え・保存後の再描画・削除）をテストに含めること。段階1・段階2で
  連続して同じ見落としが起きた：段階1はDOMへの直接代入がblurの発火順序を
  再現しなかった事故（直上の項目）、段階2は満点をrecEditTest/recAddTestで
  変更した後、既に開いていた採点画面（割合表示span）が再描画されず古い満点の
  計算値が残る事故。どちらも「1回描画した後、何も状態を変えずに操作する」
  テストだけでは検出できず、実際に`recEditTest`→フィールド変更→`recAddTest`→
  再描画確認、のように**画面の外側から状態を変えてから**その反映を検証する
  ケースを明示的に追加して初めて見つかった（`recSyncScoreCell`集約、
  2026-08-25）。
