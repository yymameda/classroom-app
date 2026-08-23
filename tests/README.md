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

## 既知の未整備テスト（段階的対応中）

以下は現時点で全件グリーンになっていない、または実行環境が未整備のテストファイル。
削除はせず残しているが、常時グリーンの対象には含めていない。

- `emptystate.test.js`（未追跡） … git 管理下に無い試作。jsdom 依存かつ
  実行方式が他と異なるため、puppeteer-core 方式で書き直す予定
- `undo.test.js`（未追跡） … git 管理下に無い試作。揮発する
  `/tmp/helper_src.js` に依存。puppeteer でページ内の uiUndoable を
  直接検証する形に書き直す予定
- `v1.8.49.test.js` … 一部ケースが v1.8.63 の仕様変更（提出物「空欄＝未提出」統一）に未追随
- `v1.8.51.test.js` … 検証7-2が1件失敗。移行直後のバックアップが
  `cleanupOldKanjiBackups()` に即削除される挙動を「不具合」として期待している
  が、フラット化移行は実運用上すでに完了しており、バックアップを残す方向の
  変更はローカルストレージに児童データを増やすため採らない。テスト側の
  期待値を現行挙動に合わせて修正する予定（index.html は変更しない）
- `v1.8.51_commit3.test.js` … 一部ケースが色判定の優先順位変更（未提出優先化）に未追随

## 確立済みノウハウ

- `Date` のモック: `window.__RealDate` に元のDateを保存し、`class MockDate extends RealDate` で
  `new Date()` / `Date.now()` を固定タイムスタンプに差し替える（引数ありの`new Date(...)`は素通し）。
- `StorageManager` の保存は `safeSetItem` により500msデバウンスで `localStorage` に書き込まれる。
  保存値を確認する際は、表示切替ボタンのクリック（`subFlushAutoSave`発火）→ 700ms程度待機してから
  `localStorage.getItem(...)` を読む。
