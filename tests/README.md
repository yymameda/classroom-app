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

## 常時グリーンのテスト（合計312件）

| ファイル | 件数 |
|---|---|
| `pe-rubric.test.js` | 74 |
| `pe-score10.test.js` | 23 |
| `absent.test.js` | 14 |
| `attendance-stats.test.js` | 22 |
| `v1.8.49.test.js` | 24 |
| `v1.8.51.test.js` | 8 |
| `v1.8.51_commit3.test.js` | 14 |
| `undo.test.js` | 32 |
| `emptystate.test.js` | 7 |
| `test_grades.js` | 74 |
| `audit-range-check.test.js` | 20 |
| **合計** | **312** |

`test_grades.js` のみファイル名が `*.test.js` 命名規則から外れている（成績入力形式統一
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
