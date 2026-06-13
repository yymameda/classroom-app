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

## 確立済みノウハウ

- `Date` のモック: `window.__RealDate` に元のDateを保存し、`class MockDate extends RealDate` で
  `new Date()` / `Date.now()` を固定タイムスタンプに差し替える（引数ありの`new Date(...)`は素通し）。
- `StorageManager` の保存は `safeSetItem` により500msデバウンスで `localStorage` に書き込まれる。
  保存値を確認する際は、表示切替ボタンのクリック（`subFlushAutoSave`発火）→ 700ms程度待機してから
  `localStorage.getItem(...)` を読む。
