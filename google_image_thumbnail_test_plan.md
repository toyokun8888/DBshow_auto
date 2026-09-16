# Google画像検索サムネイル取得 実地試験計画

## 目的

Local Libraryで「所持済みだがサムネイル未取得」のFC2作品について、Google画像検索の1件目をサムネイル候補として取得する実地試験を行う。

まずは実装せず、この計画を確認してから進める。

## 前提

- 対象は現在のFC2動画所持作品に限定する。
- 既存のサムネイル状態は `xxx_tm009_fc2_wiki_thumbnail_assets` と `xxx_vq029_owned_file_thumbnail_status` を基準にする。
- 候補抽出は `xxx_vq029_owned_file_thumbnail_status` の `owned_without_thumbnail = true` 相当を使う。
- 検索クエリは `fc2 {product_id}` とする。例: `fc2 4923154`
- Google画像検索を使う場合、画像検索状態のURLを使う。例: `https://www.google.com/search?udm=2&q=fc2+4923154`
- 取得できた画像が一部誤っていても、ユーザー判断として一定の外れは許容する。
- ただし、後から追跡できるように検索結果URLと候補情報をCSVに残す。
- Google画像検索結果の1件目にある `/imgres?...` リンクから `imgurl` を抽出し、それを本命の画像URLとして使う。
- `imgurl` が取得できない、またはダウンロードに失敗した場合は、Googleの縮小画像URLも保存対象にする。
- Edgeなど別ブラウザは使わない。

## モードとDB/ブラウザ表示の扱い

### 5件ドライラン

- 対象数: 5件
- 目的: Google画像検索から1件目候補を取れるか、画像を実際にダウンロードできるか、CSVログに十分な情報を残せるかを確認する。
- サムネイル画像は実際に取得する。
- DBには登録しない。
- `xxx_tm009_fc2_wiki_thumbnail_assets` には書き込まない。
- localhostのブラウザ画面 `http://127.0.0.1/` には反映させない。
- 保存先は本運用の `fc2_sum` とは分けるか、ファイル名・CSVログでドライラン取得物だと判別できる形にする。
- 5件ドライランで「検索、候補抽出、画像取得、CSVログ」が確認できたら、次の100件テストへ進む。

### 100件以降の本テスト

- 100件、500件、1000件は本取得として扱う。
- サムネイル画像を実際に取得する。
- 成功したサムネイルはDBへ登録する。
- DB登録先は既存の `xxx_tm009_fc2_wiki_thumbnail_assets` を基本とする。
- `local_thumbnail_path` と `local_thumbnail_file_name` を保存し、localhostのブラウザ画面でサムネイル表示に使える状態にする。
- 100件以降で同じ対象を後から再取得し直す二度手間を避ける。
- CSVログにも、検索URL、候補画像URL、保存先、DB登録結果を必ず残す。
- 500件本テスト、1000件本テストでも、100件本テストと同じく画像保存、CSVログ、DB登録、ブラウザ表示反映を行う。

## Google検索結果取得方式

Google画像検索結果の取得は、HTML内の1件目候補から直接画像URLを抜き出す方式を基本にする。

採用する優先順位:

1. Google画像検索結果1件目の `/imgres?...` リンクから `imgurl` を取得する。
2. `imgurl` が `contents-thumbnail*.fc2.com` 系なら最優先で保存する。
3. `imgurl` がFC2系でなくても画像として取得できる場合は、CSVに由来を残したうえで保存候補にする。
4. `imgurl` が取れない、または直接画像URLの取得に失敗した場合は、検索結果内の `encrypted-tbn*.gstatic.com` などGoogle縮小画像URLを保存対象にする。

この方式により、保存工程は既存の `fc2_wiki_thumbnail_collector_operational.js` と同じく、既知の画像URLを `https.get` で直接ダウンロードする形に寄せる。

Google検索結果そのものの取得方法は、初期実装時に追加検証する。ただし、目的はブラウザ表示に近い1件目候補から `/imgres` の `imgurl` を取得することであり、Edgeなど別ブラウザは使わない。

## 段階的テスト

### Step 0: 5件ドライラン

- 対象数: 5件
- DB登録: なし
- ブラウザ表示反映: なし
- 画像取得: あり
- CSVログ: あり
- 目的: 100件本テストへ進めるかを確認する。
- 詰まったら即停止し、ユーザーへ相談する。

### Step 1: 100件本テスト

- 対象数: 100件
- DB登録: あり
- ブラウザ表示反映: あり
- 画像取得: あり
- CSVログ: あり
- 目的: Google画像検索1件目の取得可否、保存可否、DB登録、ブラウザ表示反映、ログの十分性を確認する。
- 詰まったら即停止し、ユーザーへ相談する。

### Step 2: 500件本テスト

- 対象数: 500件
- DB登録: あり
- ブラウザ表示反映: あり
- 画像取得: あり
- CSVログ: あり
- 300件処理後に休憩を入れる。
- 既存の `fc2_wiki_thumbnail_collector_operational.js` と同様、300件ごとに2～3分程度のインターバルを入れる。
- Step 1で問題がない場合のみ実施する。

### Step 3: 1000件本テスト

- 対象数: 1000件
- DB登録: あり
- ブラウザ表示反映: あり
- 画像取得: あり
- CSVログ: あり
- 300件ごとに2～3分程度のインターバルを入れる。
- Step 2で問題がない場合のみ実施する。

## 速度・待機

- 1件ごとに2～5秒程度のランダム待機を入れる。
- 300件ごとに2～3分程度の休憩を入れる。
- テスト中にCAPTCHA、ブロック、連続失敗、検索結果DOMの取得失敗が発生した場合は停止する。
- 初期テストでは1日上限は1000件までに抑える。
- 将来的に安定確認できた場合のみ、500件/日または1000件/日の運用に進める。

## CSVログ

万が一の戻し・確認のため、取得結果はCSVに残す。

想定カラム:

- `run_id`
- `mode`
- `product_id`
- `search_query`
- `search_url`
- `result_rank`
- `result_page_url`
- `candidate_image_url`
- `candidate_thumbnail_url`
- `candidate_image_source`
- `candidate_imgrefurl`
- `candidate_alt`
- `saved_local_thumbnail_path`
- `saved_local_thumbnail_file_name`
- `db_write_status`
- `status`
- `error_message`
- `delay_ms`
- `processed_at`

`search_url` には実際に開いたGoogle画像検索URLを保存する。

`candidate_image_url` には、Google結果から取得できた元画像URLを保存する。元画像URLが取れず、Googleのキャッシュ/縮小画像URLしか取れない場合は、そのURLを保存し、`status` または `error_message` で区別する。

`candidate_image_source` には、`imgres_imgurl`、`google_thumbnail_url`、`unknown` などを記録する。

`candidate_imgrefurl` には、`/imgres` から取得できた参照元ページURLを記録する。例: `https://adult.contents.fc2.com/article/4923154/`

## DB記録方針

5件ドライランではDBに記録しない。

ただし、5件ドライランが成功した場合は、確認後に取得済み5件をDBへ昇格登録できるように、CSVログと保存先を残す。昇格登録後は通常の所持サムネイルと同じ扱いに合流させ、5件分の穴を残さない。

100件以降の本テストでは、既存サムネイル管理に合わせて、成功時は `xxx_tm009_fc2_wiki_thumbnail_assets` に記録する。

このDB記録方針は、100件本テスト、500件本テスト、1000件本テストのすべてに適用する。

記録候補:

- `product_id`
- `thumbnail_url`
- `local_thumbnail_path`
- `local_thumbnail_file_name`
- `thumbnail_status`
- `last_checked_at`
- `downloaded_at`
- `attempt_count`
- `last_error`

ただし、Google検索結果由来であることを後から区別できるように、CSV側には必ず `search_url` と候補URLを残す。

DBへ新しい列や新しいテーブルが必要になった場合は、実装前に別途確認する。

## ブラウザ表示方針

- localhostのブラウザ画面 `http://127.0.0.1/` は、DBに登録された `local_thumbnail_path` を参照してサムネイルを表示する前提にする。
- 5件ドライランの取得画像はDB未登録のため、ブラウザ画面には反映させない。
- 100件以降の本テストでDB登録された画像は、ブラウザ画面で表示対象にする。
- 表示反映にキャッシュ更新や再読込が必要な場合は、テスト後に確認する。
- ブラウザ画面側のコード変更が必要になった場合は、実装前に別途確認する。

## 採用ロジック案

初期実装では、Google画像検索の1件目を候補にする。

優先採用条件:

- `product_id` が検索クエリと一致している。
- 1件目の `/imgres` リンクから `imgurl` を取得できる場合は、それを `candidate_image_url` とする。
- `/imgres` の `imgrefurl`、`result_page_url`、または `candidate_alt` に対象の `product_id` が含まれる。
- `candidate_image_url` が画像として取得できる。
- 保存ファイルが0バイトではない。

フォールバック条件:

- `imgurl` が取得できない場合は、Google縮小画像URLを `candidate_image_url` として保存対象にする。
- 直接画像URLのダウンロードに失敗した場合も、Google縮小画像URLがあれば保存対象にする。

より信頼度が高い条件:

- `candidate_imgrefurl` または `result_page_url` が `adult.contents.fc2.com/article/{product_id}/` に一致する。
- `candidate_image_url` が `contents-thumbnail*.fc2.com` 系である。

今回のユーザー方針では、1件目の正解率を重視し、外れの一定割合は許容する。ただしCSVログで追跡可能にする。

## 停止条件

以下のいずれかが起きたら即停止し、ユーザーへ相談する。

- CAPTCHAや自動アクセス制限画面が出た。
- Google検索結果の構造が想定と違い、1件目候補を取れない。
- 連続10件以上の取得失敗。
- `/imgres` の `imgurl` もGoogle縮小画像URLも取れない状態が続く。
- 保存画像が明らかに画像ではない、または0バイトになる。
- DB書き込みエラーが発生した。
- ローカル保存先の安全確認に失敗した。
- 予定外の外部ホストへ大量アクセスしそうになった。

## 監視

- 実行中は10分おきに進捗を確認する。
- 監視はCodexが毎回詳細ログを読むのではなく、別のステータス確認スクリプトで要約できるようにする。
- 確認する内容:
  - 処理済み件数
  - 成功件数
  - 失敗件数
  - 連続失敗件数
  - 最新エラー
  - CSVログの更新有無
  - DB記録件数
  - `imgres_imgurl` 採用件数
  - Google縮小画像URLフォールバック件数
- 異常があれば停止してユーザーへ相談する。

## 実装しないこと

この計画確認の段階では、以下は実施しない。

- Google検索の自動実行
- 画像の自動保存
- DB書き込み
- PM2設定追加
- 既存サムネイル取得JSの変更
- 新規DBテーブル作成

## 実装時の注意

- 既存の `fc2_wiki_thumbnail_collector_operational.js` の保存・ログ・待機・上書き防止の考え方を流用する。
- 新規npmパッケージは追加しない。必要な場合は事前にユーザーへ確認する。
- 既存ファイルは上書きしない。
- 失敗時に無限リトライしない。
- 5件ドライランはDB登録なしで行い、100件以降は本取得としてDB登録する。
- 5件ドライラン成功後は、確認済み5件をDBへ昇格登録できるようにする。
- 監視用のステータス確認スクリプトを用意し、10分おき確認はその要約を使う。
- 外部検索・スクレイピング範囲はユーザー承認後に限定して実行する。

## 決定事項

- Google画像検索結果1件目の `/imgres` から `imgurl` を抜き出す方式を本命にする。
- `imgurl` から直接画像を保存する。保存工程は既存のサムネイル取得JSと同じ直接URLダウンロード方式に寄せる。
- Google縮小画像URLだけだった場合も保存対象にする。
- Edgeなど別ブラウザは使わない。
- 5件ドライラン成功後は、確認済み5件をDBへ昇格登録して通常の所持サムネイル扱いへ合流させる。
- DB上でGoogle由来サムネイルを区別する必要が出た場合は、新列または別ログテーブルを検討する。
- 実行中の10分おき監視は、別のステータス確認スクリプトで補助する。

## 残る確認事項

- Google検索結果そのものを、ブラウザ自動操作で取得するか、HTML取得で十分かは、5件ドライラン実装時に小さく検証する。
- DB上でGoogle由来を区別するための新列または別ログテーブルが必要かは、既存テーブルに安全に記録できるか確認してから判断する。

## 2026-06-21 implementation notes

- 2026-06-21追加方針: Google画像検索を第一候補にせず、`https://adult.contents.fc2.com/article/{product_id}/` を直接取得して、記事HTML内のサムネイルURLを抽出する方式を本線に変更する。
- FC2記事直接取得の抽出優先順位は `twitter:image`、`.items_article_MainitemThumb img`、`og:image`、JSON-LD `image.url` とする。
- FC2記事ページがnotfound/削除/非公開の場合は `fc2_article_not_found` として失敗扱いにし、Google画像検索または手動CSVフォールバックへ回す。
- 検証サンプル:
  - `4830891`: `twitter:image` から `contents-thumbnail2.fc2.com` URL取得成功、dry-run保存成功。
  - `4907764`: `twitter:image` から `contents-thumbnail2.fc2.com` URL取得成功、dry-run保存成功。
  - `2268762`: FC2記事URLはHTTP 200だがnotfoundページのため、取得対象外として失敗扱い。
- この方式はGoogle検索結果HTMLを読まないため、前回のGoogleブロック問題を回避できる可能性が高い。
- `fc2-article` resolverを追加し、同じ画像保存・CSVログ・DB preflight・DB登録パイプラインへ流す。

- Browser resolver dry-run 5 rows failed with `google_block_or_captcha_detected`.
- HTML resolver dry-run 5 rows failed with `candidate_not_found`; fetched Google HTML was a challenge/unsupported-browser page, not normal image results.
- Because automatic Google result acquisition is blocked in this environment, the implementation keeps the same save/CSV/DB pipeline but also supports a manual candidate CSV route.
- Manual candidate CSV route accepts `imgres_url`, `candidate_image_url`, `candidate_thumbnail_url`, or `saved_html_path`.
- `/imgres?...imgurl=...` is parsed into the real image URL. If only a Google thumbnail URL is available, it can still be saved.
- `export-targets` creates target CSV files with `product_id` and `search_url` for 100/500/1000 staged work.
- `open_google_image_thumbnail_targets.ps1` opens `search_url` batches from an exported target CSV.
- DB writes are guarded by `--confirm-execute YES`, DB preflight CSV, valid `product_id`, `owned_without_thumbnail = true`, and post-write verification.
- Existing Google thumbnail overwrite is blocked unless `--allow-google-overwrite YES` is explicitly provided.
- Existing collected non-Google/manual thumbnail rows are true no-op on conflict.
- Outbound image downloads reject non-http(s), localhost/private/link-local hosts, unsafe redirects, and images larger than 20MB.
- One confirmed manual sample for `4923154` was dry-run saved, then promoted into `xxx_tm009_fc2_wiki_thumbnail_assets`; preflight log remains in `project_scripts/google_image_thumbnail_logs`.

### Current commands

```powershell
node project_scripts\google_image_thumbnail_collector.js --mode dry-run --resolver fc2-article --limit 5
node project_scripts\google_image_thumbnail_collector.js --mode execute --resolver fc2-article --limit 100 --confirm-execute YES

node project_scripts\google_image_thumbnail_collector.js --mode export-targets --limit 100
node project_scripts\google_image_thumbnail_collector.js --mode export-targets --limit 500
node project_scripts\google_image_thumbnail_collector.js --mode export-targets --limit 1000

.\open_google_image_thumbnail_targets.ps1 -CsvPath project_scripts\google_image_thumbnail_logs\<target_csv> -BatchSize 10

node project_scripts\google_image_thumbnail_collector.js --mode dry-run --resolver csv --source-csv project_scripts\google_image_thumbnail_logs\<manual_candidates_csv> --limit 5
node project_scripts\google_image_thumbnail_collector.js --mode execute --resolver csv --source-csv project_scripts\google_image_thumbnail_logs\<manual_candidates_csv> --limit 100 --confirm-execute YES
node project_scripts\google_image_thumbnail_status.js
```
