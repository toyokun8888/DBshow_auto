# FC2 Article Scraping System Specification

## 概要

FC2 Adult Contents の検索ページを巡回し、作品情報を取得して PostgreSQL に蓄積するシステム。

目的は以下。

* master テーブルへ新規作品を安全に追加
* 完全版テーブルへ取得履歴を保存
* 将来的に PM2 による自動巡回へ移行
* 差分のみを毎日収集

---

# 対象サイト

検索ページ:

https://adult.contents.fc2.com/search/?&page=1

検索ページはログイン不要。

作品は新着順に近い順番で並ぶ。

---

# 取得対象HTML

## 作品カード

```html
div.c-cntCard-110-f
```

1ページあたり約33件。

---

# 取得項目

## product_id

取得元:

```html
<a class="c-cntCard-110-f_itemName"
   href="/article/4901193/">
```

抽出値:

```text
4901193
```

---

## title

取得元:

```html
<a class="c-cntCard-110-f_itemName"
   title="作品タイトル">
```

title属性を優先使用。

---

## seller_id

取得元:

```html
https://adult.contents.fc2.com/users/PLANETPLUS/
```

抽出値:

```text
PLANETPLUS
```

物理IDとして扱う。

---

## seller_name

取得元:

```html
プラネットプラス。
```

表示名として保存。

---

## price_text

取得元:

```html
2,800 pt
```

文字列そのまま保存。

---

## price_pt

price_text から数値抽出。

```text
2800
```

---

## article_url

生成値:

```text
https://adult.contents.fc2.com/article/{product_id}/
```

---

## collected_at

取得日時。

timestamp with time zone。

---

# DB構造

## master

既存テーブル。

```text
product_id
title
seller_id
```

---

## 完全版テーブル

```text
xxx_tm006_fc2_article_master_full
```

### カラム

```text
product_id
title
seller_id
seller_name
price_text
price_pt
article_url
search_page_url
page_number
row_index_in_page
collected_at
```

---

# stageテーブル

## 2026-05-16 注意

現行コードではstage初期化に `TRUNCATE TABLE` を使っているが、`rules.md` では `TRUNCATE` が禁止されている。ここは現状記録として残すが、今後の正式運用では以下のいずれかに整理する。

* `run_id` をstageに追加し、実行単位で対象行を絞る
* 実行ごとのtemporary tableを使う
* stage専用 `TRUNCATE` を明示例外としてユーザー承認する

推奨は `run_id` 付きstage方式。

## full stage

```text
xxx_tm006_fc2_article_master_full_stage
```

## import stage

```text
xxx_tm006_fc2_article_master_import_stage
```

役割:

* CSV投入用
* 重複確認
* master差分確認
* INSERT前検証

---

# CSV構造

## master投入用CSV

```csv
product_id,title,seller_id
```

---

## 完全版CSV

```csv
product_id,title,seller_id,seller_name,price_text,price_pt,article_url,search_page_url,page_number,row_index_in_page,collected_at
```

---

# JS構造

## 単ページ版

```text
fc2_article_collector_test.js
```

用途:

* selector確認
* CSV確認
* 単体テスト

---

## 複数ページ版

```text
fc2_article_collector_multi_test.js
```

用途:

* 複数ページ巡回
* CSV生成
* 重複確認
* stage投入テスト

---

# 差分抽出思想

検索ページには:

* 広告
* 再表示
* 過去作品

が含まれる。

そのため:

```text
取得件数 ≠ 新規作品数
```

となる。

---

# 唯一キー

唯一の真実は:

```text
product_id
```

title は揺れる可能性がある。

英語タイトルと日本語タイトルが混在するケースあり。

---

# INSERT思想

## master

既存 product_id は追加しない。

新規のみ追加。

---

## full

取得履歴として保存。

masterとの差分管理ではなく、取得作品管理テーブル。

---

# 実行フロー

```text
1. JSで検索ページ取得
2. CSV生成
3. stageテーブル初期化
   * 現行コードは `TRUNCATE`
   * 今後の推奨は `run_id` 付きstage方式
4. CSV投入
5. 重複確認
6. master既存照合
7. 新規件数確認
8. master INSERT
9. full INSERT
10. COMMIT
```

---

# 自動化予定

## 将来仕様

* PM2常駐
* 毎日定時実行
* DB最大product_id取得
* 検索ページ先頭の最新ID取得
* 差分のみ収集
* stage自動初期化
  * 現行コードは `TRUNCATE`
  * 今後の推奨は `run_id` 付きstage方式
* 自動INSERT
* ログCSV保存

---

# 安全思想

* いきなり本番INSERTしない
* 必ずstage経由
* product_id重複除外
* master既存除外
* BEGIN/ROLLBACKで検証
* COMMITは最後のみ
* CSVログ保存
* DB直接破壊操作禁止
