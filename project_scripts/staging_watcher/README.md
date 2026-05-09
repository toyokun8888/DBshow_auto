# MP4 Staging Watcher

`Goal 3` の最小実装として、手動DLフォルダから `.mp4` だけを一時処理フォルダへ移すスクリプトです。

この段階では次の処理は行いません。
- リネーム
- DB照合
- DB登録

## Safety

- 対象は `.mp4` のみ
- ダウンロード中と判断したファイルは待機してスキップ
- 同名があれば `(1)`, `(2)` を付けて保存
- 移動失敗時は元ファイルを触らない
- `EXDEV` (クロスドライブ移動) は自動コピー/削除せず、エラー記録のみで停止する
- デフォルトは `dry-run`（実移動しない）

## File

- [mp4_staging_watcher.js](/C:/Users/toyoaki/Desktop/filedatachange/project_scripts/staging_watcher/mp4_staging_watcher.js)

## Usage

サンプル環境を作る:

```powershell
node project_scripts\staging_watcher\mp4_staging_watcher.js --init-sample
```

単発 dry-run:

```powershell
node project_scripts\staging_watcher\mp4_staging_watcher.js `
  --mode once `
  --dry-run true `
  --manual-dir "C:\path\to\download" `
  --staging-dir "C:\path\to\staging" `
  --log-dir "C:\path\to\logs"
```

単発 本実行:

```powershell
node project_scripts\staging_watcher\mp4_staging_watcher.js `
  --mode once `
  --dry-run false `
  --manual-dir "C:\path\to\download" `
  --staging-dir "C:\path\to\staging" `
  --log-dir "C:\path\to\logs"
```

常時監視（ポーリング）:

```powershell
node project_scripts\staging_watcher\mp4_staging_watcher.js `
  --mode watch `
  --dry-run true `
  --poll-ms 3000 `
  --stable-check-ms 1000 `
  --stable-rounds 2
```

## CSV Log

`file_process_{run_id}.csv`

列:
- `run_id`
- `timestamp`
- `action`
- `status`
- `source_path`
- `dest_path`
- `file_size`
- `file_modified_at`
- `note`
