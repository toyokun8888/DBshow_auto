# Planned SQL

このファイルには、今後作成予定のSQLを記録する。

まだ実行しない。実行前に内容を再確認し、必要に応じて修正する。

## 前提

- 既存テーブルは変更しない。
- 新規作成するDBオブジェクトは `xxx_` 接頭語を付ける。
- マスターテーブル系は `TM`、ログテーブル系は `TL`、View系は `VQ` を使う。
- `testcsv` は過去ログ・移行元として扱い、本番管理用に直接拡張しない。

## 1. 一意化済みマスター参照View

候補名:

- `xxx_VQ001_moviemaster_unique`

目的:

- 既存 `master_view` の重複問題を避ける。
- `master_title_fix` を `product_id` 単位で一意化してから `master` にJOINする。
- ファイル照合や初期移行で使う。

```sql
CREATE OR REPLACE VIEW public.xxx_VQ001_moviemaster_unique AS
WITH fixed AS (
    SELECT
        product_id,
        MAX(title) AS title,
        MAX(seller_id) AS seller_id
    FROM public.master_title_fix
    GROUP BY product_id
)
SELECT
    m.product_id,
    COALESCE(f.title, m.title) AS title,
    m.seller_id
FROM public.master m
LEFT JOIN fixed f
    ON f.product_id = m.product_id;
```

確認用SQL:

```sql
SELECT
    COUNT(*) AS total_count,
    COUNT(product_id) AS product_id_count,
    COUNT(DISTINCT product_id) AS distinct_product_id_count
FROM public.xxx_VQ001_moviemaster_unique;
```

期待:

- `total_count` と `distinct_product_id_count` が一致すること。

## 2. 所有ファイル管理テーブル

正式名:

- `xxx_TM002_owned_files`

目的:

- 所有していて、作品番号・名前・保存場所が明確なクリーンなファイルだけを管理する。
- 1作品に複数ファイルがある前提で、ファイル単位に1行持つ。
- 未整合・未照合ファイルは入れない。

```sql
CREATE TABLE public.xxx_TM002_owned_files (
    id bigserial PRIMARY KEY,
    product_id text NOT NULL,
    current_path text NOT NULL,
    current_file_name text NOT NULL,
    original_path text,
    original_file_name text,
    file_ext text NOT NULL DEFAULT '.mp4',
    part_label text,
    duplicate_label text,
    duplicate_group_key text,
    is_duplicate_candidate boolean NOT NULL DEFAULT false,
    pathid text,
    status text NOT NULL DEFAULT 'owned',
    source text NOT NULL,
    matched_by text NOT NULL,
    file_size bigint,
    file_modified_at timestamp with time zone,
    last_checked_at timestamp with time zone,
    note text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
```

制約メモ:

- `product_id` はNOT NULL。
- `current_path` はNOT NULLだが、UNIQUE制約は付けない。
- `product_id` 単体にUNIQUE制約は付けない。
- `status` は初期段階では `owned`, `missing`, `error` を想定。
- `is_duplicate_candidate` で重複候補を管理する。

## 3. 所有ファイル管理テーブルのインデックス

```sql
CREATE INDEX xxx_idx_TM002_owned_files_product_id
    ON public.xxx_TM002_owned_files (product_id);

CREATE INDEX xxx_idx_TM002_owned_files_current_path
    ON public.xxx_TM002_owned_files (current_path);

CREATE INDEX xxx_idx_TM002_owned_files_status
    ON public.xxx_TM002_owned_files (status);

CREATE INDEX xxx_idx_TM002_owned_files_duplicate_group_key
    ON public.xxx_TM002_owned_files (duplicate_group_key);
```

## 4. ファイル処理ログテーブル

正式名:

- `xxx_TL001_file_process_logs`

目的:

- ファイル検出、リネーム、移動、DB更新、失敗などの履歴を残す。
- 自動処理後も「どこにあったものが、どこへ行ったか」を追えるようにする。
- DBログを正式ログとする。
- ただし、同じ内容のCSVログも生成し、DB書き込み失敗時でも追跡できるようにする。

```sql
CREATE TABLE public.xxx_TL001_file_process_logs (
    id bigserial PRIMARY KEY,
    run_id text,
    owned_file_id bigint,
    product_id text,
    old_path text,
    new_path text,
    old_file_name text,
    new_file_name text,
    action text NOT NULL,
    status text NOT NULL,
    source text,
    matched_by text,
    error_message text,
    processed_at timestamp with time zone NOT NULL DEFAULT now(),
    note text
);
```

外部キーについて:

- 初期段階では `owned_file_id` への外部キー制約は保留。
- 初期移行やエラー処理で `owned_file_id` がまだ無いログを残す可能性があるため。
- `owned_file_id` はNULL許可。
- ログは厳密性より追跡性を優先する。

インデックス案:

```sql
CREATE INDEX xxx_idx_TL001_file_process_logs_owned_file_id
    ON public.xxx_TL001_file_process_logs (owned_file_id);

CREATE INDEX xxx_idx_TL001_file_process_logs_run_id
    ON public.xxx_TL001_file_process_logs (run_id);

CREATE INDEX xxx_idx_TL001_file_process_logs_product_id
    ON public.xxx_TL001_file_process_logs (product_id);

CREATE INDEX xxx_idx_TL001_file_process_logs_processed_at
    ON public.xxx_TL001_file_process_logs (processed_at);

CREATE INDEX xxx_idx_TL001_file_process_logs_action
    ON public.xxx_TL001_file_process_logs (action);
```

CSVログ方針:

- DBログと同じ内容をCSVにも出力する。
- CSVログは処理単位または日付単位で保存する。
- CSVログファイル名は `file_process_{run_id}.csv` とする。
- CSVログの具体的な保存先はコード設計時に決める。
- DBエラーが発生してもCSVログ出力は試みる。
- CSVログにも `run_id` を出力する。

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

`action` 値:

- `initial_import`
- `detected`
- `moved_to_staging`
- `matched`
- `renamed`
- `moved_to_final`
- `registered_owned_file`
- `error`

`status` 値:

- `success`
- `skipped`
- `error`
- `dry_run`

ドライラン:

- 専用の `is_dry_run` カラムは作らない。
- `status = 'dry_run'` で表現する。

エラー記録:

- 通常エラーでは、`action` に失敗した操作名を入れる。
- 例: `action = 'moved_to_final'`, `status = 'error'`。
- `action = 'error'` は分類不能なエラーのみに使う。

## 5. 販売者正規化テーブル案

まだ採用検討中。実行前に再確認する。

### `xxx_TM003_seller_groups`

目的:

- `seller_id` を同一販売者の安定キーとして扱う。
- 1 `seller_id` につき1行。

```sql
CREATE TABLE public.xxx_TM003_seller_groups (
    seller_key bigserial PRIMARY KEY,
    seller_id text NOT NULL UNIQUE,
    canonical_seller_name text,
    note text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
```

### `xxx_TM004_seller_aliases`

目的:

- 同一販売者に紐づく複数の販売者名、表記ゆれ、過去名を管理する。

```sql
CREATE TABLE public.xxx_TM004_seller_aliases (
    id bigserial PRIMARY KEY,
    seller_key bigint NOT NULL,
    seller_name text NOT NULL,
    is_primary boolean NOT NULL DEFAULT false,
    source text,
    registered_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
```

外部キー案:

```sql
ALTER TABLE public.xxx_TM004_seller_aliases
ADD CONSTRAINT xxx_fk_TM004_seller_aliases_seller_key
FOREIGN KEY (seller_key)
REFERENCES public.xxx_TM003_seller_groups (seller_key);
```

## 6. 初期移行ドライランSQL

目的:

- `testcsv.action = 'Moved+Renamed'`
- マスターに存在するものだけ
- `current_path` を `X:\...` 形式に正規化
- `part_label`, `duplicate_label`, `is_duplicate_candidate` を確認

まだINSERTしない。まずこのSELECTで確認する。

```sql
SELECT
    t.id AS legacy_testcsv_id,
    t.number AS product_id,
    CASE
        WHEN t.newpath ~ '^[A-Z]:[^\\]' THEN
            regexp_replace(t.newpath, '^([A-Z]):', '\1:\\')
        ELSE
            t.newpath
    END AS normalized_current_path,
    t.newfilename AS current_file_name,
    t.oldpath AS original_path,
    t.oldfilename AS original_file_name,
    '.mp4' AS file_ext,
    CASE
        WHEN t.newfilename ~ '[-_][0-9]{1,2}\.mp4$'
            THEN substring(t.newfilename FROM '([-_][0-9]{1,2})\.mp4$')
        ELSE NULL
    END AS part_label,
    CASE
        WHEN t.newfilename ~ '\([0-9]+\)\.mp4$'
            THEN substring(t.newfilename FROM '(\([0-9]+\))\.mp4$')
        ELSE NULL
    END AS duplicate_label,
    CASE
        WHEN t.newfilename ~ '\([0-9]+\)\.mp4$'
            THEN true
        ELSE false
    END AS is_duplicate_candidate,
    t.pathid,
    'owned' AS status,
    'legacy_testcsv' AS source,
    'testcsv_number_master' AS matched_by
FROM public.testcsv t
JOIN public.xxx_VQ001_moviemaster_unique m
    ON m.product_id = t.number::text
WHERE t.action = 'Moved+Renamed'
ORDER BY t.id;
```

確認すること:

- 件数。
- `normalized_current_path` が `X:\...` 形式になっているか。
- `part_label` が分割ファイルだけに入っているか。
- `duplicate_label` が `(1)` などだけに入っているか。
- `is_duplicate_candidate` が妥当か。

## 7. 初期移行INSERT案

まだ実行しない。ドライラン確認後に使う候補。

```sql
INSERT INTO public.xxx_TM002_owned_files (
    product_id,
    current_path,
    current_file_name,
    original_path,
    original_file_name,
    file_ext,
    part_label,
    duplicate_label,
    duplicate_group_key,
    is_duplicate_candidate,
    pathid,
    status,
    source,
    matched_by
)
SELECT
    t.number AS product_id,
    CASE
        WHEN t.newpath ~ '^[A-Z]:[^\\]' THEN
            regexp_replace(t.newpath, '^([A-Z]):', '\1:\\')
        ELSE
            t.newpath
    END AS current_path,
    t.newfilename AS current_file_name,
    t.oldpath AS original_path,
    t.oldfilename AS original_file_name,
    '.mp4' AS file_ext,
    CASE
        WHEN t.newfilename ~ '[-_][0-9]{1,2}\.mp4$'
            THEN substring(t.newfilename FROM '([-_][0-9]{1,2})\.mp4$')
        ELSE NULL
    END AS part_label,
    CASE
        WHEN t.newfilename ~ '\([0-9]+\)\.mp4$'
            THEN substring(t.newfilename FROM '(\([0-9]+\))\.mp4$')
        ELSE NULL
    END AS duplicate_label,
    CASE
        WHEN t.newfilename ~ '\([0-9]+\)\.mp4$'
            THEN t.number::text || ':' || regexp_replace(t.newfilename, '\([0-9]+\)(\.mp4)$', '\1')
        ELSE NULL
    END AS duplicate_group_key,
    CASE
        WHEN t.newfilename ~ '\([0-9]+\)\.mp4$'
            THEN true
        ELSE false
    END AS is_duplicate_candidate,
    t.pathid,
    'owned' AS status,
    'legacy_testcsv' AS source,
    'testcsv_number_master' AS matched_by
FROM public.testcsv t
JOIN public.xxx_VQ001_moviemaster_unique m
    ON m.product_id = t.number::text
WHERE t.action = 'Moved+Renamed';
```

## 8. 初期移行後の確認SQL

```sql
SELECT COUNT(*) FROM public.xxx_TM002_owned_files;
```

```sql
SELECT
    status,
    COUNT(*) AS count
FROM public.xxx_TM002_owned_files
GROUP BY status
ORDER BY status;
```

```sql
SELECT
    is_duplicate_candidate,
    COUNT(*) AS count
FROM public.xxx_TM002_owned_files
GROUP BY is_duplicate_candidate
ORDER BY is_duplicate_candidate;
```

```sql
SELECT
    current_path,
    COUNT(*) AS count
FROM public.xxx_TM002_owned_files
GROUP BY current_path
HAVING COUNT(*) > 1
ORDER BY count DESC, current_path
LIMIT 100;
```

## 9. Unmatched Files Table Draft

正式名:

- `xxx_TM005_unmatched_files`

目的:

- 商品番号が抽出できないファイルを管理する。
- 商品番号は抽出できたが `xxx_VQ001_moviemaster_unique` と照合できないファイルを管理する。
- 未照合フォルダ、保留フォルダ、エラーフォルダへ送ったファイルを後から追跡できるようにする。
- 手動確認後に `xxx_TM002_owned_files` へ昇格登録するための元情報を残す。

方針:

- 未照合ファイルは `xxx_TM002_owned_files` には入れない。
- `xxx_TM002_owned_files` はクリーンな所有ファイルだけを入れる。
- 未照合ファイルの実体移動後のパスも保存する。
- 後から手動で確認、修正、再照合できるようにする。

```sql
CREATE TABLE public.xxx_TM005_unmatched_files (
    id bigserial PRIMARY KEY,
    run_id text,
    detected_path text NOT NULL,
    staged_path text,
    current_path text,
    detected_file_name text NOT NULL,
    current_file_name text,
    extracted_product_id text,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'unmatched',
    source text NOT NULL,
    file_size bigint,
    file_modified_at timestamp with time zone,
    note text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
```

status 初期候補:

- `unmatched`: 未照合。
- `pending`: 手動確認待ち、または保留。
- `resolved`: 手動確認または再照合により解決済み。
- `error`: 処理エラー。

インデックス案:

```sql
CREATE INDEX xxx_idx_TM005_unmatched_files_run_id
    ON public.xxx_TM005_unmatched_files (run_id);

CREATE INDEX xxx_idx_TM005_unmatched_files_extracted_product_id
    ON public.xxx_TM005_unmatched_files (extracted_product_id);

CREATE INDEX xxx_idx_TM005_unmatched_files_status
    ON public.xxx_TM005_unmatched_files (status);

CREATE INDEX xxx_idx_TM005_unmatched_files_current_path
    ON public.xxx_TM005_unmatched_files (current_path);
```

手動救済時の考え方:

- 未照合ファイルを確認する。
- 正しい `product_id` と保存先が確定したら、実ファイルをリネーム、移動する。
- 移動成功後に `xxx_TM002_owned_files` へ登録する。
- `xxx_TM005_unmatched_files.status` を `resolved` に更新する。
- 処理履歴は `xxx_TL001_file_process_logs` とCSVログに残す。

## Notes

- このSQLは作成予定であり、まだ実行しない。
- 実行前に `database.md` と `requirements_and_schedule.md` の方針と照合する。
- 実行前にバックアップまたはロールバック方針を決める。
 
## 2026-05-09 初期移行実行記録

`testcsv` の `Moved+Renamed` から、`xxx_vq001_moviemaster_unique` と商品番号で一致したクリーンな所有ファイルを `xxx_tm002_owned_files` へ初期登録した。

- 登録先: `public.xxx_tm002_owned_files`
- ログ登録先: `public.xxx_tl001_file_process_logs`
- `run_id`: `initial_import_legacy_testcsv_20260509`
- `source`: `legacy_testcsv`
- `matched_by`: `testcsv_number_master`
- 登録件数: 6132件
- `status`: `owned`
- `is_duplicate_candidate = true`: 404件
- `is_duplicate_candidate = false`: 5728件

初期候補のうち、同一の正規化済み `current_path` が重複していた行は、最小の `testcsv.id` の行だけを採用した。これにより、同一パスの重複登録は除外済み。

初期移行対象外:

- `Moved+Renamed` だが `master` / `xxx_vq001_moviemaster_unique` に一致しない683件は、`xxx_tm002_owned_files` には入れない。
- 上記683件は、後続の未照合ファイル救済または `xxx_tm005_unmatched_files` 側で扱う。
- `Moved` 旧ログは今回の初期登録対象外。後続の救済処理で別途扱う。

実行後確認:

- `source = legacy_testcsv`, `matched_by = testcsv_number_master` の件数は6132件。
- `current_path` 重複確認は空。
- これにより、初期移行DB登録は成功扱いとする。

---

## 2026-05-16 現行DBとの差分整理と今後のSQL方針

この節は、ローカルDB `mp4DB` の読み取り確認結果をもとにした追記である。ここに書くSQL方針は、まだ実行しない。実行前にユーザー確認を取る。

### 1. 採番の現状

実DBでは以下が存在する。

- `xxx_tm006_fc2_article_master_full`
- `xxx_tm006_fc2_article_master_full_stage`
- `xxx_tm006_fc2_article_master_import_stage`
- `xxx_tl002_rapidgator_raw`

一方、既存のサムネイル計画では以下を予定していた。

- `xxx_tm006_thumbnail_assets`
- `xxx_tl002_thumbnail_jobs`

このため、`TM006` と `TL002` は現行DBと計画の間で衝突している。既存DBを優先する場合、サムネイル系は次の空き番号へ変更する。

推奨案:

- `xxx_tm006_*`: FC2記事ページ補完マスター系として固定する。
- サムネイル資産テーブル: `xxx_tm007_thumbnail_assets` などへ変更する。
- `xxx_tl002_rapidgator_raw`: Rapidgator rawログとして固定する。
- サムネイルジョブログ: `xxx_tl003_thumbnail_jobs` などへ変更する。

未決定事項:

- サムネイル系の正式な `TM` / `TL` 番号。
- 既存コード内の `xxx_tm006_thumbnail_assets` 参照を、いつどの番号へ移すか。

### 2. FC2記事ページ補完マスター系

現行用途:

- 既存 `master` の穴を補完するため、FC2記事ページから `product_id`, `title`, `seller_id`, `seller_name`, `price`, `article_url` などを収集する。
- `xxx_tm006_fc2_article_master_full_stage` に一時投入する。
- `xxx_tm006_fc2_article_master_import_stage` に `master` 追加用の最小列を一時投入する。
- 差分だけ `master` と `xxx_tm006_fc2_article_master_full` に登録する。

現行コード上の注意:

- `fc2_article_collector_operational.js` は `DRY_RUN = false` と `CONFIRM_EXECUTE = "YES"` でDB更新可能な状態。
- stage初期化に `TRUNCATE TABLE` を使っている。
- `TRUNCATE` は `rules.md` の禁止事項と衝突する。

今後のSQL方針案:

1. `run_id` 付きステージ方式
   - stageテーブルに `run_id` を追加する。
   - 新規runの行だけ `INSERT` する。
   - 差分反映時は `WHERE run_id = $current_run_id` で対象を絞る。
   - 過去runは保持し、必要に応じて明示承認後にアーカイブ/整理する。

2. temporary table方式
   - 実行ごとにセッション内 `TEMP TABLE` を作る。
   - 恒久stageを空にしない。
   - バッチが落ちても既存データを破壊しない。

3. 明示例外方式
   - stage専用テーブルに限って `TRUNCATE` を許可する例外を文書化する。
   - ただし、現行の `rules.md` と衝突するため、ユーザー承認が必要。

推奨は `run_id` 付きステージ方式である。理由は、CSVログ、DB投入ログ、実行単位の再確認を後から突き合わせやすいから。

### 3. Rapidgator系ビューの管理対象

実DBで確認したRapidgator系の主要オブジェクト:

- `xxx_tl002_rapidgator_raw`
- `xxx_vq020_rapidgator_group_normalized`
- `xxx_vq021_rapidgator_fc2_unowned`
- `xxx_vq022_rapidgator_base_title_summary`
- `xxx_vq023_rapidgator_group_summary`
- `xxx_vq024_rapidgator_multi_url`
- `xxx_vq025_rapidgator_best_links`

今後は、これらの `CREATE VIEW` 定義を `planned_sql.md` または専用のRapidgator SQL計画ファイルで管理する。

現行UI/API対応:

- `/api/rapidgator/groups` は `xxx_vq023_rapidgator_group_summary` を読む。
- `/api/rapidgator/group/:groupKey/items` は `xxx_vq022_rapidgator_base_title_summary` を読む。
- `/api/seller-missing/:sellerId` は `xxx_vq025_rapidgator_best_links` を読む。

### 4. Seller Completion系ビューの管理対象

現行UI/API対応:

- `/api/seller-summary` は `xxx_vq013_owned_seller_summary_display` を読む。
- `/api/seller-missing/:sellerId` は `xxx_vq001_moviemaster_unique`, `xxx_vq002_owned_product_ids`, `xxx_vq025_rapidgator_best_links`, `xxx_v_local_mp4_exists_master` を読む。

注意:

- `xxx_vq002_owned_product_ids` は legacy `testcsv` と `xxx_tm002_owned_files` を `UNION` している。
- クリーンな所有判定に寄せる場合は、`xxx_tm002_owned_files` だけを見る新Viewを追加するか、既存Viewの責務を変更する必要がある。
- 既存View変更はUIの所持/未所持数に影響するため、実行前に件数比較SQLを出す。

### 5. `xxx_v_local_mp4_exists_master` の命名整理

現行の `xxx_v_local_mp4_exists_master` はViewだが、命名規約の `xxx_VQ###_...` 形式ではない。

選択肢:

1. 既存互換として残し、例外Viewとして `database.md` / `library.md` に明記する。
2. `xxx_vq###_local_mp4_exists_master` を新設し、コード参照を段階的に移行する。

コード変更を伴うため、今回は資料に現状と要決定事項だけを記録する。

### 6. Thumbnail系SQLの再計画

現行DBでは `xxx_tm006_thumbnail_assets` と `xxx_tl002_thumbnail_jobs` は存在しない。

再計画時の方針:

- 実DBで空いている `TM` / `TL` 番号を確認する。
- `TM006` はFC2記事ページ補完マスター系として扱う。
- `TL002` はRapidgator rawログとして扱う。
- thumbnail collector と UI middleware の参照先変更は、DB作成SQLと同じ作業単位で扱う。

### 7. 実行前チェックSQL方針

DB変更前には以下を確認する。

```sql
SELECT to_regclass('public.xxx_tm006_fc2_article_master_full') AS article_full;
SELECT to_regclass('public.xxx_tm006_thumbnail_assets') AS old_thumbnail_assets;
SELECT to_regclass('public.xxx_tl002_rapidgator_raw') AS rapidgator_raw;
SELECT to_regclass('public.xxx_tl002_thumbnail_jobs') AS old_thumbnail_jobs;
```

View変更前には、変更前後の件数を比較する。

```sql
SELECT count(*) FROM public.xxx_vq002_owned_product_ids;
SELECT count(*) FROM public.xxx_tm002_owned_files WHERE status = 'owned';
```

`TRUNCATE`, `DROP`, 既存カラム削除は行わない。必要な整理は、追加テーブル、追加View、`run_id` 絞り込み、または明示承認された例外として扱う。
## 2026-05-16 実行済み: FC2 Wiki販売者軸・サムネイル状態DB

`rules.md` の破壊的変更禁止に合わせ、既存テーブルの削除や `TRUNCATE` は行わず、追加テーブルと追加ビューで対応した。

実行済みオブジェクト:

- `xxx_tm009_fc2_wiki_thumbnail_assets`
- `xxx_tl003_fc2_wiki_thumbnail_runs`
- `xxx_tl004_fc2_wiki_thumbnail_run_items`
- `xxx_vq026_wiki_article_master_enriched`
- `xxx_vq027_wiki_seller_summary_display`
- `xxx_vq028_wiki_seller_missing_products`
- `xxx_vq029_owned_file_thumbnail_status`
- `xxx_vq030_rapidgator_wiki_display`

採番方針:

- `TM006` はFC2記事ページ補完系で使用済みのため、サムネイル状態テーブルは `TM009` にした。
- `VQ026` 以降はRapidgator系 `VQ025` の次の空き番号として使用した。

運用方針:

- Seller Completionは `xxx_vq027_wiki_seller_summary_display` と `xxx_vq028_wiki_seller_missing_products` を参照し、FC2 Wiki由来の販売者名を表示軸にする。
- Local Libraryは `xxx_vq029_owned_file_thumbnail_status` を参照し、所持ファイルに対するサムネイル有無を扱う。
- Rapidgator Researchは `xxx_vq030_rapidgator_wiki_display` を参照し、Rapidgator候補にFC2 Wiki基準の販売者名とサムネイル状態を付与する。
- サムネイル実体は `fc2_sum` 配下に保存し、DBにはフルパスとファイル名を保持する。

自動取得:

- `fc2_wiki_thumbnail_collector_operational.js` が `xxx_vq029_owned_file_thumbnail_status` を入力にして、所持作品優先でサムネイルを取得する。
- 既定では1回100件まで、2.5秒から5.5秒のランダム間隔を置く。
- 成功は `thumbnail_status = 'collected'`、失敗は `thumbnail_status = 'failed'`、URL欠損・不許可は `thumbnail_status = 'missing_url'` として `xxx_tm009_fc2_wiki_thumbnail_assets` に記録する。
- 実行単位は `xxx_tl003_fc2_wiki_thumbnail_runs.run_id` で記録し、対象ごとの結果は `xxx_tl004_fc2_wiki_thumbnail_run_items` に記録する。
