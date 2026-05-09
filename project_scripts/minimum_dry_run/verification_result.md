# Minimum Dry-run 検証結果

## 実施日

2026-05-09

## 検証コマンド

```powershell
node --check project_scripts\minimum_dry_run\minimum_dry_run.js
rg -n "console\.log|renameSync|rename\(|unlink|rm\(|Remove-Item|copyFile|INSERT|UPDATE|DELETE|DROP|TRUNCATE" project_scripts\minimum_dry_run
node project_scripts\minimum_dry_run\minimum_dry_run.js --init-sample
Get-Content -LiteralPath "project_scripts\minimum_dry_run\sample_workspace\logs\file_process_20260509_104426_minimum_dry_run.csv" -Encoding UTF8 -TotalCount 4
```

## 結果

- `node --check` は成功。
- 実ファイル移動、削除、コピー、DB更新、デバッグ用 `console.log` に該当する文字列は検出なし。
- サンプル Dry-run は成功。
- サンプル入力4件の内訳は、照合成功2件、未照合1件、保留1件。
- CSVログはUTF-8で正常に出力され、`未名称` も正しく確認できた。

## 出力CSV

```text
project_scripts\minimum_dry_run\sample_workspace\logs\file_process_20260509_104426_minimum_dry_run.csv
```

## 注意

- このJSは最小トライ用であり、実ファイルの移動、リネーム、DB書き込みは行わない。
- DB照合は本接続ではなく、試験用CSVを `xxx_VQ001_moviemaster_unique` 相当として読む。
- ダウンロード完了待ち、既存所有ファイル除外、実移動後のDB登録は次フェーズで実装する。
