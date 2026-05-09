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
