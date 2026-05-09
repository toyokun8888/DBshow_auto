# DB Verification SQL

このファイルは、DB側で作成済みオブジェクトと初期移行候補を確認するためのSQLメモです。

ここにあるSQLは確認用です。`INSERT` は含めていません。

## 1. 作成済みオブジェクト確認

```sql
SELECT to_regclass('public.xxx_vq001_moviemaster_unique') AS vq001;
SELECT to_regclass('public.xxx_tm002_owned_files') AS tm002;
SELECT to_regclass('public.xxx_tl001_file_process_logs') AS tl001;
SELECT to_regclass('public.xxx_tm003_seller_groups') AS tm003;
SELECT to_regclass('public.xxx_tm004_seller_aliases') AS tm004;
SELECT to_regclass('public.xxx_tm005_unmatched_files') AS tm005;
```

## 2. 一意化済みマスターView確認

```sql
SELECT
    COUNT(*) AS total_count,
    COUNT(product_id) AS product_id_count,
    COUNT(DISTINCT product_id) AS distinct_product_id_count
FROM public.xxx_vq001_moviemaster_unique;
```

期待値:

- `total_count = product_id_count = distinct_product_id_count`

## 3. 新規テーブルの空状態確認

```sql
SELECT COUNT(*) AS owned_files_count
FROM public.xxx_tm002_owned_files;

SELECT COUNT(*) AS file_process_logs_count
FROM public.xxx_tl001_file_process_logs;

SELECT COUNT(*) AS seller_groups_count
FROM public.xxx_tm003_seller_groups;

SELECT COUNT(*) AS seller_aliases_count
FROM public.xxx_tm004_seller_aliases;

SELECT COUNT(*) AS unmatched_files_count
FROM public.xxx_tm005_unmatched_files;
```

期待値:

- 作成直後はすべて `0`

## 4. 初期移行候補の件数確認

`testcsv.action = 'Moved+Renamed'` のうち、マスターViewと一致する候補だけを数える。

```sql
SELECT
    COUNT(*) AS moved_renamed_total,
    COUNT(m.product_id) AS matched_master_count,
    COUNT(*) - COUNT(m.product_id) AS not_matched_master_count
FROM public.testcsv t
LEFT JOIN public.xxx_vq001_moviemaster_unique m
    ON m.product_id = t.number::text
WHERE t.action = 'Moved+Renamed';
```

## 5. 初期移行ドライラン確認

実データ投入前に、このSELECT結果を確認する。

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
JOIN public.xxx_vq001_moviemaster_unique m
    ON m.product_id = t.number::text
WHERE t.action = 'Moved+Renamed'
ORDER BY t.id
LIMIT 100;
```

## 6. パス正規化の確認

`D:all_fc2...` や `K:all_fc2...` のような `\` 欠けが、`D:\all_fc2...` / `K:\all_fc2...` に直る候補を確認する。

```sql
SELECT
    t.pathid,
    COUNT(*) AS target_count
FROM public.testcsv t
JOIN public.xxx_vq001_moviemaster_unique m
    ON m.product_id = t.number::text
WHERE t.action = 'Moved+Renamed'
  AND t.newpath ~ '^[A-Z]:[^\\]'
GROUP BY t.pathid
ORDER BY t.pathid;
```

```sql
SELECT
    t.id,
    t.newpath AS before_path,
    regexp_replace(t.newpath, '^([A-Z]):', '\1:\\') AS after_path
FROM public.testcsv t
JOIN public.xxx_vq001_moviemaster_unique m
    ON m.product_id = t.number::text
WHERE t.action = 'Moved+Renamed'
  AND t.newpath ~ '^[A-Z]:[^\\]'
ORDER BY t.id
LIMIT 50;
```

## 7. 枝番と重複候補の確認

```sql
WITH candidate AS (
    SELECT
        t.id,
        t.number AS product_id,
        t.newfilename,
        CASE
            WHEN t.newfilename ~ '[-_][0-9]{1,2}\.mp4$'
                THEN 'part_suffix'
            WHEN t.newfilename ~ '\([0-9]+\)\.mp4$'
                THEN 'duplicate_suffix'
            ELSE 'no_suffix'
        END AS suffix_type
    FROM public.testcsv t
    JOIN public.xxx_vq001_moviemaster_unique m
        ON m.product_id = t.number::text
    WHERE t.action = 'Moved+Renamed'
)
SELECT
    suffix_type,
    COUNT(*) AS count
FROM candidate
GROUP BY suffix_type
ORDER BY suffix_type;
```

## 8. 同一パス候補の確認

`current_path` にUNIQUE制約は付けない方針だが、完全同一パスがあるか確認する。

```sql
WITH candidate AS (
    SELECT
        CASE
            WHEN t.newpath ~ '^[A-Z]:[^\\]' THEN
                regexp_replace(t.newpath, '^([A-Z]):', '\1:\\')
            ELSE
                t.newpath
        END AS normalized_current_path
    FROM public.testcsv t
    JOIN public.xxx_vq001_moviemaster_unique m
        ON m.product_id = t.number::text
    WHERE t.action = 'Moved+Renamed'
)
SELECT
    normalized_current_path,
    COUNT(*) AS count
FROM candidate
GROUP BY normalized_current_path
HAVING COUNT(*) > 1
ORDER BY count DESC, normalized_current_path
LIMIT 100;
```

