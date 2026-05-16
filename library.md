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
