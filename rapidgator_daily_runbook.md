# Rapidgator日次差分収集 運用手順

## 目的

`xxx_tl002_rapidgator_raw` に登録済みの全Rapidgatorフォルダを毎日確認し、未登録のファイルURLだけを同テーブルへ追加する。

2026-09-23時点の対象は7フォルダである。対象一覧はDBから読み込むため、フォルダの追加や削除をコードへ重複記載しない。安全確認として、件数が環境変数 `RAPIDGATOR_DAILY_EXPECTED_FOLDERS` と一致しない場合は処理を停止する。既定値は `7`。

## 使用ファイル

- 日次統括: `project_scripts/rapidgator_daily_delta.js`
- フォルダ収集: `rapidgator_folder_collector2.js`
- 差分登録: `project_scripts/import_rapidgator_delta.js`
- DB状態監査: `project_scripts/audit_rapidgator_daily_state.js`
- 単体テスト: `project_scripts/rapidgator_daily_delta.test.js`

## 処理の流れ

1. PostgreSQLのadvisory lockを取得し、日次処理の重複起動を防ぐ。
2. `xxx_tl002_rapidgator_raw` から登録済みフォルダを取得する。
3. 各フォルダの1ページ目から総オブジェクト数と最終ページを確認する。
4. 末尾から過去へ進み、ファイルURLがすべてDB登録済みのページが2ページ連続した位置を境界にする。
5. 未登録URLが見つかったフォルダだけ、境界から最終ページまでをCSVへ収集する。
6. CSVの完了状態、対象フォルダ、ページ範囲、行数を検証してDry-runする。
7. 実行モードではトランザクション内で差分を再確認し、未登録URLだけを追加する。
8. 登録後に同じCSVを再度Dry-runし、`new_urls = 0` を確認する。

既知境界が50ページ以内に見つからない場合は停止する。取得は最大3回まで再試行し、HTMLの総件数、ページ行数、明示的な最終ページリンクが一致しない場合も停止する。

## 手動Dry-run

```powershell
node project_scripts\rapidgator_daily_delta.js
```

DBへの書き込みは行わない。未登録URLがある場合は、フォルダ別CSVと差分CSVを作成する。

## 手動実行

```powershell
$env:RAPIDGATOR_DAILY_EXECUTE = "YES"
$env:RAPIDGATOR_DAILY_CONFIRM_DB_WRITE = "YES"
node project_scripts\rapidgator_daily_delta.js
Remove-Item Env:RAPIDGATOR_DAILY_EXECUTE
Remove-Item Env:RAPIDGATOR_DAILY_CONFIRM_DB_WRITE
```

実行モードは、収集、Dry-run、差分登録、登録後の0件確認までを1回で行う。

## 結果の確認

実行単位の結果は次に出力する。

```text
tmp/rapidgator_daily/rapidgator_daily_YYYYMMDDHHMMSS/status.json
```

主な状態は次のとおり。

- `completed`: 全フォルダの確認が完了した。
- `no_change`: そのフォルダに未登録URLはなかった。
- `applied`: 未登録URLをDBへ追加し、登録後確認まで完了した。
- `dry_run_ready`: Dry-runで未登録URLが見つかった。
- `failed`: 取得、検証、収集、DB処理のいずれかで失敗した。
- `skipped_locked`: 別の日次処理が実行中だったため開始しなかった。

DB全体のフォルダ別件数は次で確認する。

```powershell
node project_scripts\audit_rapidgator_daily_state.js
```

## PM2登録

日次ジョブは毎日04:30に実行する。

- PM2名: `daily-0430-rapidgator-delta`
- 設定ファイル: `ecosystem.rapidgator-daily.config.js`
- cron: `30 4 * * *`
- 次回実行: 2026-09-24 04:30（JST）

PM2からは次の環境変数を渡す。

```text
RAPIDGATOR_DAILY_EXECUTE=YES
RAPIDGATOR_DAILY_CONFIRM_DB_WRITE=YES
RAPIDGATOR_DAILY_EXPECTED_FOLDERS=7
```

登録と確認は次のコマンドで行う。

```powershell
pm2 start ecosystem.rapidgator-daily.config.js
pm2 describe daily-0430-rapidgator-delta
pm2 logs daily-0430-rapidgator-delta --lines 100 --nostream
```

2026-09-23の登録時は、一回限りの `once-fc2-javarchive-backfill` が実行中だった。通常の `pm2 save` で一回処理まで再起動対象へ入れないよう、次の専用スクリプトで既存のPM2復元ファイルへRapidgator日次ジョブだけを追加した。

```powershell
node project_scripts\save_rapidgator_pm2_process.js
node project_scripts\save_rapidgator_pm2_process.js --execute
```

実行時は既存の `dump.pm2` を時刻付きでバックアップし、対象名、cron、スクリプトパス、DB書き込み確認ゲート、7フォルダ設定を検証する。`once-fc2-javarchive-backfill` が既存の復元ファイルに含まれている場合は停止する。

## 2026-09-23 初回確認

- 全7フォルダを走査した。
- 初回Dry-runで252 URLを検出し、登録後の再Dry-runで0件を確認した。
- 完成版ランナーの再試験中に追加された3 URLも検出・登録した。
- 当日の追加は合計255 URL。
- 登録後の `xxx_tl002_rapidgator_raw` は1,043,189行。
- `daily-0430-rapidgator-delta` をPM2へ登録し、`cron restart = 30 4 * * *` を確認した。
- PM2復元ファイルは保存前19件、保存後20件で、`once-fc2-javarchive-backfill` が含まれないことを再確認した。
- DBスキーマ変更、既存行の更新、既存行の削除は行っていない。
