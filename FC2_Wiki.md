# FC2 Wiki補完サブマスター 要件定義 / 設計概要

---

# 目的

既存FC2マスターDBを破壊・変更せず、  
不足している販売者情報・作品情報・サムネイル情報を補完するための  
「wiki由来補完レイヤー」を追加する。

本設計は既存master系テーブルの補助層として機能し、  
既存システムへの影響を最小限に抑えることを目的とする。

---

# 基本思想

## 既存masterを主とする

既存の以下を主データとして扱う。

- master
- xxx_vq001_moviemaster_unique
- sellers
- seller_names
- xxx_tm006_fc2_article_master_full

今回追加するwiki系テーブルは、あくまで：

- 補完
- 不足検知
- サムネイル収集
- 販売者索引

用途に限定する。

既存テーブルの更新・置換を目的としない。

---

# 今回の取得元

## 対象サイト

https://av-help.memo.wiki/

---

# 使用するページ種別

## 1. 販売者一覧ページ

例：

https://av-help.memo.wiki/d/FC2PPV%a5%ea%a5%b9%a5%c8%b0%ec%cd%f7

用途：

- FC2販売者一覧取得
- 人気販売者取得
- 過去販売者取得
- 販売者URL索引化

---

## 2. 販売者作品ページ

例：

https://av-help.memo.wiki/d/KING%20POWER%20D

用途：

- 作品一覧取得
- タイトル取得
- サムネイルURL取得
- FC2 article URL取得

---

## 3. 差分ページ

例：

https://av-help.memo.wiki/diff/KING%20POWER%20D

用途：

- 過去差分取得
- 削除済み作品補完
- 更新履歴取得

※ diffページは補助用途とする。

---

# URL構造

## 販売者ページ

/d/{encoded seller name}

---

## 差分ページ

/diff/{encoded seller name}

---

# 日本語URL

日本語販売者はURLエンコードされる。

例：

/%a5%cf%a5%e9%a5%de...

そのため：

- display_name
- wiki_url
- wiki_path

を分離保持する。

---

# product_id設計

## 最重要JOINキー

既存masterでは：

product_id = text

かつ実データは：

- 1000000
- 4899070

などの数値文字列形式。

---

# 正規化ルール

入力例：

- FC2-PPV-4899070
- fc2ppv-4899070
- aid=4899070

内部正規化：

4899070

---

# リレーション方針

## 接続先

主に：

xxx_vq001_moviemaster_unique.product_id

へJOINする。

理由：

- 重複整理済み
- title補正済み
- master補助ビューとして安定

---

# seller連携思想

今回のwiki sellerは：

wiki側 display seller

として扱う。

既存 seller_id への厳密alias統合は今回行わない。

---

# seller連携方針

今回は：

seller_name ベース

で十分と判断。

理由：

- 補助レイヤー用途
- 欠損補完用途
- 完全正規化が目的ではない

---

# サムネイル取得思想

## 取得方式

HTML内：

```html
<img src="https://contents-thumbnail2.fc2.com/...jpg">
```

から thumbnail_url を抽出。

---

# 取得方法

thumbnail_url
↓
HTTP GET
↓
ローカル保存

---

# 手動検証結果

PowerShellによる単体DLテスト成功。

使用コマンド：

```powershell
Invoke-WebRequest -Uri "https://contents-thumbnail2.fc2.com/..." -OutFile "C:\temp\fc2_thumb_test.jpg"
```

---

# 検証済み事項

確認済み：

- 直接HTTP GET可能
- 認証不要
- Referer不要
- ローカル保存可能
- 画像破損なし

---

# サムネイル保存思想

## 外部URL直参照は主用途にしない

理由：

- 外部サイト依存回避
- 表示高速化
- 将来的なURL消失対策
- localhost運用最適化

---

# ローカル保存方式

推奨：

{product_id}.jpg

例：

4899070.jpg

---

# サムネイル運用

## 段階取得方式

いきなり全件DLは行わない。

推奨フロー：

1. URLのみ収集
2. pendingのみ少量DL
3. failed再試行

---

# 新規追加テーブル

## 1. 販売者サブマスター

xxx_tm007_fc2_wiki_sellers

役割：

wiki由来販売者索引

---

## 2. 作品サブマスター

xxx_tm008_fc2_wiki_articles

役割：

wiki由来作品補完

---

# テーブル定義

## xxx_tm007_fc2_wiki_sellers

```sql
CREATE TABLE IF NOT EXISTS xxx_tm007_fc2_wiki_sellers (
    id BIGSERIAL PRIMARY KEY,
    seller_name TEXT NOT NULL,
    wiki_url TEXT NOT NULL,
    diff_url TEXT,
    wiki_path TEXT,
    source_list_url TEXT,
    source_section TEXT,
    seller_status TEXT,
    is_popular BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_archived BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    collected_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (wiki_url)
);
```

---

## xxx_tm008_fc2_wiki_articles

```sql
CREATE TABLE IF NOT EXISTS xxx_tm008_fc2_wiki_articles (
    id BIGSERIAL PRIMARY KEY,
    wiki_seller_id BIGINT REFERENCES xxx_tm007_fc2_wiki_sellers(id),
    product_id TEXT NOT NULL,
    product_id_raw TEXT,
    title TEXT,
    seller_name TEXT,
    fc2_url TEXT,
    thumbnail_url TEXT,
    source_wiki_url TEXT,
    source_type TEXT,
    row_status TEXT,
    local_thumbnail_path TEXT,
    thumbnail_status TEXT DEFAULT 'pending',
    collected_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (product_id, source_wiki_url)
);
```

---

# リレーション構造

```text
xxx_tm007_fc2_wiki_sellers
    1 : N
xxx_tm008_fc2_wiki_articles

xxx_tm008_fc2_wiki_articles.product_id
    ↓
xxx_vq001_moviemaster_unique.product_id
```

---

# 命名規則

既存ルールへ準拠：

xxx_tmXXX_...

を採用。

---

# 今回の到達点

今回完了済み：

- ページ構造調査
- URL規則確認
- サムネURL取得確認
- PowerShell単体DLテスト
- product_id正規化方針
- 既存masterとのJOIN方針
- seller補助思想
- テーブル設計
- 実テーブル作成

---

# 今後の実装フェーズ

開発側で行うもの：

- 販売者一覧巡回
- 販売者作品ページ解析
- diffページ解析
- thumbnail DL queue
- ローカル保存
- 差分検知
- 未所持補完UI

---

# 最終思想

今回構築するものは：

「新master」

ではなく、

「既存FC2 masterを補完する wiki由来補完レイヤー」

である。