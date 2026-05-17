# PM2 起動メモ

このメモは、`pm2 start ecosystem.config.js` のように `ecosystem` 設定ファイルから起動するときの考え方を残すためのものです。

## 結論

`ecosystem.config.js` から起動する場合、PM2に表示される名前は、起動コマンドの `--name` ではなく、各 `ecosystem` ファイル内の `name:` で決まります。

そのため、初回起動でわかりやすい名前を付けたい場合は、先に `ecosystem*.config.js` の `name:` をわかりやすい名前へ変更してから、通常どおり `pm2 start` します。

## `--name` を使う場合

`--name` は、単体のスクリプトを直接PM2で起動するときに使います。

```powershell
pm2 start app.js --name my-app
```

この形では、`app.js` を `my-app` という名前でPM2に登録します。

## `ecosystem` を使う場合

`ecosystem` 設定ファイルを使う場合は、ファイルの中にある `name:` がPM2名になります。

```javascript
module.exports = {
  apps: [
    {
      name: "daily-0300-fc2-article-collect",
      script: "..."
    }
  ]
};
```

この場合、起動コマンドはこうです。

```powershell
pm2 start ecosystem.config.js
```

`pm2 list` には、`daily-0300-fc2-article-collect` という名前で表示されます。

## このプロジェクトでおすすめの名前

名前は、次の形にすると後から見てもわかりやすいです。

```txt
daily-時刻-処理内容
always-処理内容
```

日次実行のものは `daily-0300-...` のように開始時刻を入れます。

常時起動のものは `always-...` にします。

## 推奨PM2名

```txt
daily-0300-fc2-article-collect
daily-0400-fc2-delta-thumbnail
daily-0500-phase2-file-pipeline
daily-0800-fc2-wiki-thumbnail
always-thumbnail-library-web
always-thumbnail-library-api
```

## それぞれの意味

```txt
daily-0300-fc2-article-collect
03:00に動くFC2記事収集

daily-0400-fc2-delta-thumbnail
04:00に動くFC2記事差分サムネイル収集

daily-0500-phase2-file-pipeline
05:00に動くPhase2ファイル整理パイプライン

daily-0800-fc2-wiki-thumbnail
08:00に動くFC2 Wikiサムネイル補完収集

always-thumbnail-library-web
常時起動するローカルサムネイルライブラリ画面

always-thumbnail-library-api
常時起動するローカルサムネイルライブラリAPI
```

## 起動前に変更する `name:`

`ecosystem.config.js` では、3つの `name:` を次のようにします。

```javascript
name: "daily-0300-fc2-article-collect"
name: "daily-0400-fc2-delta-thumbnail"
name: "daily-0800-fc2-wiki-thumbnail"
```

`ecosystem.config2.js` では、1つの `name:` を次のようにします。

```javascript
name: "daily-0500-phase2-file-pipeline"
```

`ecosystem.ui.config.js` では、2つの `name:` を次のようにします。

```javascript
name: "always-thumbnail-library-web"
name: "always-thumbnail-library-api"
```

## 起動コード

`name:` を変更したあと、次の順番で起動します。

```powershell
pm2 start ecosystem.config.js
pm2 start ecosystem.config2.js
pm2 start ecosystem.ui.config.js
pm2 save
```

## 個別に起動したい場合

`ecosystem` 内の一部だけ起動したい場合は、`--only` を使います。

```powershell
pm2 start ecosystem.config.js --only daily-0300-fc2-article-collect
pm2 start ecosystem.config.js --only daily-0400-fc2-delta-thumbnail
pm2 start ecosystem.config2.js --only daily-0500-phase2-file-pipeline
pm2 start ecosystem.config.js --only daily-0800-fc2-wiki-thumbnail
pm2 start ecosystem.ui.config.js --only always-thumbnail-library-web
pm2 start ecosystem.ui.config.js --only always-thumbnail-library-api
pm2 save
```

## 注意

`ecosystem` 起動では、`--name` で名前を付けるより、設定ファイル内の `name:` を変更するほうが管理しやすいです。

理由は、`cwd`、`env`、`cron_restart`、ログ設定などが `ecosystem` にまとまっているためです。名前だけを起動コマンド側で変えるより、設定ファイルに名前も含めておくほうが、後から見たときに何が動いているか追いやすくなります。

## 起動後の確認

起動後は、次のコマンドで登録状態を確認します。

```powershell
pm2 list
```

ログを確認したい場合は、次のようにします。

```powershell
pm2 logs daily-0300-fc2-article-collect
pm2 logs always-thumbnail-library-web
```

保存済みのPM2起動状態を確認したい場合は、次のようにします。

```powershell
pm2 save
```

