# Phase 2 DB / Code Reconciliation

このファイルは、`phase2_code_requirements.md` と `planned_sql.md` を突き合わせた結果を記録する。
ユーザー方針に沿うものは採用し、確認が必要なものだけ末尾に残す。

## Result

Phase 2 のコード側要件と、現在のDB案はおおむね整合している。
ただし、未照合ファイルを `xxx_TM002_owned_files` に入れない方針が確定しているため、未照合専用テーブルを正式に追加する必要がある。

## Confirmed Compatible Items

### Folder Paths

フォルダパスはDBではなくコード側変数で管理する。
そのため、手動DLフォルダ、一時処理フォルダ、最終保存先、未照合、保留、エラー、CSVログ保存先はDBテーブル化しない。

必要なら将来、設定ファイルまたは設定テーブルを検討するが、初期段階ではコード側で扱う。

### Dry-run

既存の `xxx_TL001_file_process_logs.status = 'dry_run'` 方針で対応できる。
Dry-runでは `old_path`, `new_path`, `old_file_name`, `new_file_name`, `action`, `status`, `source`, `matched_by`, `note` を使い、予定結果を残せる。

Dry-run CSVも同じ列構成で出せるため、追加カラムは不要。

### Product Id Matching

商品番号はDB上では `text` として扱うため、6桁、7桁の両方に対応できる。
抽出ルールはコード側で決める。

DB照合先は `xxx_VQ001_moviemaster_unique` でよい。
初期段階ではタイトル類似照合を行わないため、DB側に類似検索用の追加設計は不要。

### Owned Files

`xxx_TM002_owned_files` はクリーンな所有ファイル専用テーブルとして使える。

コード側要件と一致している点:

- `product_id` は NOT NULL
- `current_path` は NOT NULL
- `current_file_name` は NOT NULL
- 作品タイトルや seller 名は重複保存しない
- `file_size` と `file_modified_at` を保持できる
- `source` と `matched_by` で登録元と照合方法を追跡できる
- `is_duplicate_candidate`, `duplicate_label`, `duplicate_group_key` で重複候補を管理できる

### Logs

`xxx_TL001_file_process_logs` はコード側要件に合っている。

コード側要件と一致している点:

- DBログとCSVログを同じ形にできる
- `run_id` を持てる
- 1ファイルごとのログを残せる
- DB登録前、DB登録後、エラー、Dry-runを表現できる
- DB書き込みに失敗してもCSVログで追跡できる

## Needed DB Additions

### `xxx_TM005_unmatched_files`

未照合ファイルは `xxx_TM002_owned_files` に入れない方針のため、別テーブルを追加する。

役割:

- 商品番号が抽出できないファイル
- 商品番号は抽出できたがDB照合できないファイル
- 未照合フォルダへ移動したファイル
- 保留または手動確認が必要なファイル
- 後で救済処理に回すファイル

想定カラム:

- `id`
- `run_id`
- `detected_path`
- `staged_path`
- `current_path`
- `detected_file_name`
- `current_file_name`
- `extracted_product_id`
- `reason`
- `status`
- `source`
- `file_size`
- `file_modified_at`
- `note`
- `created_at`
- `updated_at`

初期 status 候補:

- `unmatched`
- `pending`
- `resolved`
- `error`

## Planned SQL Impact

`planned_sql.md` に以下を追加する。

- `xxx_TM005_unmatched_files` の CREATE TABLE
- `xxx_TM005_unmatched_files` の基本インデックス
- 未照合ファイルは `xxx_TM002_owned_files` に入れない、という注意書き

## Confirmed Decisions

- 未照合テーブル名は `xxx_TM005_unmatched_files` とする。

番号は `TM002` が所有ファイル、`TM003` / `TM004` が seller 正規化案のため、未照合ファイルは `TM005` とする。
## 2026-05-09 初期移行実行結果

`testcsv` 由来の初期移行は、DB側で実行済み。

- 登録先: `public.xxx_tm002_owned_files`
- ログ登録先: `public.xxx_tl001_file_process_logs`
- `run_id`: `initial_import_legacy_testcsv_20260509`
- 登録元: `source = legacy_testcsv`
- 照合方法: `matched_by = testcsv_number_master`
- 登録件数: 6132件
- `current_path` 重複確認: 空

移行時の整理方針:

- `Moved+Renamed` かつ `xxx_vq001_moviemaster_unique` と商品番号で一致する行だけを、クリーンな所有ファイルとして登録した。
- 同一の正規化済み `current_path` が複数あるものは、最小の `testcsv.id` の行だけを採用した。
- `Moved+Renamed` だがマスターに一致しない683件は、`xxx_tm002_owned_files` には入れず、後続の未照合・救済処理で扱う。
- `(1)` などの重複候補は自動削除せず、`is_duplicate_candidate` と関連カラムで後から人間が判断できるように保持する。

この結果により、Phase 2 のDB初期登録は成功扱いとする。次工程ではJS側から `.env` 経由でDB接続し、まず読み取り確認から進める。
