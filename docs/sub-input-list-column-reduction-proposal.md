# 提出物チェック・タイル列数削減案（未適用・次回すぐ適用できるよう提示のみ）

v1.39.0のpadding/gap詰めだけで実機の○△はみ出しが解消しない場合に適用する。

## 変更対象・行番号（v1.39.0時点、index.html）

1. 基本（縦向き・1000px未満）: `.sub-input-list` ブロック
   ```css
   .sub-input-list {
       display: grid; grid-template-columns: repeat(4, 1fr) !important;
       ...
   }
   ```
   `repeat(4, 1fr)` → `repeat(3, 1fr)`

2. 横向き1000px以上のオーバーライド: `@media (orientation: landscape) and (min-width: 1000px) { .sub-input-list { ... } }`
   ```css
   grid-template-columns: repeat(6, 1fr) !important;
   ```
   `repeat(6, 1fr)` → `repeat(5, 1fr)`

`grep -n "grid-template-columns: repeat(4, 1fr) !important;\|grid-template-columns: repeat(6, 1fr) !important;" index.html` の `.sub-input-list` 該当2箇所のみを変更する（他画面の同じ値のgrid-template-columnsは触らない）。

## 想定効果（v1.39.0のpadding/gap詰め後の実測値ベース）

| | 現行(v1.39.0) | 列数削減後(概算) |
|---|---|---|
| タイル幅・横1180×820（6列→5列） | 171.66px | 約210px（+38px） |
| タイル幅・縦820×1180（4列→3列） | 167.0px | 約222px（+55px） |

## 適用時の注意

- 1画面に一望できる児童数は減る（横6→5列、縦4→3列）。内側スクロール化済みのため一覧性より押しやすさを優先する今回の方針と整合。
- `.sub-input-list`のgrid-template-columnsのみの変更で、行の高さ(`.sub-input-row`のmin-height:100px)やタイル内padding/gapは変更不要（v1.39.0の詰めをそのまま維持）。
- 適用後はtests/sub-tile-fit.test.jsを再実行し、値のずれがないことを確認する。
