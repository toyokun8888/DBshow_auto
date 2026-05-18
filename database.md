# Database

このファイルには、データベース、CSV、保存データ、スキーマ、入出力形式を記録します。

## Overview

指定された5つのJSファイルから確認できる範囲では、PostgreSQLへ直接接続する処理は見当たらない。

既存コードは、FC2CMから取得した情報をCSVへ出力し、そのCSVを後続のDB投入や照合に使う前提だった可能性が高い。

そのため、このファイルでは現時点で確認できるCSV構造と、将来DBに必要になりそうなテーブル・カラムを分けて記録する。

## Data Sources

### 外部取得元

- `https://fc2cm.com/?p=作品番号`
- `https://fc2cm.com/?cl=all`
- `https://fc2cm.com/?cll=販売者ID`

### ローカルファイル

- `.mp4` 実体ファイル
- リネーム・移動ログCSV
- FC2CMから取得したマスターCSV
- FC2CMから取得したタグCSV
- 販売者ID・販売者名CSV
- エラーCSV
- 進捗CSV

## 確認できたCSV構造

### `fc2_db_builder.js` の `master_*.csv`

カラム:

- `product_id`
- `seller`
- `sale_date`
- `title`

用途:

- 作品マスターの元データ。
- 作品ID、販売者、販売日、タイトルを保持する。

### `fc2_db_builder.js` の `tags_*.csv`

カラム:

- `product_id`
- `tag`

用途:

- 作品ごとのタグを保持する。
- 1作品に複数タグがある場合、複数行になる。

### `fc2_seller_collector.js` の `master_*.csv`

カラム:

- `product_id`
- `title`
- `seller_id`

用途:

- 販売者IDを軸に取得した作品一覧。
- `fc2_db_builder.js` のマスターCSVと統合・補完できる可能性がある。

### `fc2_celler_name_collector.js` の `sellers_*.csv`

カラム:

- `id`
- `seller_id`
- `index_path`
- `registered_at`

用途:

- 販売者IDの一覧。
- `seller_id` は重複排除される。

### `fc2_celler_name_collector.js` の `seller_names_*.csv`

カラム:

- `id`
- `seller_id`
- `seller_name`
- `index_path`
- `registered_at`

用途:

- 販売者IDと販売者名の対応表。
- 同一 `seller_id` に複数の `seller_name` が紐づく可能性を許容している。

### ファイル移動ログCSV

対象スクリプト:

- `file_move_and_csv_with_fc2cm.js`
- `file_move_and_csv_with_fc2cm_title_based.js`

カラム:

- `OldPath`
- `NewPath`
- `OldFileName`
- `NewFileName`
- `Number`
- `URL`
- `Title`
- `Seller`
- `Action`

用途:

- ファイル移動前後のパスとファイル名を記録する。
- 作品番号、取得URL、タイトル、販売者、処理結果を記録する。
- 将来の所有ファイルDB登録・紐づけ処理の元データとして使える。

### エラーCSV

確認できたカラム:

- `url` / `number`
- `tried_at`
- `reason`

用途:

- スクレイピング失敗、ページ取得失敗、データ未取得などの記録。

### 進捗CSV

確認できたカラム:

- `index_path`
- `processed_at`
- `count` または `seller_count`
- `status`
- `note`

用途:

- 長時間スクレイピング処理の再開・確認用。

## DBとして必要になりそうな構造

以下は既存コードからの推定であり、実DBの確認が必要。

### 作品マスター

候補カラム:

- `product_id`
- `title`
- `seller_id`
- `seller_name`
- `sale_date`
- `created_at`
- `updated_at`

役割:

- 約400万件のマスターデータを保持する中心テーブル。

### タグ

候補カラム:

- `product_id`
- `tag`

役割:

- 作品とタグの対応を保持する。

### 販売者

候補カラム:

- `seller_id`
- `seller_name`
- `index_path`
- `registered_at`

役割:

- 販売者IDと販売者名を管理する。
- 同一販売者IDに複数名称がある場合の扱いを決める必要がある。

### 所有ファイル

候補カラム:

- `id`
- `product_id`
- `old_path`
- `current_path`
- `old_file_name`
- `current_file_name`
- `file_ext`
- `branch`
- `action`
- `registered_at`
- `updated_at`

役割:

- 実体 `.mp4` ファイルの現在位置を管理する。
- マスターDBと所有ファイルを紐づける。
- Goal 1 / Goal 3 で最も重要になる。

### ファイル処理ログ

候補カラム:

- `id`
- `product_id`
- `old_path`
- `new_path`
- `old_file_name`
- `new_file_name`
- `action`
- `error_message`
- `processed_at`

役割:

- ファイル移動、リネーム、失敗、再試行の履歴を保持する。

### サムネイル管理

候補カラム:

- `id`
- `product_id`
- `thumbnail_file_name`
- `thumbnail_path`
- `source_url`
- `status`
- `priority`
- `attempt_count`
- `last_error`
- `last_tried_at`
- `created_at`
- `updated_at`

役割:

- Goal 4 のサムネイル収集と進捗管理を行う。

## 既存コードからわかったこと

- 既存CSV上では作品番号は `product_id` または `Number` として扱われている。
- ファイル名から抽出される作品番号は7桁前提の処理が多い。
- 販売者は、表示名としての `seller` / `Seller` と、識別子としての `seller_id` が別に存在する。
- タグは作品IDに対して複数行で表現される。
- 所有ファイルの移動履歴は `OldPath` / `NewPath` で表現されている。
- 未分類という概念があり、販売者やタイトルが取れない場合の退避先として使われている。
- 進捗管理はCSVで行われており、DBテーブル化の候補になる。

## 未確定事項

- 現在のPostgreSQL接続情報。
- 実DBのテーブル一覧。確認済み: `master`, `master_import`, `master_raw`, `master_title_fix`, `seller_names`, `sellers`, `testcsv`。
- 実DBのカラム一覧。
- 作品マスターの正式テーブル名。
- 作品IDの正式カラム名。
- 販売者IDと販売者名の正式な管理方法。
- 所有ファイルテーブルの正式名称。
- 所有ファイルと作品マスターのリレーション。
- 実体ファイルのフルパスを保存しているカラム名。
- 未紐づけファイルを判定するSQL条件。
- カテゴリー分けルールを保存しているテーブル・カラム。
- カテゴリー別保存先フォルダの決定ルール。
- 既存CSVをDBへ取り込んだ履歴があるか。
- 日次差分更新でどの番号範囲、またはどの条件を取得対象にするか。
- 作品削除・非公開・取得失敗時のDB上の扱い。
- サムネイル管理テーブルを新規作成してよいか。
- サムネイル画像の保存先パスをどの形式でDBに保存するか。

## Notes

- DBの破壊的変更は禁止。`DROP`、`TRUNCATE`、既存カラム削除は行わない。
- 実DB確認時は、まず読み取り専用の確認から始める。
- 新しいテーブルやカラムが必要な場合は、事前に設計を提示して承認を得る。
- Goal 1 / Goal 3 の実装では、移動後のフルパスをDBに保存する設計が必須。

## 実DB確認メモ

### 確認済みテーブル

- `master`
- `master_import`
- `master_raw`
- `master_title_fix`
- `seller_names`
- `sellers`
- `testcsv`

### 確認済みView

- `fc2dataview`
- `master_full_view`
- `master_full_view_1`
- `master_full_view_2`
- `master_full_view_3`
- `master_full_view_4`
- `master_full_view_5`
- `master_full_view_6`
- `master_full_view_path_1`
- `master_full_view_path_2`
- `master_full_view_path_3`
- `master_full_view_path_4`
- `master_full_view_path_5`
- `master_full_view_path_6`
- `master_full_view_row`
- `master_owned_view`
- `master_view`

確認メモ:

- `testcsv` はViewではなくテーブルだった。

### 現時点の推定

- `master`: 作品マスター本体の可能性が高い。
- `master_import`: CSV等から取り込むための中間テーブル、またはインポート履歴用テーブルの可能性がある。
- `master_raw`: 加工前の生データ保持テーブルの可能性がある。
- `master_title_fix`: タイトル補正、表記ゆれ修正、手動修正用テーブルの可能性がある。
- `sellers`: 販売者IDの正規テーブルの可能性がある。
- `seller_names`: 販売者IDと販売者名の対応、別名管理テーブルの可能性がある。
- `testcsv`: 検証・一時用途の可能性がある。テーブルとViewの両方に同名があるため、スキーマ確認が必要。

### 確認済みView構造

#### `master_view`

定義の要点:

- `master` をベースにする。
- `master_title_fix` を `product_id` でLEFT JOINする。
- タイトルは `COALESCE(master_title_fix.title, master.title)` で補正後タイトルを優先する。

役割:

- タイトル補正を反映した作品マスター参照用View。
- 今後の実装では、単純な `master` ではなく `master_view` を参照したほうが、補正済みタイトルを使える可能性が高い。

注意:

- `master_view` は `product_id` 単位で一意ではない。
- 原因は `master_title_fix` に同一 `product_id` が複数行存在するため。
- `master` 本体は `product_id` が1,700,107件すべて非NULLかつ一意。
- 新プロジェクトで照合に使う場合、既存 `master_view` をそのまま使わず、`master_title_fix` を一意化した新規Viewを作る必要がある。

#### `fc2dataview`

定義の要点:

- `testcsv` から `action = 'Moved+Renamed'` の行だけを抽出する。
- 表示カラムは `number`, `title`, `seller`, `pathid`, `newfilename`, `action`。

役割:

- 過去ログのうち、移動とリネームに成功した所有ファイルだけを見るためのView。

#### `master_full_view`

定義の要点:

- `master_view` をベースにする。
- `testcsv` のうち `action = 'Moved+Renamed'` の行を、`master_view.product_id = testcsv.number` でLEFT JOINする。
- `seller_names` を `master_view.seller_id = seller_names.seller_id` でLEFT JOINする。
- 表示カラムは `product_id`, `title`, `seller_id`, `owned_title`, `pathid`, `seller_name`。

役割:

- 補正済みマスター、所有済みログ、販売者名をまとめて見るための中心的な参照View。
- `owned_title` がNULLでなければ所有済みと判断していた可能性がある。
- `pathid` は所有ファイルのドライブまたは保存場所分類を表している可能性がある。

#### `master_owned_view`

定義の要点:

- `master_full_view` と同様の結合を行う。
- `t.pathid IS NOT NULL` の条件で所有済みだけを抽出する。

役割:

- 所有済み作品だけを一覧するためのView。
- Goal 4 のサムネイル優先収集対象として活用できる可能性が高い。

確認メモ:

- `COUNT(*)` は28923件。
- ただし、この件数は実際の所有ファイル数ではなく、`seller_names` に同一 `seller_id` の複数名称があることでJOIN結果が増幅されている。
- 実際の過去ログ上の成功件数は `testcsv.action = 'Moved+Renamed'` の7112件。
- 所有判定や件数集計にこのViewをそのまま使うと重複を含むため注意が必要。
- 所有済み作品の一覧には便利だが、件数や一意な所有ファイル管理には専用テーブル、または `product_id` / ファイル単位での重複排除が必要。

#### `master_full_view_row`

定義の要点:

- `master_full_view` と同等の結合結果に `row_number() over (order by product_id)` を付ける。

役割:

- 大量データを行番号で分割して見るための基礎View。

#### `master_full_view_1` から `master_full_view_6`

定義の要点:

- `master_full_view_row` を100万件単位の `rn` 範囲で分割する。
- `_1` は1から1,000,000。
- `_2` は1,000,001から2,000,000。
- 以降、最大6,000,000まで。

役割:

- pgAdminや閲覧環境で大量Viewを分割して扱うためのView。
- `goals.md` の約400万件規模の想定と整合する設計が残っている。

#### `master_full_view_path_1` から `master_full_view_path_6`

定義の要点:

- `master_full_view_1` から `master_full_view_6` と同じ範囲分割に見える。

役割:

- 名前からはパス確認用Viewの可能性があるが、現在の定義では `master_full_view_*` と同等に見える。

### Viewからわかったこと

- 日常的な参照の中心は `master_view` と `master_full_view` 系だった可能性が高い。
- `master_title_fix` はタイトル補正用として実際に使われている。
- 所有判定は、過去ログ `testcsv` の `Moved+Renamed` かつ `pathid IS NOT NULL` を使っていた。
- 現状の所有情報は、正式な所有ファイルテーブルではなく `testcsv` の成功ログをViewで結合して表現している。
- `master_full_view_row` と分割Viewは、400万件以上の大規模マスターを想定した閲覧対策だった可能性がある。
- 今後の正式設計では、`testcsv` 相当のログではなく、所有ファイルの現在状態を管理する専用テーブルを作るほうが自然。
- `seller_names` は1つの `seller_id` に複数の `seller_name` を持つため、`master_full_view` / `master_owned_view` は同じ作品が複数行に増える。
- UI表示や検索では複数販売者名が便利な場合があるが、所有ファイル数や作品数の集計には重複排除が必要。
- `master_view` も `master_title_fix` の重複により行が増えるため、照合用途では危険。
- 新規Viewとして、`xxx_VQ001_moviemaster_unique` のような一意化済みマスター参照Viewが必要。

### 次に確認すること

- 各テーブルのカラム一覧。
- 主キー。
- 外部キー。
- インデックス。
- `master` と `sellers` / `seller_names` の関係。
- 所有ファイル、保存パス、カテゴリールールを保持しているテーブルが存在するか。
- `testcsv` Viewの定義。

### 確認済みカラム構造

#### `master`

作品マスター本体と思われる。

カラム:

- `product_id` text nullable
- `title` text nullable
- `seller_id` text nullable

制約:

- `master_pid_unique`: `product_id` にUNIQUE制約。

確認メモ:

- 主キーは未設定。
- `product_id` は一意だが nullable になっている。
- `seller_id` に外部キー制約は確認されていない。
- 作品マスターの中心テーブルとして扱う候補。

#### `master_import`

マスター取り込み用の中間テーブルと思われる。

カラム:

- `product_id` text nullable
- `title` text nullable
- `seller_id` text nullable

制約:

- 今回取得結果では主キー・UNIQUE・外部キーは確認されていない。

確認メモ:

- `master` と同じカラム構成。
- CSV等の一時取り込み、差分確認、重複確認に使っていた可能性がある。

#### `master_raw`

加工前の生データ保持テーブルと思われる。

カラム:

- `id` bigint not null default `nextval('master_raw_id_seq'::regclass)`
- `line` text nullable

制約:

- `master_raw_pkey`: `id` 主キー。

確認メモ:

- CSVの1行、または取得した生行をそのまま保存する用途の可能性がある。

#### `master_title_fix`

タイトル補正用、または修正版マスター用テーブルと思われる。

カラム:

- `product_id` text nullable
- `title` text nullable
- `seller_id` text nullable

制約:

- 今回取得結果では主キー・UNIQUE・外部キーは確認されていない。

確認メモ:

- `master` と同じカラム構成。
- タイトル修正後の値、または補正対象の一時置き場の可能性がある。

#### `sellers`

販売者IDの正規テーブルと思われる。

カラム:

- `id` integer not null default `nextval('sellers_id_seq'::regclass)`
- `seller_id` text not null
- `index_path` text nullable
- `registered_at` timestamp with time zone nullable

制約:

- `sellers_pkey`: `id` 主キー。
- `sellers_seller_id_key`: `seller_id` UNIQUE制約。

確認メモ:

- `seller_id` が販売者の一意キー。
- `seller_names.seller_id` から参照されている。

#### `seller_names`

販売者IDと販売者名の対応テーブルと思われる。

カラム:

- `id` integer not null default `nextval('seller_names_id_seq'::regclass)`
- `seller_id` text not null
- `seller_name` text nullable
- `index_path` text nullable
- `registered_at` timestamp with time zone nullable

制約:

- `seller_names_pkey`: `id` 主キー。
- `seller_names_seller_id_fkey`: `seller_id` が `sellers.seller_id` を参照。

確認メモ:

- 同一 `seller_id` に複数の `seller_name` が紐づく設計。
- 販売者名の表記ゆれ、別名、取得元違いを保持できる。

#### `testcsv`

過去のファイル移動CSVログをDB化したテーブル、または検証用テーブルと思われる。

カラム:

- `id` integer not null
- `oldpath` character varying nullable
- `newpath` character varying nullable
- `oldfilename` character varying nullable
- `newfilename` character varying nullable
- `number` character varying nullable
- `url` character varying nullable
- `title` character varying nullable
- `seller` character varying nullable
- `action` character varying nullable
- `pathid` character varying nullable

制約:

- `testcsv_pkey`: `id` 主キー。

確認メモ:

- 既存JSのファイル移動ログCSVに近い構造。
- `oldpath` / `newpath` があるため、実体ファイル保存場所の履歴確認に使える可能性がある。
- `number` は作品番号に相当する可能性がある。
- `pathid` の役割は未確定。
- テーブルとViewの両方に `testcsv` があるため、スキーマまたは実体の確認が必要。
- 件数は9365件。
- サンプルを見る限り、過去に `.mp4` を移動・リネームした結果ログが入っている。
- `action` は `Moved` または `Moved+Renamed` が確認できる。
- `title` / `seller` が `なし` の行は、DBまたは外部取得で照合できなかった未分類ファイルと考えられる。
- `newpath` には `K:all_fc2\...` のようにドライブ直後の `\` が欠けて見える値があるため、実体パスとして使う場合は要注意。
- 同じ `number` に対して枝番付きファイルが複数存在する例がある。例: `2843783_1`, `2843783_2`, `2843783_3`。
- 同じ `number` でも一部だけ未分類、一部だけリネーム成功している例がある。例: `4352000-01` は未分類、`4352000-02` はリネーム成功。

### 現時点で不足している可能性が高いDB要素

Goal 1 / Goal 3 に必要な以下の正式テーブルは、今回の一覧からは明確に確認できていない。

- 所有ファイルを管理する正式テーブル。
- 現在の実体ファイルフルパスを保持する正式カラム。
- ファイル処理履歴を保持する正式テーブル。
- カテゴリー分けルールを保持する正式テーブル。
- サムネイル管理テーブル。
- 欲しいリスト、優先収集リストを保持するテーブル。

`testcsv` が所有ファイル管理の原型である可能性はあるが、名称と構造からは検証・取り込みログ用途に見えるため、正式用途の確認が必要。

### 確認済み件数

- `master`: 1,700,107件
- `master_import`: 1,151,782件
- `master_raw`: 1,122,984件
- `master_title_fix`: 1,122,983件
- `sellers`: 31,139件
- `seller_names`: 36,811件
- `testcsv`: 9,365件
- `master_owned_view`: 28,923件。ただし販売者名JOINによる重複増幅を含む。
- `testcsv.action = 'Moved+Renamed'`: 7,112件。
- `testcsv.action = 'Moved'`: 2,253件。
- `master.product_id`: 1,700,107件、NULL 0件、DISTINCT 1,700,107件。
- `Moved+Renamed` のうち、`master` と照合できる初期移行安全対象: 6,429件。
- `Moved+Renamed` だが、`master` と照合できない保留対象: 683件。

開発中の前提:

- このプロジェクト開発中は、DBのレコード数が増えないように停止されている。
- したがって、上記件数は開発中の目安・検証指標として扱える。
- ただし、件数を厳密な仕様として固定しすぎない。実装の柔軟性と開発速度を優先する。

### 件数から見えること

- 現在の `master` は約170万件で、`goals.md` にある約400万件とは差がある。別DB、別テーブル、未投入データ、または今後投入予定データがある可能性がある。
- `master_import` / `master_raw` / `master_title_fix` は近い件数であり、一連の取り込み・加工・補正処理の流れを表している可能性がある。
- `seller_names` は `sellers` より件数が多く、同一 `seller_id` に複数名称がある設計と整合する。
- `testcsv` は所有済みファイルの一部ログと考えられるが、現在所有している数万件すべてを表すには件数が少ない可能性がある。
- `master_owned_view` は所有済み抽出Viewだが、販売者名の別名分だけ行が増えるため、所有件数の正確なカウントには向かない。
- 過去ログ上、リネーム成功した所有ファイル候補は7112件、未分類移動のみは2253件。

### 現時点のDB設計上の注意

- `seller_names` を直接JOINすると、作品1件が複数行になる。
- `master_view` とJOINした場合も、件数が増幅するケースが確認された。`master_title_fix` など補正テーブル側に `product_id` 重複がある可能性がある。
- 所有ファイルの一意管理には、`testcsv.id` のようなファイルログ単位、または将来作る所有ファイルテーブルの主キーが必要。
- 作品単位の所有判定では、同一 `product_id` に複数ファイルや枝番が存在することを許容する必要がある。
- `Moved` は未分類移動であり、所有ファイルではあるがマスター紐づけ成功とは限らない。
- `Moved+Renamed` はマスター照合・タイトル取得・販売者取得が成功した可能性が高いが、過去ログなので現在の実体ファイル存在確認は別途必要。

### 所有ファイルと作品マスターの関係

確認結果:

- `Moved+Renamed`: 7112ファイル、5324作品。
- `Moved`: 2253ファイル、1434作品。
- 同一作品番号に複数ファイルが紐づくケースが多数ある。
- 例: `4592273` は13ファイル、`4592626` は12ファイル、`2648488` は11ファイル。

設計方針:

- `master.product_id` は作品単位の一意キー。
- 所有ファイルは実体ファイル単位で管理する。
- 作品マスターと所有ファイルは1対多の関係として設計する。
- 枝番、分割ファイル、複数画質、重複DLなどを許容する。
- `product_id` だけを所有ファイルテーブルの主キーにしてはいけない。
- 所有ファイルテーブルには、ファイル単位の主キーが必要。

所有ファイルテーブルに必要な考え方:

- 1つの `product_id` に複数の所有ファイル行を持てること。
- 枝番やパート番号を保存できること。
- 現在のフルパスをファイル単位で保存できること。
- 同一作品内でファイル名が重複しないように扱えること。
- 元パス、現在パス、処理履歴を追えること。

### 枝番・重複回避サフィックスの扱い

確認結果:

- 初期移行安全対象の `newfilename` では、以下の傾向がある。
- `no_suffix`: 4,984件。
- `part_suffix_-n_or__n`: 1,041件。
- `duplicate_suffix_(n)`: 404件。

用語:

- `part_suffix`: `-1`, `-2`, `_1`, `_2`, `-01`, `-02` など、ファイル名末尾にある分割・パート情報。
- `duplicate_suffix`: `(1)`, `(2)` など、同名ファイルを避けるために自動付与された可能性が高いサフィックス。

設計方針:

- `part_suffix` は作品内の分割ファイルや枝番として扱い、`owned_files.part_label` に保存する候補とする。
- `duplicate_suffix` は同名回避の結果であり、必ずしも作品の正式な枝番ではない。
- `duplicate_suffix` は `part_label` とは別に、必要なら `duplicate_label` または `file_name_suffix` として扱う。
- 初期設計では、`part_label` と `duplicate_label` を分けて考える。
- 実装時にカラムを増やしすぎる場合は、`part_label` と `note` で始める案も検討する。
- `(1)` などの `duplicate_suffix` は将来的なストレージ整理対象として扱う。
- ただし、重複候補ファイルは自動削除しない。
- どちらかのファイルが破損している可能性があるため、削除前に人間が確認する。
- 将来的には、ファイルサイズ、再生可否、ハッシュ、更新日時などを確認材料として保存・表示できる設計を検討する。

注意:

- `newfilename` だけを見ると、元からのパート番号と同名回避番号が混ざる。
- 正確なパート判定には `oldfilename` も参照する。
- `oldfilename` に `-1`, `_1`, `-01` などがあり、`newfilename` 末尾にも同様の番号がある場合は、パート番号として扱いやすい。
- `newfilename` にだけ `(1)` がある場合は、同名回避として扱う。
- 同名回避ファイルは「不要」と決めつけない。破損確認前の削除は禁止。

### 既存 `testcsv` と `master_view` の照合結果

確認結果:

- `Moved`: JOIN後2604行、マスター一致1498行、不一致1106行。
- `Moved+Renamed`: JOIN後8789行、マスター一致8106行、不一致683行。

注意:

- `testcsv` の実件数は9365件だが、上記JOIN後の合計は11393行になっている。
- これはJOIN先の `master_view` が `product_id` 単位で一意ではない可能性を示す。
- `master_view` は `master` と `master_title_fix` をJOINしているため、`master_title_fix.product_id` の重複が原因候補。
- 今後の照合SQLでは、JOIN先を必ず一意化してから使う必要がある。
- `master_view` をそのままJOINに使う前に、`product_id` 重複の実態確認が必要。
- 重複原因は `master_title_fix` と確認済み。
- `master_title_fix` には同一 `product_id` が14件存在するケースが多数ある。

見えた可能性:

- 過去に `Moved` だった未分類ファイルのうち、現在の `master_view` で照合できるものが多数ある。
- これはGoal 1の「未紐づけファイル救済」の重要な対象になる。

### 既存 `testcsv` のパス品質

確認結果:

- `pathid` は `D`, `E`, `G`, `I`, `K`, `L`, 空欄が確認された。
- `D` と `K` の `newpath` には、`D:all_fc2...` や `K:all_fc2...` のようにドライブ直後の `\` が欠けている形式が多い。
- `I` にも一部、同様の欠けがある。
- `E`, `G`, `L` は今回の条件ではドライブ直後欠けとしては検出されていない。
- 実機確認により、`K:\all_fc2` はExplorerで正しく開くが、`K:all_fc2` は期待する場所を開かないことを確認済み。

注意:

- 既存 `testcsv.newpath` をそのまま実体ファイルパスとして信用しない。
- 初期移行時にはパス正規化が必要。
- `pathid` と `newpath` から正しいドライブ付きフルパスを再構成するルールが必要。
- 実体ファイル存在確認を行ってから `owned_files.current_path` に入れるのが安全。

パス正規化方針:

- `D:all_fc2\...` のような形式は `D:\all_fc2\...` に正規化する。
- `K:all_fc2\...` のような形式は `K:\all_fc2\...` に正規化する。
- `I:all_fc2\...` のような形式も `I:\all_fc2\...` に正規化する。
- `E:\all_fc2\...`, `G:\all_fc2\...`, `L:\all_fc2\...` のように既に `:\` があるものはそのまま扱う。
- 空欄 `pathid` の行は、`newpath` を見てドライブを判定できる場合のみ正規化する。判定できない場合は保留にする。
- `owned_files.current_path` には、必ず `X:\...` 形式のWindows絶対パスを保存する。

### 新規マスター参照View案

目的:

- 既存 `master_view` の重複問題を避ける。
- `master.product_id` を一意な基準として使う。
- タイトル補正が必要な場合も、`master_title_fix` を一意化してからJOINする。

候補名:

- `xxx_VQ001_moviemaster_unique`

要件:

- 1 `product_id` につき必ず1行。
- `master.product_id` を基準にする。
- `master_title_fix` は `product_id` ごとに1行へ絞り込んでからJOINする。
- どの補正タイトルを採用するかのルールが必要。

補正タイトル採用ルール案:

- 案A: `master_title_fix` を `product_id` ごとにGROUP BYし、`MAX(title)` と `MAX(seller_id)` で一意化して使う。
- 案B: `master_title_fix` に将来 `updated_at` や優先順位カラムを追加して、最新または優先行を使う。
- 案C: 初期段階では `master_title_fix` を使わず、`master` 本体だけで一意Viewを作る。

現時点の推奨:

- 初期の照合処理では `master` 本体を基準にしつつ、タイトルは一意化した `master_title_fix` を優先してよい。
- 既存 `master_view` は直接使わず、新規 `xxx_VQ001_moviemaster_unique` で一意化する。
- 現時点では、`master_title_fix` の重複行は同一 `product_id` 内で `title` と `seller_id` が同一の重複である可能性が高い。
- そのため、`MAX(title)` / `MAX(seller_id)` による一意化で実用上問題ない可能性が高い。

確認済み:

- `master_title_fix` で重複している上位サンプルは、`row_count = 14` でも `distinct_title_count = 1`、`distinct_seller_id_count = 1`。
- つまり、同じ補正行が重複投入されている可能性が高い。
- 全体確認でも、同一 `product_id` 内で `title` または `seller_id` が複数種類あるケースは0件。

未確認:

- なし。現時点では `master_title_fix` は `product_id` ごとに `MAX(title)` / `MAX(seller_id)` で一意化してよいと判断する。

確定方針:

- `master_title_fix` の重複は単純重複として扱う。
- 新規一意化Viewでは、`master_title_fix` を `product_id` ごとに集約してから `master` にJOINする。
- 既存 `master_view` は参照用としては残すが、新規実装の照合には直接使わない。

## 新規テーブル設計案

この章では、新規テーブルの設計案を記録する。

方針として、既存の `testcsv` を本番管理用に拡張するのではなく、既存データを参照・コピーして、新しいテーブルへ整理する。

既存テーブルは触らず、今回の仕様に合わせた新規テーブルで「現在状態」と「履歴」を分けて管理する。

現時点では、`owned_files` と `file_process_logs` の採用方針は決定。ただし、まだテーブル作成は行わない。

要件定義と設計開発は分ける。ここでは設計案と採用方針を記録し、実際のCREATE TABLEや移行SQLは後続フェーズで作成する。

### 新規DBオブジェクト命名規約

今回のプロジェクトで新規作成するテーブル、Viewは、既存DB内で住み分けるため必ず共通接頭語を付ける。

プロジェクト接頭語:

- `xxx_`

種別コード:

- `TM`: マスターテーブル系。
- `TL`: ログテーブル系。
- `VQ`: View系。

命名形式:

- マスターテーブル系: `xxx_TM001_...`
- ログテーブル系: `xxx_TL001_...`
- View系: `xxx_VQ001_...`

命名例:

- `xxx_TM001_moviemaster`
- `xxx_TM002_owned_files`
- `xxx_TL001_file_process_logs`
- `xxx_VQ001_owned_movie_view`

注意:

- 新規作成するDBオブジェクトは、この命名規約に従う。
- 既存テーブル名と同じ、または似すぎた名前は避ける。
- 連番は用途ごとに設計段階で確定する。
- ここに出てくる `owned_files` や `file_process_logs` は概念名であり、実際のDB名は接頭語付きの正式名にする。

### `owned_files` 案

目的:

- 所有している実体 `.mp4` ファイルをファイル単位で管理する。
- `master.product_id` と1対多で紐づける。
- リネーム後・移動後の現在フルパスをDBに保存する。
- Goal 1 と Goal 3 の中心テーブルにする。

採用方針:

- 採用する。
- 既存 `testcsv` を直接拡張せず、`testcsv` のデータを初期移行元の一つとして扱う。
- `owned_files` は所有ファイルの現在状態を管理する正式テーブル候補とする。
- まだ作成しない。要件定義と設計を固めた後に作成SQLを検討する。
- 実際のテーブル名は命名規約に従い、例として `xxx_TM002_owned_files` のような名前にする。

想定カラム:

- `id` bigserial primary key
- `product_id` text
- `current_path` text
- `current_file_name` text
- `original_path` text
- `original_file_name` text
- `file_ext` text
- `part_label` text
- `duplicate_label` text
- `duplicate_group_key` text
- `pathid` text
- `status` text
- `source` text
- `matched_by` text
- `created_at` timestamp with time zone
- `updated_at` timestamp with time zone
- `last_checked_at` timestamp with time zone
- `note` text

カラム案の意味:

- `id`: 所有ファイル1件ごとの主キー。
- `product_id`: `master.product_id` に対応する作品番号。未照合の場合はNULLを許容するか検討する。
- `current_path`: 現在の実体ファイルのフルパス。
- `current_file_name`: 現在のファイル名。
- `original_path`: 初回検出時、または移動前のフルパス。
- `original_file_name`: 初回検出時、または移動前のファイル名。
- `file_ext`: `.mp4` などの拡張子。
- `part_label`: `_1`, `_2`, `-01`, `-02` などの枝番・分割情報。
- `duplicate_label`: `(1)`, `(2)` などの同名回避サフィックス。
- `duplicate_group_key`: 同一作品・同一基本ファイル名の重複候補をまとめるためのキー。
- `pathid`: `K` など、保存場所やドライブを表す識別子。既存 `testcsv.pathid` を参考にする。
- `status`: `matched`, `unmatched`, `moved`, `renamed`, `pending`, `error` などの状態。
- `source`: `legacy_testcsv`, `initial_scan`, `daily_download` など、登録元。
- `matched_by`: `product_id_from_filename`, `manual`, `title`, `unknown` など、照合方法。
- `created_at`: DB登録日時。
- `updated_at`: 最終更新日時。
- `last_checked_at`: 実体ファイルの存在確認日時。
- `note`: 補足メモ。

制約案:

- `id` を主キーにする。
- `product_id` は `master.product_id` と紐づける候補。ただし既存 `master.product_id` がnullableで主キーではないため、外部キー制約を付けるかは要検討。
- `current_path` は一意にする候補。
- `product_id` 単体をUNIQUEにしない。1作品に複数ファイルがあるため。

インデックス案:

- `product_id`
- `current_path`
- `status`
- `pathid`
- `source`

検討事項:

- 未照合ファイルも `owned_files` に入れるか、別の保留テーブルに分けるか。
- `current_path` にUNIQUE制約を付けるか。
- 実体ファイルが消えた場合のステータス。
- `testcsv` から過去ログを移行するか。
- `Moved` の未分類ログをどう扱うか。
- `Moved+Renamed` のみを初期移行対象にするか。
- ファイルサイズ、更新日時、ハッシュを保存するか。
- 将来的にサムネイルやライブラリーページから参照する主キーとして使うか。
- 重複候補の比較用に、ファイルサイズ、ハッシュ、再生チェック結果を持たせるか。

初期移行方針:

- `testcsv.action = 'Moved+Renamed'` のみを `owned_files` の初期移行対象にする。
- `testcsv.action = 'Moved'` は初期移行しない。
- `Moved` は今後の未分類救済処理、または日次新規ファイル処理のテスト対象として扱う。
- `Moved` のファイルは、今後DBマスターと照合し、リネーム・カテゴリ移動・DB登録を行う対象にする。
- 救済処理でリネーム・移動に成功した場合、その移動先フルパスと所有済み状態を `owned_files` に新規登録する。
- この方針により、既存の怪しい未分類ログを本番所有ファイル管理に混ぜず、今後の正式処理でクリーンに登録できる。
- ただし、`Moved+Renamed` の中にも現在の `master` と照合できない行があるため、初期移行時は `master` と一致する行だけを安全移行対象にする。
- `Moved+Renamed` だが `master` に存在しない行は、分類済み過去ログではあるが、初期移行では保留扱いにする。

### `Moved+Renamed` だが `master` と照合できない行の扱い

確認結果:

- `Moved+Renamed` の中に、現在の `master` と一致しない行が存在する。
- これらは過去処理ではタイトル・販売者が取れており、販売者フォルダへ移動済みのため、過去ログ上は「分類済み」。
- ただし、現在の `master` に `product_id` が存在しないため、新しい `owned_files` へ通常の所有ファイルとして移行するには危険。

考えられる原因:

- 過去スクリプトがFC2以外のファイル名から誤って作品番号を抽出した。
- 当時は外部HPで取得できたが、現在のマスターDBに未投入。
- スクレイピング時の取得漏れ、読み込み不良、欠番。
- 作品番号抽出ロジックが古く、別作品・別サービスの番号をFC2番号として扱った。
- `newpath` に `all_fc3` のような想定外パスが混じっており、過去ログ自体に表記ゆれや誤記がある。

移行方針:

- `Moved+Renamed` かつ `master.product_id` に一致する行を初期移行の安全対象にする。
- `Moved+Renamed` だが `master` に一致しない行は、初期移行せず保留リストに回す。
- 保留リストは、後続の未分類救済処理またはマスターDB補完処理で再確認する。
- これにより、分類済みだがマスター不整合のファイルを、通常の所有ファイルとして誤登録しない。

確定件数:

現時点の目安:

- 初期移行安全対象: 6,429件。
- 保留対象: 683件。

注意:

- この数値は開発中の確認用指標であり、厳密な仕様値ではない。
- 実装時はSQL条件と処理結果で確認し、件数そのものに過度に依存しない。

初期移行安全対象の `pathid` 内訳:

- `D`: 739件
- `E`: 2,312件
- `G`: 594件
- `I`: 992件
- `K`: 1,309件
- `L`: 475件
- 空欄: 8件

保留対象の `pathid` 内訳:

- `D`: 90件
- `E`: 122件
- `G`: 42件
- `I`: 38件
- `K`: 101件
- `L`: 290件

### `file_process_logs` 案

目的:

- ファイル検出、リネーム、移動、DB更新、失敗などの履歴を残す。
- `owned_files` は現在状態、`file_process_logs` は履歴として分ける。

採用方針:

- 採用する。
- ファイル操作やDB更新の履歴は `owned_files` に詰め込まず、別テーブルとして残す。
- 過去の `testcsv` は、この履歴テーブルへ移行できるか検討する。
- まだ作成しない。
- 実際のテーブル名は命名規約に従い、例として `xxx_TL001_file_process_logs` のような名前にする。
- 完全自動でリネーム・移動された場合でも、移動前パス、移動後パス、旧ファイル名、新ファイル名、登録元、照合方法を追跡できるようにする。
- 自動処理で「どこにあったものがどこへ行ったか」が失われないようにする。
- DBログを正式ログとする。
- ただし、DB書き込みエラーに備えて、同じ内容のCSVログも必ず生成する。
- DBログとCSVログのカラム構造は可能な限り揃える。
- ファイル移動やリネームが発生した場合、DB登録に失敗してもCSVログから追跡できるようにする。

想定カラム:

- `id` bigserial primary key
- `run_id` text
- `owned_file_id` bigint
- `product_id` text
- `old_path` text
- `new_path` text
- `old_file_name` text
- `new_file_name` text
- `action` text
- `status` text
- `source` text
- `matched_by` text
- `error_message` text
- `processed_at` timestamp with time zone
- `note` text

検討事項:

- `owned_file_id` に外部キー制約を付けるか。
- 過去の `testcsv` をこのテーブルへ移行するか。
- ログはDBとCSVの両方に残すか。
- 日次DL処理、未分類救済処理、手動補正処理のすべてで、このログを必ず残すか。
- 自動移動・自動リネーム前にドライランログを残すか。

確定方針:

- ログはDBとCSVの両方に残す。
- DBログが正とするが、CSVログはDB障害時の保険として扱う。
- CSVログは処理単位または日付単位で出力する。
- CSVログの保存先と命名規則はコード設計時に決める。
- `run_id` を持たせ、同じ処理実行単位のログをまとめて追跡できるようにする。
- `run_id` にはインデックスを作成する。
- `owned_file_id` はNULLを許容する。
- 初期段階では `owned_file_id` に外部キー制約を付けない。
- 理由は、`owned_files` 登録前の検出、移動、照合、エラーもログに残したいため。
- `owned_files` 登録後に紐づけられるログでは `owned_file_id` を入れる。
- ログは厳密性より追跡性を優先する。

CSVログカラム案:

- `run_id`
- `owned_file_id`
- `product_id`
- `old_path`
- `new_path`
- `old_file_name`
- `new_file_name`
- `action`
- `status`
- `source`
- `matched_by`
- `error_message`
- `processed_at`
- `note`

`run_id` 例:

- `20260509_223000_initial_import`
- `20260509_223000_daily_download`
- `20260509_223000_rescue_moved`

CSVログファイル名:

- `file_process_{run_id}.csv` とする。
- 例: `file_process_20260509_223000_daily_download.csv`
- DBログの `run_id` とCSVファイル名の `run_id` を一致させる。

`action` 値:

- `initial_import`: 既存 `testcsv` からの初期移行。
- `detected`: ファイル検出。
- `moved_to_staging`: 一時処理フォルダへの移動。
- `matched`: DBマスターとの照合成功。
- `renamed`: リネーム。
- `moved_to_final`: 最終保存先への移動。
- `registered_owned_file`: `xxx_TM002_owned_files` への登録。
- `error`: エラー。

`status` 値:

- `success`: 成功。
- `skipped`: 対象外または処理見送り。
- `error`: 失敗。
- `dry_run`: ドライラン。

ドライラン方針:

- `is_dry_run` のような専用カラムは初期段階では作らない。
- ドライランは `status = 'dry_run'` で表現する。
- 例: `action = 'moved_to_final'`, `status = 'dry_run'`。

エラー記録方針:

- 通常のエラーでは、`action` には実行しようとした操作を入れる。
- 例: 最終移動に失敗した場合は `action = 'moved_to_final'`, `status = 'error'`。
- `error_message` に具体的なエラー内容を入れる。
- `action = 'error'` は、どの操作中のエラーか分類できない場合のみに使う。

### `unmatched_files` 案

目的:

- DB照合できない `.mp4` を保留管理する。
- 人間確認や後日の再照合に回す。

採用方針:

- 保留。
- `owned_files.status = 'unmatched'` として同一テーブルで扱う案と、別テーブルにする案を比較してから決める。
- 未照合ファイルの量、手動補正の流れ、再照合の頻度を見て判断する。
- 別テーブルにする場合、実際のテーブル名は命名規約に従う。

想定カラム:

- `id` bigserial primary key
- `detected_path` text
- `detected_file_name` text
- `extracted_number` text
- `reason` text
- `status` text
- `created_at` timestamp with time zone
- `updated_at` timestamp with time zone
- `note` text

検討事項:

- `owned_files.status = 'unmatched'` として同じテーブルに入れるか、別テーブルにするか。
- 未分類フォルダへ移動した後のパスを保存するか。
- 手動補正後に `owned_files` へ昇格する流れをどう作るか。

## 休憩前決定メモ

この章は、Phase 1.5 のうち休憩前に決めた要件案をまとめる。

### 1. `owned_files` 正式カラム要件案

実際のテーブル名は命名規約に従い、`xxx_TM002_owned_files` で確定する。

必須寄りのカラム:

- `id`: 所有ファイル1件ごとの主キー。
- `product_id`: 作品番号。初期移行対象では `master.product_id` と一致するものだけを入れる。
- `current_path`: 正規化済みの現在フルパス。必ず `X:\...` 形式。
- `current_file_name`: 現在のファイル名。
- `original_path`: 過去ログまたは検出時点の元フルパス。
- `original_file_name`: 過去ログまたは検出時点の元ファイル名。
- `file_ext`: 拡張子。初期対象は原則 `.mp4`。
- `pathid`: `D`, `E`, `G`, `I`, `K`, `L` などの保存先識別子。
- `status`: 現在状態。
- `source`: 登録元。例: `legacy_testcsv`, `daily_download`, `manual_fix`。
- `matched_by`: 照合方法。例: `testcsv_number_master`, `filename_product_id`, `manual`。
- `created_at`: レコード作成日時。`timestamptz NOT NULL DEFAULT now()` を想定。
- `updated_at`: レコード更新日時。`timestamptz NOT NULL DEFAULT now()` を想定。

重複・分割管理用カラム:

- `part_label`: `-1`, `_1`, `-01` などの分割・パート情報。
- `duplicate_label`: `(1)`, `(2)` などの同名回避サフィックス。
- `duplicate_group_key`: 重複候補をまとめるためのキー。
- `is_duplicate_candidate`: 重複候補かどうかを表す真偽値。

任意・後続検討カラム:

- `last_checked_at`: 実体ファイル存在確認日時。
- `file_size`: ファイルサイズ。数値で保存する。
- `file_modified_at`: 実体ファイルの最終更新日時。
- `file_hash`: 重複比較用ハッシュ。
- `play_check_status`: 再生確認結果。
- `note`: 補足。

方針:

- 正式テーブル名は `xxx_TM002_owned_files`。
- `TM002` の連番は他のテーブルと重複させない。
- `product_id` 単体にUNIQUE制約は付けない。
- 1作品に複数ファイルが紐づくことを前提にする。
- `(1)` 付きファイルは重複候補として扱うが、自動削除しない。
- `part_label` と `duplicate_label` は分けて扱う。
- `xxx_TM002_owned_files` は、所有していて、作品番号・名前・保存場所が明確なクリーンなレコードだけを入れる。
- 未整合ファイル、未照合ファイル、保留ファイルは `xxx_TM002_owned_files` には入れず、別テーブルで管理する。
- そのため、`product_id` はNULLを許容しない。
- `current_path` と `current_file_name` もNULLを許容しない方針。
- `current_path` はNULLを許容しないが、現時点ではUNIQUE制約を付けない。
- パス表記ゆれ、将来の移動、重複候補、移行時の確認不足でINSERTが止まるリスクを避けるため。
- `current_path` の重複確認は、検証SQLまたはViewで行う。
- 必要であれば後からインデックスを検討する。
- `status` は現在状態だけを表す。
- 重複候補かどうかは `status` に混ぜず、`is_duplicate_candidate` で管理する。
- `file_size` と `file_modified_at` は最初から持つ。
- `file_hash` と `play_check_status` は初期段階では持たず、将来の重複整理・破損確認フェーズで検討する。
- `created_at` と `updated_at` は最初から持つ。
- `updated_at` は初期段階ではDBトリガーを作らず、アプリ側またはSQL側で更新時に `now()` を入れる。

初期インデックス方針:

- `product_id`: 作品単位の照合・検索用。
- `current_path`: ファイルパス検索・存在確認・将来のリンク処理用。
- `status`: 状態別確認用。
- `duplicate_group_key`: 重複候補の抽出・将来のストレージ整理用。

注意:

- `current_path` はUNIQUE制約ではなく、通常インデックスにする。
- インデックスは将来のローカルブラウザアプリでの検索速度向上も見込んで設計する。

`status` 候補:

- `owned`: 正常に所有ファイルとして登録済み。
- `missing`: DBにはあるが、実体ファイル確認時に見つからなかった。
- `error`: 何らかの確認・処理エラー。

重複候補の扱い:

- `(1)` などがある行は、必要に応じて `is_duplicate_candidate = true` にする。
- `duplicate_label` に `(1)` などを保存する。
- 重複候補でも、実体が存在し正常なら `status = owned` のままにする。

未照合ファイルの扱い:

- `Moved` やマスター不一致の `Moved+Renamed` は、`xxx_TM002_owned_files` の初期移行対象外。
- これらは後続の保留・未整合管理テーブルで扱う。
- 手動確認や救済処理によって作品番号、名前、保存場所が明確になった時点で、`xxx_TM002_owned_files` へ昇格登録する。

### 2. `xxx_VQ001_moviemaster_unique` View要件案

目的:

- 既存 `master_view` の重複問題を避ける。
- ファイル照合用に、1 `product_id` 1行の安全なマスター参照Viewを作る。
- 第3正規形を意識し、所有ファイル側へ作品名や販売者名を重複保存しないための参照元にする。

候補名:

- `xxx_VQ001_moviemaster_unique`

表示カラム案:

- `product_id`
- `title`
- `seller_id`

方針:

- `master` を基準にする。
- `master_title_fix` は `product_id` ごとに `MAX(title)` と `MAX(seller_id)` で一意化してからJOINする。
- `title` は `COALESCE(fixed.title, master.title)` を使う。
- `seller_id` は `master.seller_id` を使う。
- `seller_names` は含めない。販売者名は複数行になりうるため、照合用Viewでは重複原因になる。
- 初期移行やファイル照合では、既存 `master_view` を直接使わず、この一意化Viewを使う。
- 販売者の表示名や別名管理は、別の正規化テーブルまたは表示用Viewで扱う。

### 販売者正規化テーブル案

目的:

- `seller_id` を同一販売者の安定キーとして扱う。
- 販売者名が変わる、複数名がある、表記ゆれがある場合でも同じ販売者として管理する。
- `seller_names` を直接JOINしてマスター行が増える問題を避ける。

方針:

- 既存 `sellers` / `seller_names` は参照元として扱う。
- 今回プロジェクト用には、接頭語付きの販売者正規化テーブルを検討する。
- 表示用の販売者名は1つに絞り、複数名称はエイリアスとして別管理する。

候補テーブル:

- `xxx_TM003_seller_groups`
- `xxx_TM004_seller_aliases`

#### `xxx_TM003_seller_groups` 案

役割:

- 販売者の正規キーを管理する。
- 1 `seller_id` につき1行。

想定カラム:

- `seller_key` bigserial primary key
- `seller_id` text not null unique
- `canonical_seller_name` text
- `created_at` timestamp with time zone
- `updated_at` timestamp with time zone
- `note` text

#### `xxx_TM004_seller_aliases` 案

役割:

- 同一販売者に紐づく複数の販売者名、表記ゆれ、過去名を管理する。

想定カラム:

- `id` bigserial primary key
- `seller_key` bigint not null
- `seller_name` text not null
- `is_primary` boolean
- `source` text
- `registered_at` timestamp with time zone
- `created_at` timestamp with time zone
- `updated_at` timestamp with time zone

設計メモ:

- `xxx_TM003_seller_groups.seller_id` は既存 `sellers.seller_id` を元に作る。
- `xxx_TM004_seller_aliases.seller_name` は既存 `seller_names.seller_name` を元に作る。
- `xxx_VQ001_moviemaster_unique` には `seller_name` を入れず、必要な表示Viewで `seller_id` または `seller_key` を通して結合する。
- 将来のローカルライブラリーページでは、販売者表示名は `canonical_seller_name` を使い、詳細画面で別名一覧を見られるようにできる。

### 第3正規形に関する方針

- `xxx_TM002_owned_files` には作品タイトルや販売者名を重複保存しない。
- `xxx_TM002_owned_files` は `product_id` でマスターと紐づける。
- 作品タイトルは `xxx_VQ001_moviemaster_unique` から参照する。
- 販売者名は販売者正規化テーブル、または表示用Viewから参照する。
- `current_file_name` は作品タイトルの重複ではなく、実体ファイルの現在名として保存する。実ファイルの状態を表すため保持する。
- `current_path` も実体ファイルの現在位置として保持する。
- ライブラリーページや確認用画面では、Viewで `owned_files`、マスター、販売者正規化テーブルをJOINして表示する。

### 3. `Moved+Renamed` 初期移行SQL要件案

対象:

- `testcsv.action = 'Moved+Renamed'`
- `testcsv.number` が `master.product_id`、または `xxx_VQ001_moviemaster_unique.product_id` と一致する行。

対象外:

- `testcsv.action = 'Moved'`
- `Moved+Renamed` だがマスターに存在しない行。
- `pathid` や `newpath` からWindows絶対パスを作れない行。

移行時に行うこと:

- `newpath` を `X:\...` 形式に正規化し、`current_path` に入れる。
- `newfilename` を `current_file_name` に入れる。
- `oldpath` を `original_path` に入れる。
- `oldfilename` を `original_file_name` に入れる。
- `number` を `product_id` に入れる。
- `pathid` を `pathid` に入れる。
- `-1`, `_1`, `-01` などを抽出できる場合は `part_label` に入れる。
- `(1)`, `(2)` などを抽出できる場合は `duplicate_label` に入れる。
- 重複候補をまとめられる場合は `duplicate_group_key` を作る。
- `source` は `legacy_testcsv` にする。
- `matched_by` は `testcsv_number_master` にする。

移行時にしないこと:

- 実体ファイル削除。
- 重複ファイル削除。
- 既存 `testcsv` の更新。
- 既存 `master` / `master_title_fix` の更新。

安全策:

- 最初はドライランSQLまたはSELECTで移行予定一覧を確認する。
- 件数は目安として確認するが、仕様値として固定しない。
- `current_path` の正規化結果を確認してからINSERTする。
- 実体ファイル存在確認を初期移行時に必須にするか、後続チェックにするかは設計段階で決める。

採用方針:

- この要件案を採用する。
- `current_path` は `X:\...` 形式に正規化する。
- `D:all_fc2\...`, `K:all_fc2\...`, `I:all_fc2\...` は、それぞれ `D:\all_fc2\...`, `K:\all_fc2\...`, `I:\all_fc2\...` に補正する。
- すでに `E:\...`, `G:\...`, `L:\...` 形式のものはそのまま扱う。
- 正規化できないものは初期移行せず保留する。
- `-1`, `_1`, `-01`, `_02` などは `part_label` に入れる。
- `(1)`, `(2)`, `(3)` などは `duplicate_label` に入れる。
- `duplicate_label` がある場合は `is_duplicate_candidate = true` にする。
- `duplicate_label` がない場合は `is_duplicate_candidate = false` にする。
- 初期値は `status = owned`, `source = legacy_testcsv`, `matched_by = testcsv_number_master` とする。
- 初期移行前に必ずドライランSELECTを出し、件数、正規化パス、`product_id`, `part_label`, `duplicate_label`, `is_duplicate_candidate` を確認する。

---

## 2026-05-16 現行DB仕様メモ

この節は、ローカルDB `mp4DB` を読み取り専用で確認した現行仕様である。既存の過去メモは残し、現在のWebアプリとバッチが実際に参照しているDBオブジェクトをここに整理する。

### FC2記事ページ補完マスター

`fc2_article_collector_operational.js` が、既存の `master` の穴を補完するためにFC2記事ページをスクレイピングし、差分登録の受け皿として使う。

#### `master`

- 役割: 既存の最小FC2マスター。
- 列: `product_id`, `title`, `seller_id`
- 現行件数: 1,827,313件
- 備考: `product_id` に `master_pid_unique` がある。現時点では `xxx_` 接頭辞ではない既存中核テーブルとして継続利用している。

#### `xxx_tm006_fc2_article_master_full`

- 役割: FC2記事ページ由来の補完マスター本体。
- 主キー: `product_id`
- 現行件数: 152,247件
- 列: `product_id`, `title`, `seller_id`, `seller_name`, `price_text`, `price_pt`, `article_url`, `search_page_url`, `page_number`, `row_index_in_page`, `collected_at`
- 主な索引: `product_id` primary key, `seller_id`, `price_pt`, `page_number`, `collected_at`
- 用途: `master` にはない販売者名、価格、記事URL、取得ページ情報を保持する。

#### `xxx_tm006_fc2_article_master_full_stage`

- 役割: `xxx_tm006_fc2_article_master_full` へ差分投入する前のステージ。
- 現行件数: 3,300件
- 列: `xxx_tm006_fc2_article_master_full` と同じ。
- 注意: 現行コードは投入前に `TRUNCATE TABLE` している。`rules.md` では `TRUNCATE` が禁止されているため、今後は `run_id` 付きステージ、テンポラリテーブル、または明示例外承認のいずれかに整理する必要がある。

#### `xxx_tm006_fc2_article_master_import_stage`

- 役割: `master` に差分投入するための最小列ステージ。
- 現行件数: 3,300件
- 列: `product_id`, `title`, `seller_id`
- 注意: こちらも現行コードでは `TRUNCATE TABLE` 対象である。

### Webアプリ用ビュー

#### `xxx_vq001_moviemaster_unique`

- 役割: Webアプリとファイル処理の標準作品マスター参照ビュー。
- 列: `product_id`, `title`, `seller_id`
- 現行件数: 1,827,313件
- 定義概要: `master` をベースにし、`master_title_fix` の `product_id` ごとの `MAX(title)`, `MAX(seller_id)` を左結合する。表示タイトルは `COALESCE(fixed.title, master.title)`。

#### `xxx_vq002_owned_product_ids`

- 役割: 所持済み `product_id` 判定用ビュー。
- 列: `product_id`
- 現行件数: 5,973件
- 定義概要: legacy `testcsv` の `action = 'Moved+Renamed'` と、`xxx_tm002_owned_files.status = 'owned'` を `UNION` する。
- 注意: `xxx_tm002_owned_files` にない `product_id` が混ざるため、クリーンな所有判定だけを使う画面では整理が必要。

#### `xxx_vq013_owned_seller_summary_display`

- 役割: Seller Completion の販売者一覧用ビュー。
- 列: `seller_id`, `seller_name`, `total_products`, `owned_products`, `missing_products`
- 現行件数: 519件
- 定義概要: `xxx_vq010_owned_seller_summary` に `xxx_vq012_seller_display` を左結合して、販売者ごとの所持/未所持数と表示名を出す。
- API用途: `/api/seller-summary`

#### `xxx_vq025_rapidgator_best_links`

- 役割: 欠品作品へRapidgator候補リンクを付与するビュー。
- 現行件数: 29,174件
- 主な列: `fc2_product_id`, `has_rapidgator`, `has_mp4`, `has_rar`, `total_records`, `distinct_url_count`, `mp4_count`, `rar_count`, `best_mp4_title`, `best_mp4_url`, `best_mp4_size`, `best_mp4_page_url`, `best_page_url`, `all_urls`, `normalized_group_key`, `normalized_group_rule`
- 定義概要: `xxx_vq020_rapidgator_group_normalized` のうち `fc2_product_id` がある行を集計し、mp4優先で代表リンクを選ぶ。
- API用途: `/api/seller-missing/:sellerId`

#### `xxx_vq023_rapidgator_group_summary`

- 役割: Rapidgator Research の左側グループ一覧用ビュー。
- 現行件数: 7,023件
- グループ単位: `normalized_group_key`
- 主な列: `normalized_group_key`, `sample_group_rule`, `total_records`, `distinct_file_title_count`, `distinct_base_title_count`, `distinct_url_count`, `source_page_count`, `fc2_record_count`, `distinct_fc2_product_count`, `mp4_count`, `mkv_count`, `avi_count`, `wmv_count`, `rar_count`, `part_record_count`, `sample_folder_name`, `sample_file_title`, `sample_file_url`, `file_ext_list`
- API用途: `/api/rapidgator/groups`

#### `xxx_vq022_rapidgator_base_title_summary`

- 役割: Rapidgator Research のグループ内アイテム一覧用ビュー。
- 現行件数: 479,715件
- 集計単位: `base_title_without_part`
- 主な列: `base_title_without_part`, `normalized_group_key`, `normalized_group_rule`, `fc2_product_id`, `total_records`, `distinct_url_count`, `source_page_count`, `mp4_count`, `mkv_count`, `avi_count`, `wmv_count`, `rar_count`, `part_record_count`, `min_part_no`, `max_part_no`, `availability_type`, `sample_folder_name`, `sample_file_title`, `sample_file_url`, `file_ext_list`, `file_title_list`, `file_url_list`
- API用途: `/api/rapidgator/group/:groupKey/items`

#### `xxx_v_local_mp4_exists_master`

- 役割: ローカルに実ファイル候補があり、かつ `master` に存在する作品を表示するビュー。
- 現行件数: 945件
- 列: `product_id`, `title`, `seller_id`, `file_name`, `full_path`, `file_size`, `last_write_time`
- 定義概要: `local_mp4_ids_raw` と `master` を `product_id` で結合し、7桁数字の `product_id` に絞る。
- API用途: `/api/seller-missing/:sellerId` のローカルMP4候補表示。
- 注意: View名が `xxx_VQ###_...` 形式ではない。既存互換として残すか、規約準拠の `xxx_vq###_local_mp4_exists_master` を新設するかは要決定。

### Rapidgator系

#### `xxx_tl002_rapidgator_raw`

- 役割: Rapidgator収集結果の生ログテーブル。
- 現行件数: 780,712件
- 主な列: `global_seq`, `csv_part_no`, `file_seq`, `source_page_url`, `folder_id`, `folder_name`, `page_number`, `row_index_in_page`, `file_title`, `file_url`, `file_size`, `file_ext`, `group_key`, `group_rule`, `fc2_product_id`, `part_no`, `part_label`, `part_type`, `base_title_without_part`, `collected_at`, `inserted_at`
- 派生ビュー: `xxx_vq020_rapidgator_group_normalized`, `xxx_vq022_rapidgator_base_title_summary`, `xxx_vq023_rapidgator_group_summary`, `xxx_vq024_rapidgator_multi_url`, `xxx_vq025_rapidgator_best_links`

#### `xxx_vq020_rapidgator_group_normalized`

- 役割: Rapidgator raw に `normalized_group_key` と `normalized_group_rule` を付与した正規化ビュー。
- 現行件数: 780,712件
- 用途: Rapidgator系集計ビューの共通入力。

### ローカルファイル/所有管理

#### `xxx_tm002_owned_files`

- 役割: クリーンに所持確定したローカルファイルの本登録テーブル。
- 現行件数: 7,111件
- 主な列: `id`, `product_id`, `current_path`, `current_file_name`, `original_path`, `original_file_name`, `file_ext`, `part_label`, `duplicate_label`, `duplicate_group_key`, `is_duplicate_candidate`, `pathid`, `status`, `source`, `matched_by`, `file_size`, `file_modified_at`, `last_checked_at`, `note`, `created_at`, `updated_at`
- UI用途: Local Library の一覧と open file/open folder の基準データ。

#### `xxx_tm011_owned_file_video_metadata`

- 役割: `xxx_tm002_owned_files` の所持 `.mp4` に対する動画解像度メタ情報を保持する。
- 主な列: `owned_file_id`, `product_id`, `current_path`, `current_file_name`, `file_size`, `file_modified_at`, `video_width`, `video_height`, `resolution_class`, `probe_status`, `probe_error`, `probed_at`, `created_at`, `updated_at`
- `resolution_class` は `4K`, `HD`, `LOW` のいずれか。取得失敗・ファイル欠損・許可外パスではNULLにする。
- 取得は `project_scripts/thumbnail_library_ui/scripts/collect_video_resolution.js` で行い、`ffprobe-static` を使う。
- AM5:30の `project_scripts/phase2_execute/phase2_file_pipeline2.js` でも、matched `.mp4` のDB登録時に同じテーブルへ保存する。
- UI用途: Local Library の解像度フィルタ。

#### `xxx_tm005_unmatched_files`

- 役割: 未照合または手動確認が必要なファイルの受け皿。
- 現行件数: 1,323件
- 主な列: `id`, `run_id`, `detected_path`, `staged_path`, `current_path`, `detected_file_name`, `current_file_name`, `extracted_product_id`, `reason`, `status`, `source`, `file_size`, `file_modified_at`, `note`, `created_at`, `updated_at`
- 方針: `xxx_tm002_owned_files` はクリーンな所持ファイルに限定し、未照合候補はこのテーブルで扱う。

#### `local_mp4_ids_raw`

- 役割: ローカルMP4スキャン結果の生テーブル。
- 現行件数: 2,276件
- 列: `id`, `product_id`, `file_name`, `full_path`, `file_size`, `last_write_time`, `imported_at`
- 用途: `xxx_v_local_mp4_exists_master` の入力。

### Thumbnail系の現状

- `xxx_tm006_thumbnail_assets`: 実DBには未作成。
- `xxx_tl002_thumbnail_jobs`: 実DBには未作成。
- 注意: コード上は `thumbnail_collector.js` と Vite middleware が `xxx_tm006_thumbnail_assets` を参照予定だが、現状は未作成のためUI側はfallbackし、`thumbnail_path` は空、`collect_status` は `unknown` になる。
- 採番注意: `TM006` は実DBではFC2記事ページ補完マスターが使用済み。サムネイル資産テーブルは `xxx_tm007_thumbnail_assets` など次の空き番号にする案が安全。
- 採番注意: `TL002` は実DBでは `xxx_tl002_rapidgator_raw` が使用済み。サムネイルジョブログは次の空き番号にする案が安全。
## 2026-05-16 追記: FC2 Wiki販売者軸とサムネイル状態

### `xxx_tm009_fc2_wiki_thumbnail_assets`

- 役割: FC2 Wiki由来のサムネイル取得状態を、`product_id` 単位で管理する。
- 主な列: `product_id`, `thumbnail_url`, `local_thumbnail_path`, `local_thumbnail_file_name`, `thumbnail_status`, `source_wiki_url`, `last_checked_at`, `downloaded_at`, `attempt_count`, `last_error`, `created_at`, `updated_at`
- 用途: 「実体ファイルはあるがサムネイルがない」作品を抽出・ソートするための状態テーブル。
- 保存先の実体ファイルは原則 `fc2_sum` 配下に置く。
- 旧計画の `xxx_tm006_thumbnail_assets` は採番衝突のため使わず、現行UIは `xxx_tm009_fc2_wiki_thumbnail_assets` と `xxx_vq029_owned_file_thumbnail_status` を参照する。

### `xxx_tm010_fc2_delta_thumbnail_targets`

- 役割: FC2記事最新取得から、サムネイル取得対象だけを一時退避するテーブル。
- 起点: `fc2_article_collector_operational.js` の最新取得バッチ。
- 対象条件: `xxx_tm006_fc2_article_master_full_stage.seller_name` が、`xxx_tm007_fc2_wiki_sellers.seller_name` のアクティブ販売者に一致し、既に `xxx_tm009_fc2_wiki_thumbnail_assets.thumbnail_status = 'collected'` ではない作品。
- 主な列: `product_id`, `source_run_id`, `source_collected_at`, `article_url`, `search_page_url`, `page_number`, `row_index_in_page`, `article_seller_id`, `article_seller_name`, `wiki_seller_id`, `wiki_seller_name`, `target_status`, `created_at`, `updated_at`
- 運用: 午前3時のマスター取得で投入し、午後9時の差分サムネイル取得後に `DELETE` で空にする。`TRUNCATE` は使わない。
- 注意: このテーブルは対象の一時退避用であり、処理履歴は `xxx_tl005_fc2_delta_thumbnail_target_logs` と既存サムネイルログに残す。

### `xxx_tl005_fc2_delta_thumbnail_target_logs`

- 役割: `xxx_tm010_fc2_delta_thumbnail_targets` への投入と、差分サムネイル取得結果の履歴ログ。
- 主な列: `id`, `run_id`, `product_id`, `article_seller_id`, `article_seller_name`, `wiki_seller_id`, `wiki_seller_name`, `action`, `result_status`, `detail`, `recorded_at`
- 用途: 「この日の対象に入った理由」「サムネイルが取得できたか」「まだサムネイル元に反映されていなかったか」を後から追跡する。
- `result_status = 'not_found_yet'` は、`product_id` は対象だが `xxx_tm008_fc2_wiki_articles` 側にサムネイルURLがまだ見つからない状態を表す。
- `fc2_article_delta_thumbnail_collector_operational.js` は、DB側に未反映の対象について `xxx_tm007_fc2_wiki_sellers.wiki_url` を確認し、同じ `product_id` の周辺HTMLからサムネイルURLを探す。FC2記事ページへの直アクセスはサムネイル用途では使わない。

### `xxx_vq026_wiki_article_master_enriched`

- 役割: `xxx_tm008_fc2_wiki_articles` と `xxx_vq001_moviemaster_unique` を結合し、masterに存在確認できたFC2 Wiki記事を扱うビュー。
- 現行件数: 75,919件。
- 販売者表示はFC2 Wiki由来の `wiki_seller_name` を主軸にする。

### `xxx_vq027_wiki_seller_summary_display`

- 役割: Seller Completionの販売者一覧用ビュー。
- `seller_id` は `wiki_seller_id` を文字列化した値、`seller_name` はFC2 Wiki由来の販売者名。
- `/api/seller-summary` はこのビューを読む。

### `xxx_vq028_wiki_seller_missing_products`

- 役割: Seller Completionの販売者別未所持一覧用ビュー。
- `/api/seller-missing/:sellerId` はこのビューを起点にし、Rapidgator候補とローカルMP4候補を付与する。

### `xxx_vq029_owned_file_thumbnail_status`

- 役割: Local Libraryの所持作品に、FC2 WikiサムネイルURL、ローカルサムネイル状態、欠損状態を付与するビュー。
- `owned_without_thumbnail = true` の行は、所持ファイルはあるがローカルサムネイルが未取得の候補として扱える。

### `xxx_vq030_rapidgator_wiki_display`

- 役割: Rapidgator Researchの未所持候補リストに、FC2 Wiki基準の販売者名とサムネイル状態を付与するビュー。
- 入力: `xxx_vq022_rapidgator_base_title_summary`, `xxx_vq026_wiki_article_master_enriched`, `xxx_tm009_fc2_wiki_thumbnail_assets`
- 結合キー: `fc2_product_id = product_id`
- 主な追加列: `wiki_seller_id`, `wiki_seller_name`, `wiki_display_title`, `thumbnail_url`, `local_thumbnail_path`, `thumbnail_status`, `has_local_thumbnail`
- UI用途: `/api/rapidgator/group/:groupKey/items` がこのビューを読み、右側リストに販売者名と取得済みサムネイルを表示する。
