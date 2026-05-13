# Rapidgator フォルダページ収集 設計図

## 目的

Rapidgator のフォルダページを複数ページ巡回し、ページ内のファイル一覧をCSVとして取得する。

いきなりDBには入れず、まずCSVに保存する。

その後、CSVをPostgreSQLに取り込み、SQLでクレンジング・正規化・照合・集計を行う。

---

# 全体方針

## 安全優先

- 直接DBへINSERTしない
- まずCSVへ出力する
- CSV確認後にDB投入する
- DB投入後にSQLで調理する
- 取得時点で完璧な正規化は狙わない
- ただし、後工程で楽になるグループ推測列はCSV時点で作る

---

# 対象URL

## 基本URL

```text
https://rapidgator.net/folder/3330879/movie.html?page=372
URL構造
https://rapidgator.net/folder/{folder_id}/{folder_name}.html?page={page_number}
今回の値
folder_id   = 3330879
folder_name = movie
page_number = 372
複数ページ巡回

ページ番号を変えながら取得する。

https://rapidgator.net/folder/3330879/movie.html?page=1
https://rapidgator.net/folder/3330879/movie.html?page=2
...
https://rapidgator.net/folder/3330879/movie.html?page=372

開始ページ・終了ページは設定で変更できるようにする。

HTML構造
ファイル一覧テーブル
<table class="items">
  <thead>
    <tr>
      <th id="grid_c0">名前</th>
      <th id="grid_c1">Sort by date</th>
    </tr>
  </thead>
  <tbody>
    <tr class="odd">
      ...
    </tr>
    <tr class="even">
      ...
    </tr>
  </tbody>
</table>
1ファイル分の構造
<tr class="odd">
  <td>
    <a href="/file/e6ba05df268725ec0a235b3063dbbe27/WANZ-227.part1.rar.html">
      <img src="/images/filemanager/file_small.png">
      WANZ-227.part1.rar
    </a>
  </td>
  <td class="td-for-select">500 MB</td>
</tr>
取得対象
基本取得項目
source_page_url
page_number
row_index_in_page
file_title
file_url
file_size
追加メタ項目
folder_id
folder_name
file_ext
collected_at
グルーピング補助項目
group_key
group_rule
fc2_product_id
CSV出力方針
master CSV

正常取得したデータを保存する。

5万件ごとに分割する。

例：

rapidgator_master_YYYYMMDDHHMMSS_part001.csv
rapidgator_master_YYYYMMDDHHMMSS_part002.csv
rapidgator_master_YYYYMMDDHHMMSS_part003.csv
error CSV

取得失敗や異常を保存する。

例：

rapidgator_error_YYYYMMDDHHMMSS.csv
progress CSV

処理済みページを記録する。

例：

rapidgator_progress_YYYYMMDDHHMMSS.csv
予定CSVカラム
source_page_url
folder_id
folder_name
page_number
row_index_in_page
file_title
file_url
file_size
file_ext
group_key
group_rule
fc2_product_id
collected_at
各カラムの意味
source_page_url

取得元ページURL。

例：

https://rapidgator.net/folder/3330879/movie.html?page=372
folder_id

Rapidgator のフォルダID。

例：

3330879
folder_name

Rapidgator のフォルダ名。

例：

movie
page_number

取得元ページ番号。

例：

372
row_index_in_page

そのページ内での行番号。

1から開始。

例：

1
2
3
file_title

aタグ内のテキスト。

DB照合用として最重要。

例：

FC2PPV-4858872.mp4
file_url

ファイルページURL。

相対URLではなく、絶対URLで保存する。

例：

https://rapidgator.net/file/1f403731ad800165de180ca7ddaa923b/FC2PPV-4858872.mp4.html
file_size

ページ上に表示されているサイズ文字列をそのまま保存する。

例：

1.35 GB
500 MB
file_ext

ファイル拡張子。

例：

mp4
rar
avi
wmv
group_key

ファイル名から推測したグループ名。

例：

FC2PPV-
MOSAIC-ARCHIVE-
heyzo-
-paco
-carib
heydouga4017-
group_rule

どのルールで group_key を決めたか。

例：

prefix_alpha_hyphen
suffix_alpha_after_hyphen
unknown
fc2_product_id

FC2PPV系のファイルのみ、数値部分を抽出する。

例：

FC2PPV-4858872.mp4

なら：

4858872

FC2PPV以外は空欄にする。

DB投入後はNULL扱いにする。

collected_at

取得日時。

例：

2026-05-13T18:30:00.000Z
グルーピングルール
基本方針

取得時点では完全な正規化を狙わない。

ただし、後でSQLクレンジングしやすいように、推測グループを1列持たせる。

ルール1: 前方一致型

ファイル名の先頭に、文字列 + ハイフンでグループがあるもの。

例
FC2PPV-4858872.mp4
MOSAIC-ARCHIVE-aarm-262.mp4
heyzo-3798.mp4
heydouga4017-150-1.part01.rar
group_key
FC2PPV-
MOSAIC-ARCHIVE-
heyzo-
heydouga4017-
group_rule
prefix_alpha_hyphen
ルール2: 後方判定型

ファイル名の前半が数字中心で、末尾側に -文字列 があるもの。

例
030526_100-paco.mp4
030626-001-carib.mp4
group_key
-paco
-carib
group_rule
suffix_alpha_after_hyphen
ルール3: 判定不能

前方一致型にも後方判定型にも当てはまらないもの。

group_key

空欄

group_rule
unknown
FC2PPV 特殊処理
対象表記

以下のような表記ゆれを対象にする。

FC2PPV-
fc2ppv-
FC2-PPV-
fc2-ppv-
FC2PPV
fc2ppv

判定時は大文字小文字を無視する。

抽出例
FC2PPV-4858872.mp4
fc2_product_id
4858872
FC2PPV以外の fc2_product_id

CSV上では空欄。

DB投入後はNULL。

理由
0は値として意味を持ってしまう
NULLなら「該当なし」と明確に扱える
数値型でもNULLは使える
JOIN時に誤マッチしにくい
SQLで IS NULL / IS NOT NULL が使いやすい
取得対象ファイル種別

現時点では拡張子で絞らず、ページ上にあるものを取得する。

例：

mp4
rar
avi
wmv

理由：

生データとしてまず全部取る
DB投入後にSQLで絞り込み・分類する
rar分割ファイルもグルーピングに使える可能性がある
実装工程
Step 1: 設計図確定

このドキュメントで構造・方針を確定する。

Step 2: サンプルCSV確認

実装前に、想定カラムでサンプルデータを作る。

DB側の既存データとマッチしやすいか確認する。

Step 3: JS作成

既存の安全設計JSを参考にする。

取り入れる要素：

master CSV
error CSV
progress CSV
途中再開
リトライ
ランダム待機
自動停止
headless切替
5万件ごとのCSV分割
Step 4: 小規模テスト

数十件だけ取得する。

確認項目：

カラム漏れがないか
file_title が正しく取れているか
file_url が絶対URLになっているか
file_size が取れているか
group_key が意図通りか
fc2_product_id がFC2PPV系だけ取れているか
progress/error が出ているか
Step 5: 修正

テスト結果に合わせてJSを修正する。

Step 6: DB投入用テーブル作成

確定CSVに合わせてPostgreSQL側の受け皿テーブルを作る。

この時点で型を決める。

fc2_product_id は、既存マスター側の型確認後に合わせる。

ただし、NULL許可にする。

Step 7: JS本運用

対象ページを本番取得する。

CSVは5万件ごとに分割する。

Step 8: CSVをDBへ投入

CSVをPostgreSQLへ取り込む。

Step 9: SQLでクレンジング・照合

DB投入後にSQLで以下を行う。

重複確認
group_key補正
FC2PPV ID照合
拡張子別分類
分割RAR整理
既存マスターとのJOIN
所持/未所持判定への応用
ここまでの到達点

この設計により、やりたいことの9割は以下で完成する。

Rapidgator全件取得
↓
CSV安全保存
↓
DB投入
↓
SQLで調理可能な状態

次はこの設計に合わせて、**サンプルCSVデータ**を出します。