# classroom-app プロジェクトメモ

## バージョンが更新されない時の診断順序

1. まず画面に表示されているバージョン文字列の「出所」を grep で特定する
   （sw.js の CACHE_VERSION とは別系統のことがある）
   ```
   grep -rn "v1\." . --include="*.js" --include="*.html"
   ```

2. 次に curl でエッジ配信を確認:
   ```
   curl -s "URL/sw.js?nocache=$(date +%s)" | grep VERSION
   ```

3. エッジが新しいのに画面が古い → 表示文字列の更新漏れ or キャッシュ層を疑う
   （いきなり install 失敗・SW 居座りを疑わない）

4. SW ライフサイクル（install/activate）の調査は、上記 1〜3 で原因が出なかった時のみ
