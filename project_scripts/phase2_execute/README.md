# Phase2 File Pipeline

`minimum_dry_run` の次フェーズ用スクリプトです。  
`dry-run` と `execute` の2モードで、`.mp4` の商品番号照合、移動先決定、CSVログ、DB登録を扱います。

## Scope

- `.mp4` のみ対象
- 商品番号抽出は 6桁/7桁
- マスター照合は `product_id` のみ
- `dry-run` は移動/DB書き込みなし
- `execute` は移動とDB書き込みを実施

## Safety

- `EXDEV` (クロスドライブ移動) はこの版では安全のためブロック
- 移動失敗時は `status=error` でCSVに記録
- `execute` でDB登録失敗時は `manual_recovery_{run_id}.sql` を自動生成
- `execute` のDB書き込みは 1ファイル単位で `BEGIN/COMMIT/ROLLBACK` 実行
- DB接続情報はプロジェクトルート `.env` から読み込み

## Commands

```powershell
node project_scripts\phase2_execute\phase2_file_pipeline.js --mode dry-run --master-source db --input "C:\path\to\input"
```

```powershell
node project_scripts\phase2_execute\phase2_file_pipeline.js --mode execute --master-source db --input "C:\path\to\input"
```

```powershell
# execute は明示確認が必要
node project_scripts\phase2_execute\phase2_file_pipeline.js --mode execute --confirm-execute YES --master-source db --input "C:\path\to\input"
```

## Main Options

- `--mode dry-run|execute`
- `--confirm-execute YES` (`execute` 時に必須)
- `--input <folder>`
- `--master-source db|csv`
- `--master <csv>` (`master-source=csv` のとき)
- `--db-view <schema.view>`
- `--log-dir <folder>`
- `--final-base <folder>`
- `--unmatched-dir <folder>`
- `--hold-dir <folder>`
- `--error-dir <folder>`
- `--limit <n>`
