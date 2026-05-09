# Minimum Dry-run Trial

Goal 1 / Goal 3 の最小単位を検証するための試作スクリプト。

この段階では、実ファイル移動、リネーム、DB書き込みは行わない。
指定フォルダ内の `.mp4` を読み、商品番号抽出、マスター照合、予定リネーム名、予定移動先、予定DB登録先をCSVに出す。

## Files

- `minimum_dry_run.js`
  - 最小Dry-run本体。

## Safety

- 実ファイルは移動しない。
- 実ファイルはリネームしない。
- DBへ接続しない。
- DBへ書き込まない。
- `.mp4` 以外は対象外。
- 同名衝突は予定パス上で `(1)` などを付けて回避する。
- 未照合ファイルは `xxx_tm002_owned_files` ではなく `xxx_tm005_unmatched_files` 予定として出す。

DBモードでも、DBには読み取り専用SELECTだけを行う。INSERT、UPDATE、DELETEは行わない。

## Trial Master CSV

DB View `xxx_vq001_moviemaster_unique` の代替として、試作用CSVを読む。

必要カラム:

```csv
product_id,title,seller_name
1234567,Sample Title,Sample Seller
```

将来DB接続を入れる場合は、このCSV読み込み部分を `xxx_vq001_moviemaster_unique` への読み取り専用SELECTに置き換える。

## Usage

サンプルワークスペースを作成して、そのままDry-runする。

```powershell
node project_scripts\minimum_dry_run\minimum_dry_run.js --init-sample
```

実フォルダを指定してDry-runする。

```powershell
node project_scripts\minimum_dry_run\minimum_dry_run.js `
  --input "C:\path\to\download" `
  --master "C:\path\to\master_sample.csv" `
  --log-dir "C:\path\to\logs" `
  --final-base "C:\path\to\final" `
  --unmatched-dir "C:\path\to\unmatched" `
  --hold-dir "C:\path\to\hold"
```

件数を絞る。

```powershell
node project_scripts\minimum_dry_run\minimum_dry_run.js --limit 5
```

## Output CSV

`file_process_{run_id}.csv` を出力する。

主な列:

- `source_path`
- `detected_product_id`
- `candidate_product_ids`
- `match_status`
- `planned_file_name`
- `planned_final_path`
- `planned_unmatched_path`
- `planned_db_table`
- `planned_db_action`
- `status`
- `reason`

## Next

このDry-runで問題がなければ、次の設計へ進む。

1. PostgreSQL読み取り専用SELECTへの置き換え検討
2. 実移動なしのまま、既存DB登録済みファイル除外ルールを追加
3. 本実行用の移動処理を別スクリプトとして設計
## PostgreSQL read-only master matching

DB作成後は、試作用CSVの代わりに `xxx_vq001_moviemaster_unique` を読み取り専用で参照できる。

```powershell
node project_scripts\minimum_dry_run\minimum_dry_run.js `
  --master-source db `
  --input "C:\path\to\download" `
  --log-dir "C:\path\to\logs" `
  --final-base "C:\path\to\final" `
  --unmatched-dir "C:\path\to\unmatched" `
  --hold-dir "C:\path\to\hold" `
  --limit 5
```

- `.env` はプロジェクト直下の `.env` を読む。
- DBには書き込まない。
- ファイル移動、リネームもしない。
- 指定フォルダ内の `.mp4` から抽出できた商品番号だけを `xxx_vq001_moviemaster_unique` に問い合わせる。
- seller名はこのViewに持たせない方針のため、現段階の予定フォルダ名は `未名称` になる場合がある。
