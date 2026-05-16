# FC2 ローカルライブラリ / Seller Completion システム 現状整理メモ

## 概要

現在、FC2 系コンテンツを対象に、

* ローカル所持ファイル
* マスターDB
* ダウンロード可能リンク
* 未所持一覧
* 自動整理
* 自動補完

を連携するシステムを構築中。

目的は、

「持っているのに再DLしてしまう事故を防ぐ」
「DL → 整理 → DB更新 → UI反映までを自動化する」

こと。

---

# 現在できていること

## 1. ローカル所持ファイルの抽出

PowerShell により、

* 全階層の `.mp4`
* FC2 系 product_id（7桁）
* フルパス
* ファイル名

をCSVへ抽出可能。

例：

```powershell
FC2-PPV-1550704.mp4
↓
1550704
```

抽出結果は PostgreSQL に投入済み。

---

## 2. ローカル所持テーブル

### テーブル

```sql
local_mp4_ids_raw
```

### 内容

ローカルファイルスキャン結果。

保持内容：

* product_id
* file_name
* full_path
* file_size
* last_write_time

など。

---

## 3. FC2 マスター

### マスター系

```sql
master
```

または

```sql
xxx_vq001_moviemaster_unique
```

### 主な列

```sql
product_id
title
seller_id
```

---

## 4. Rapidgator 収集テーブル

### テーブル

```sql
xxx_tl002_rapidgator_raw
```

### 内容

Rapidgator の収集結果。

保持内容：

* file_title
* file_url
* page_number
* fc2_product_id
* file_ext
* file_size

など。

---

# 現在の重要VIEW

## 1. 所持済み product_id VIEW

### VIEW

```sql
xxx_vq002_owned_product_ids
```

### 役割

「現在所持している product_id 一覧」

未所持判定の基準。

---

## 2. Seller Completion 用 未所持VIEW

### ベースロジック

```sql
SELECT seller_id,
       product_id,
       title
FROM xxx_vq001_moviemaster_unique m
WHERE EXISTS (
    SELECT 1
    FROM xxx_vq002_owned_product_ids o
    JOIN xxx_vq001_moviemaster_unique mm
      ON mm.product_id = o.product_id::text
    WHERE mm.seller_id = m.seller_id
)
AND NOT EXISTS (
    SELECT 1
    FROM xxx_vq002_owned_product_ids o2
    WHERE o2.product_id::text = m.product_id
);
```

### 意味

「同じ seller の作品は持っているが、
この作品だけ未所持」

を抽出。

---

## 3. 実ファイル存在チェックVIEW

### VIEW

```sql
xxx_v_local_mp4_exists_master
```

### 役割

master に存在し、
かつ local_mp4_ids_raw にも存在するもの。

つまり、

```text
未所持判定だけど、
実はローカルに存在している候補
```

を抽出。

---

# 今回の重要進展

## 実ファイル候補の可視化

Seller Completion UI に、

```text
実ファイル候補あり
```

を表示可能になった。

これにより、

```text
未所持一覧に出ている
↓
でも実はローカルに存在していた
↓
再DL事故を防げる
```

ようになった。

---

# 現在の分類

## A. master にある + 実ファイルあり

約600件前後。

### 状態

* master登録済み
* ローカルにも存在
* しかし所持判定には未反映

### 原因

ファイル名揺れ
リネーム前
DB未同期
など。

---

## B. master にない + 実ファイルあり

約1000件前後。

### 状態

ローカルには存在するが、
master にレコードが無い。

### 原因

master 側不足。

現在補完作業中。

---

# 重要な理解

現在のVIEW群は動的。

つまり、

```text
master が増える
↓
VIEW結果が自動変化
```

する。

そのため、

```text
A:600 / B:1000
```

だったものが、

```text
A:800 / B:800
```

のように変動していく可能性がある。

---

# UI 現状

## Seller Completion

### 役割

seller ごとの未所持確認。

### 機能

* seller一覧
* completion rate
* Rapidgator リンク
* mp4 / rar 判定
* 実ファイル候補表示

---

## 色分け

### 緑

```text
実ファイル候補あり
```

### 意味

再DL注意。

---

## Local Library ページ

### 機能

既に所持判定済みの一覧。

### 実装済み

* Open file
* Open folder
* MPC-BE などで直接再生
* Explorer でフォルダを開く

---

# API 現状

## Seller Completion API

### 一覧

```http
/api/seller-summary
```

### seller別未所持

```http
/api/seller-missing/:sellerId
```

---

## Local Library API

### ファイルを開く

```http
/api/library/open-file
```

### フォルダを開く

```http
/api/library/open-folder
```

---

# 安全設計

## MEDIA_ALLOWED_ROOTS

`.env`

```env
MEDIA_ALLOWED_ROOTS=
```

で許可フォルダを制御。

許可フォルダ配下のみ、

* Open file
* Open folder

を許可。

---

# PM2 自動化

## master 補完

毎時実行。

### 目的

master 差分取得。

### 状態

PM2 による定期実行構築済み。

---

# 今後実装したいこと

## 1. Rapidgator 差分更新自動化

DL可能リンクも日々増えるため、

```text
どの作品がDL可能か
```

を自動更新したい。

---

## 2. 自動リネーム / 自動フォルダ分け

現在構築中。

### 内容

ローカルファイル名を master に問い合わせ、

* 正規化
* リネーム
* seller別フォルダ分け

を自動実行。

---

## 3. 定時実行

毎日定時で：

* リネーム
* 分類
* DB更新

を自動実行。

---

# 最終目標

## 完全自動循環

```text
master補完
↓
DL可能リンク補完
↓
DL可能リスト生成
↓
自動DL
↓
一時DLフォルダへ集約
↓
自動リネーム
↓
自動フォルダ分け
↓
DB更新
↓
所持/未所持UI更新
```

を毎日自動循環。

---

# 将来的なUI拡張

## 新着可視化

例：

* 3日以内取得
* 7日以内取得

などで色変更。

### 目的

最新作の視認性向上。

---

# 現在の重要方針

今回の実装では、

```text
未所持判定ロジック自体は壊さない
```

ことを重視。

その上で、

```text
実は持っている可能性
```

を UI で停止確認できる仕組みを追加。

これは、

```text
安全確認を優先した拡張
```

として非常に重要。

---

# 2026-05-16 Webアプリ現行仕様

この節は、現在のローカルWebアプリが実際に読むDBオブジェクトとAPIの対応を整理したもの。コードは変更せず、現行仕様として記録する。

## 全体方針

このWebアプリは、自分専用のローカル運用アプリとして以下を統合する。

- Local Library: 所持済みローカルファイルの確認と再生/フォルダ表示。
- Seller Completion: 販売者ごとの所持/未所持と補完候補の確認。
- Rapidgator Research: Rapidgator収集結果のグループ確認。
- FC2 article collector: 既存 `master` の穴をFC2記事ページから補完する。

現時点では複数の方向の機能が混在しているが、中心は「自分専用Webアプリを充実させること」である。

## APIとDB対応

### `/api/seller-summary`

用途:

- Seller Completion の販売者一覧。
- 販売者ごとの総作品数、所持数、未所持数を表示する。

参照DB:

- `xxx_vq013_owned_seller_summary_display`

主な列:

- `seller_id`
- `seller_name`
- `total_products`
- `owned_products`
- `missing_products`

依存関係:

- `xxx_vq010_owned_seller_summary`
- `xxx_vq012_seller_display`

### `/api/seller-missing/:sellerId`

用途:

- 指定販売者の未所持作品一覧。
- Rapidgator候補、ローカルMP4候補、所持済み判定を合わせて表示する。

参照DB:

- `xxx_vq001_moviemaster_unique`
- `xxx_vq002_owned_product_ids`
- `xxx_vq025_rapidgator_best_links`
- `xxx_v_local_mp4_exists_master`

主な役割:

- `xxx_vq001_moviemaster_unique`: 作品マスター。
- `xxx_vq002_owned_product_ids`: 所持済み `product_id` 判定。
- `xxx_vq025_rapidgator_best_links`: 欠品に対するRapidgator候補。
- `xxx_v_local_mp4_exists_master`: masterにはあり、ローカルMP4スキャンにも存在する実ファイル候補。

注意:

- `xxx_vq002_owned_product_ids` は legacy `testcsv` と `xxx_tm002_owned_files` を混ぜている。
- `xxx_v_local_mp4_exists_master` は命名規約上の `xxx_VQ###_...` 形式ではないため、既存互換として残すか、将来リネームするか要決定。

### `/api/rapidgator/groups`

用途:

- Rapidgator Research の左側グループ一覧。

参照DB:

- `xxx_vq023_rapidgator_group_summary`

グループ単位:

- `normalized_group_key`

主な列:

- `normalized_group_key`
- `sample_group_rule`
- `total_records`
- `distinct_file_title_count`
- `distinct_base_title_count`
- `distinct_url_count`
- `source_page_count`
- `fc2_record_count`
- `distinct_fc2_product_count`
- `mp4_count`
- `mkv_count`
- `avi_count`
- `wmv_count`
- `rar_count`
- `part_record_count`
- `sample_file_title`
- `sample_file_url`
- `file_ext_list`

### `/api/rapidgator/group/:groupKey/items`

用途:

- Rapidgator Research のグループ内アイテム一覧。
- base title単位で、mp4/rar/part構成やURL一覧を表示する。

参照DB:

- `xxx_vq022_rapidgator_base_title_summary`

集計単位:

- `base_title_without_part`

主な列:

- `base_title_without_part`
- `normalized_group_key`
- `normalized_group_rule`
- `fc2_product_id`
- `total_records`
- `distinct_url_count`
- `source_page_count`
- `mp4_count`
- `mkv_count`
- `avi_count`
- `wmv_count`
- `rar_count`
- `part_record_count`
- `min_part_no`
- `max_part_no`
- `availability_type`
- `sample_file_title`
- `sample_file_url`
- `file_title_list`
- `file_url_list`

### `/api/library/items`

用途:

- Local Library の所持済みファイル一覧。
- サムネイル、作品タイトル、販売者グループ、ファイルパスを合わせて表示する。

参照DB:

- `xxx_tm002_owned_files`
- `xxx_vq001_moviemaster_unique`
- `xxx_tm003_seller_groups`
- `xxx_tm006_thumbnail_assets` 予定

注意:

- 実DBには `xxx_tm006_thumbnail_assets` が存在しない。
- 現行コードはテーブル未作成時にfallbackし、`thumbnail_path` は空、`collect_status` は `unknown` として扱う。
- `TM006` は既にFC2記事ページ補完マスターで使用済みのため、サムネイル資産テーブル名は再検討が必要。

### `/api/library/open-file` と `/api/library/open-folder`

用途:

- Local Library / Seller Completion から実ファイルまたはフォルダを開く。

参照DB:

- `xxx_tm002_owned_files`

安全設定:

- `.env` の `MEDIA_ALLOWED_ROOTS` 配下だけを許可する。
- Seller Completion からは `fullPath` をpayloadで渡す経路もあるため、許可rootの管理が重要。

## FC2記事ページ補完バッチ

対象コード:

- `fc2_article_collector_operational.js`

用途:

- 既存 `master` の穴を補完するため、FC2記事ページを収集する。
- 収集結果を `xxx_tm006_fc2_article_master_full_stage` と `xxx_tm006_fc2_article_master_import_stage` に入れる。
- 差分を `master` と `xxx_tm006_fc2_article_master_full` へ登録する。

関連DB:

- `master`
- `xxx_tm006_fc2_article_master_full`
- `xxx_tm006_fc2_article_master_full_stage`
- `xxx_tm006_fc2_article_master_import_stage`

注意:

- 現行はstage初期化に `TRUNCATE TABLE` を使う。
- `rules.md` では `TRUNCATE` 禁止のため、今後は `run_id` 付きステージ方式などへ整理する。
- PM2設定により定期実行される構成があるため、運用前にDB書き込み設定を確認する。

## Rapidgatorデータフロー

元データ:

- `xxx_tl002_rapidgator_raw`

正規化:

- `xxx_vq020_rapidgator_group_normalized`

UI向け集計:

- `xxx_vq022_rapidgator_base_title_summary`
- `xxx_vq023_rapidgator_group_summary`
- `xxx_vq025_rapidgator_best_links`

意味:

- `normalized_group_key`: Rapidgatorのファイル群をUIでまとめるための正規化グループキー。
- `base_title_without_part`: part番号などを除いたベースタイトル。
- `sample_file_url`: グループまたはbase title内の代表URL。
- `file_url_list`: base titleに属するURLを連結した一覧。
- `availability_type`: `media_only`, `rar_only`, `media_and_rar`, `other` のような取得可能性分類。

## ローカルMP4候補

元データ:

- `local_mp4_ids_raw`

UI向けビュー:

- `xxx_v_local_mp4_exists_master`

意味:

- ローカルスキャンで見つかったMP4候補のうち、`master` に存在する `product_id` を表示する。
- Seller Completion の未所持一覧で「実はローカルに存在する可能性」を確認するために使う。

未決定:

- この候補を `xxx_tm005_unmatched_files` に連動登録するか。
- 既存ビュー名を規約準拠の `xxx_vq###_local_mp4_exists_master` に移すか。

## 未作成/要整理

### サムネイルDB

現状:

- `xxx_tm006_thumbnail_assets` は実DB未作成。
- `xxx_tl002_thumbnail_jobs` は実DB未作成。

整理方針:

- `TM006` はFC2記事ページ補完マスターで使用済み。
- `TL002` はRapidgator rawログで使用済み。
- サムネイル系は次の空き番号に変更する案が安全。

### 所持判定View

現状:

- `xxx_vq002_owned_product_ids` は legacy `testcsv` と `xxx_tm002_owned_files` を `UNION` している。

整理方針:

- Webアプリの所持判定を完全に `xxx_tm002_owned_files` ベースへ寄せるかは要確認。
- すぐ変更するとSeller Completionの所持/未所持数が変わるため、まずは件数比較と資料整理を優先する。
## 2026-05-16 追記: 所持リストのFC2 Wikiサムネイル表示

Local Libraryの所持リストは、旧予定の `xxx_tm006_thumbnail_assets` ではなく、現行DBで作成済みの `xxx_vq029_owned_file_thumbnail_status` を参照する。

- `thumbnailPath` はローカルサムネイルが存在する場合だけ `/api/library/thumbnail/{product_id}` として返す。
- ブラウザにはローカル実パスを直接渡さず、Vite middlewareが `xxx_tm009_fc2_wiki_thumbnail_assets.local_thumbnail_path` を解決して画像を返す。
- 画像配信は `THUMBNAIL_ALLOWED_ROOTS` が設定されていればその配下、未設定ならプロジェクト直下の `fc2_sum` 配下だけを許可する。
- カードのレイアウトは変えず、既存のサムネイル枠に画像だけを表示する。
- `collectStatus` は `collected`, `pending`, `missing_url`, `failed`, `queued`, `unknown` を扱う。

Seller Completionの販売者一覧は、`xxx_vq027_wiki_seller_summary_display` を参照し、FC2 Wiki由来の販売者名を主軸にする。販売者別の未所持一覧は `xxx_vq028_wiki_seller_missing_products` を起点にして、既存どおりRapidgator候補とローカルMP4候補を付与する。

Rapidgator Researchの右側リストは、`xxx_vq030_rapidgator_wiki_display` を参照する。`fc2_product_id` をFC2 Wiki結合ビューへつなぎ、Seller Completionと同じ `wiki_seller_name` を表示する。サムネイル取得済みの作品は、Local Libraryと同じ `/api/library/thumbnail/{product_id}` 経由で表示する。

## 2026-05-16 追記: サムネイル自動取得

本番用スクリプトは `fc2_wiki_thumbnail_collector_operational.js`。

- 対象はまず `xxx_vq029_owned_file_thumbnail_status` の所持作品を優先する。
- 1回の上限は `FC2_THUMB_COLLECT_MAX_DOWNLOADS`、既定値は100件。
- `goals.md` / `requirements_and_schedule.md` の「1日100枚程度」に合わせ、既定値では100件を超えない。
- 取得間隔は `FC2_THUMB_COLLECT_MIN_DELAY_MS` から `FC2_THUMB_COLLECT_MAX_DELAY_MS` のランダム待機。既定値は2.5秒から5.5秒。
- 許可するURLは `https://contents-thumbnail2.fc2.com/` のみ。
- 保存先は `fc2_sum` 配下、命名は `{product_id}.{ext}`。
- 既存ファイルは上書きしない。既存の非空ファイルがあればDBだけ `collected` に合わせる。
- 成功・失敗・試行回数・最終エラーは `xxx_tm009_fc2_wiki_thumbnail_assets` に保存する。
- 実行単位の集計は `xxx_tl003_fc2_wiki_thumbnail_runs`、対象ごとの結果は `xxx_tl004_fc2_wiki_thumbnail_run_items` に保存する。
- 既定では確認フラグが `NO` のため、実行時は `FC2_THUMB_COLLECT_CONFIRM_DOWNLOAD=YES` と `FC2_THUMB_COLLECT_CONFIRM_DB_WRITE=YES` を明示する。
- `downloaded_at >= CURRENT_DATE` の当日成功数を見て、`FC2_THUMB_COLLECT_DAILY_CAP` 既定100件を超えない。
