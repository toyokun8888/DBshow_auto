# FC2・uncen 新ストレージ切替 Runbook

## 目的

この文書は、FC2系とuncen系の保存先を新しいWindowsストレージへ追加・切替し、次の一連の流れを維持するための手順書である。

```text
取得
  ↓
torrent投入 / qBittorrent保存
  ↓
自動仕分け・リネーム
  ↓
DBへ実パス登録
  ↓
localhostブラウザに表示
  ↓
Open file / Open folderで再生・参照
```

2026-09-16時点の`R:`切替実績を、次の2プロジェクトと実稼働状態から確認して作成した。

- FC2系: `C:\Users\toyoaki\Desktop\filedatachange`
- uncen系: `C:\uncen\collection-ledger`

この文書は、実ファイル移動やDB更新を自動承認するものではない。実行系コマンドは必ずDry-run、対象件数、実パスを確認してから使う。

## 最初に決める2項目

新しいストレージ名だけでは、既存ファイルも移すかどうかを決められない。次回は最低限、次の2項目を決める。

```text
NEW_DRIVE=S:
SWITCH_MODE=追加切替 または 完全移行
```

### 追加切替

- 既存ファイルと既存DBパスは旧ストレージのまま残す。
- 新しく取得するファイルだけ、新ストレージへ書き込む。
- ブラウザの許可rootには旧・新の両方を残す。
- 現行の`R:`切替は、既存DBパスを一括移行しない点では主にこの方式である。ただし、qBittorrentに登録済みだった進行中torrentはNからRへ個別に付け替えた。

### 完全移行

- 既存実ファイルも新ストレージへ移す。
- qBittorrentの既存torrent保存先も変更する。
- DBに保存済みのフルパスも、実体移動結果と1対1で更新する。
- 追加切替より高リスクであり、移動manifest、Dry-run、件数照合、実体存在確認が必須。
- 一括文字列置換だけでDBパスを更新してはならない。

モードが指定されていない場合は、旧データを残す`追加切替`の準備とDry-runまで進め、既存ファイル移動の前で確認する。

## 結論: ストレージ切替で変更する6層

ストレージ切替は、次の6層を同じドライブへ揃える作業である。

| 層 | FC2系 | uncen系 |
|---|---|---|
| 物理フォルダ | `?:\hogehoge`, `?:\all_fc2`, `?:\trash` | `?:\uncen`, `?:\uncen\torrent_automation` |
| 新規書込先 | `.env`の`PHASE2_*`, `TORRENT_*`, `SUKEBEI_*` | `ecosystem.uncen.config.js`の`UNCEN_P_ROOT` |
| qBittorrent | FC2の`downloads`保存先 | uncenの`torrent_automation\downloads`保存先 |
| DB実パス | `xxx_tm002_owned_files.current_path`等 | 各サイトのowned tableの`file_path` |
| ブラウザ許可root | `.env`の`MEDIA_ALLOWED_ROOTS` | `ecosystem.ui.config.js`とpath guard |
| 自動起動 | FC2系PM2 ecosystem | uncen系PM2 ecosystem |

1層でも旧ドライブのまま残ると、次のような不整合が起きる。

- torrentは新ドライブへ入るが、仕分けjobが旧ドライブを見る。
- DBには新パスが入るが、ブラウザAPIが許可せず再生できない。
- ブラウザには表示されるが、DBパス先に実体がない。
- 新しい設定ファイルは正しいが、PM2が古い環境変数のまま動く。

## `R:`切替で実際に行ったこと

### 1. FC2系の書込先を`.env`で`R:`へ統一

現在の主な設定は次のとおり。

```env
MEDIA_ALLOWED_ROOTS=...;R:\all_fc2;R:\uncen;...

PHASE2_FILE_PIPELINE_INPUT_DIR=R:\hogehoge
PHASE2_FILE_PIPELINE_FINAL_BASE=R:\all_fc2
PHASE2_FILE_PIPELINE_UNMATCHED_DIR=R:\trash\unmatched
PHASE2_FILE_PIPELINE_HOLD_DIR=R:\trash\hold
PHASE2_FILE_PIPELINE_ERROR_DIR=R:\trash\error
PHASE2_FILE_PIPELINE_INSPECTION_DIR=R:\trash\inspection
PHASE2_FILE_PIPELINE_LOG_DIR=R:\trash\logs

TORRENT_BASE_DIR=R:\hogehoge
TORRENT_INBOX_DIR=R:\hogehoge
TORRENT_ADDED_DIR=R:\hogehoge\_torrent_added
TORRENT_ERROR_DIR=R:\hogehoge\_torrent_error
TORRENT_LOG_DIR=R:\hogehoge\_torrent_logs
TORRENT_DOWNLOAD_DIR=R:\hogehoge\downloads

SUKEBEI_TORRENT_DOWNLOAD_DIR=R:\hogehoge
SUKEBEI_CSV_LOG_DIR=R:\hogehoge\_torrent_logs
```

この変更により、次のFC2系処理が同じ`R:`配下を使う。

1. `sukebei_fc2_torrent_downloader.js`が`.torrent`を`R:\hogehoge`へ取得する。
2. `torrent_import.js`がtorrentをqBittorrentへ登録し、保存先を`R:\hogehoge\downloads`にする。
3. `phase2_file_pipeline2.js`が`R:\hogehoge`を再帰確認する。
4. 照合成功ファイルを`R:\all_fc2\{seller}\...`へ仕分ける。
5. `xxx_tm002_owned_files.current_path`へ`R:\all_fc2\...`を登録する。
6. ログを`R:\trash\logs`へ残す。

### 2. FC2のPM2定時処理はjob本体を変えず、`.env`のR設定を読む

現在の主要時刻は次のとおり。

| 時刻 | PM2名 | 役割 |
|---|---|---|
| 07:00 | `daily-0530-qb-completed-cleanup` | 完了torrentのqB登録だけを削除。`deleteFiles=false` |
| 22:00 | `daily-0530-phase2-file-pipeline` | FC2動画の照合・仕分け・DB登録 |
| 23:30 | `daily-1600-sukebei-fc2-torrent` | FC2 torrent取得 |
| 23:50 | `torrent-import-batch` | qBittorrentへtorrent投入 |

PM2名には旧時刻が残っているが、実際の時刻はecosystem内の`cron_restart`と`SCHEDULE_HOUR`が正本である。

### 3. FC2のストレージ別手動バッチは`MEDIA_ALLOWED_ROOTS`から生成

`project_scripts/create_fc2new_mp4_storage_batches.js`は、`MEDIA_ALLOWED_ROOTS`にある`?:\all_fc2`を読み、各ドライブへ次を作る。

```text
?:\fc2new_mp4\run_fc2new_mp4_?.bat
```

生成バッチの流れは次のとおり。

1. Phase2 Dry-run。
2. 人間が`Y/N`で本実行を確認。
3. ファイル移動・リネーム・owned DB登録。
4. `local_mp4_ids_raw`同期のDry-runと本実行。
5. FC2ブラウザ用PM2サービスを再起動。

2026-09-16のDry-runでは`R:`は認識済みだが、`R:\fc2new_mp4\run_fc2new_mp4_R.bat`は`would_create`だった。つまり、Rの定時自動化は稼働中だが、R用の手動投入バッチはまだ未配置である。

### 4. qBittorrentの既存保存先をNからRへ付け替え

`project_scripts/qb_retarget_n_to_r.js`に、次の明示mappingを置いた。

```text
N:\hogehoge\downloads
  → R:\hogehoge\downloads

N:\uncen\torrent_automation\downloads
  → R:\uncen\torrent_automation\downloads
```

このスクリプトは通常実行では確認だけを行う。`CONFIRM_EXECUTE=YES`かつ`--execute`のときだけqBittorrentの保存先を変更し、その後start/resumeして再取得・再開する。

新しいドライブへ切り替える際、このファイルを変更せずに再利用してはいけない。ファイル名、mapping、確認表示がN→R専用だからである。

また、現行スクリプトの実行後確認は3秒待ってqBittorrentの`save_path`, `state`, `progress`を再取得するところまでである。実ファイル移動完了、全ファイルサイズ、recheck完了を保証するものではない。`save_path`がRになっただけで物理移行完了と判定してはならない。

### 5. FC2のDB/UI同期対象をRへ変更

`project_scripts/sync_owned_files_to_local_mp4_raw.js`の既定`TARGET_ROOT`は、Qから`R:\all_fc2`へ変更された。

このスクリプトは次を行う。

- `xxx_tm002_owned_files`から対象root配下を読む。
- `local_mp4_ids_raw`に同じ`product_id + full_path`があるか確認する。
- Dry-runでは不足件数だけ表示する。
- 本実行時だけ不足行をtransaction内で追加する。

Local Library本体は`xxx_tm002_owned_files`を直接読むため、この同期が未実行でも所持一覧表示と再生経路は動く。ただしSeller Completion側のローカル候補表示には`local_mp4_ids_raw`が関係するため、別の同期対象として残る。

### 6. FC2ブラウザ表示・再生でRを許可

FC2 Local Libraryは次の経路で動く。

```text
http://127.0.0.1/
  ↓
Vite preview middleware
  ↓
xxx_tm002_owned_files.current_path
  ↓
MEDIA_ALLOWED_ROOTS内か確認
  ↓
実ファイル存在確認
  ↓
MPC-BE alias / Explorer launcherで再生
```

重要な点:

- 一覧は`xxx_tm002_owned_files`を正本としている。
- Open fileは画面から実パスを自由入力するのではなく、原則`ownedFileId`からDBパスを再取得する。
- `MEDIA_ALLOWED_ROOTS`外は拒否する。
- Rを`MEDIA_ALLOWED_ROOTS`へ加えたことで、`R:\all_fc2`を開けるようになった。
- PM2の`always-thumbnail-library-web`と`always-thumbnail-library-api`を再起動し、新しい環境変数を読み直す必要がある。

### 7. uncen系は別プロジェクトの共通rootをRへ変更

uncen系は`C:\uncen\collection-ledger`に分離されている。

`ecosystem.uncen.config.js`で次を設定した。

```js
UNCEN_P_ROOT: "R:\\uncen"
```

変数名`P_ROOT`は旧名のままだが、実値は`R:\uncen`である。`apps/jobs/uncen-daily-automation.js`はこのrootから、次の全パスを組み立てる。

```text
R:\uncen\torrent_automation
R:\uncen\torrent_automation\inbox
R:\uncen\torrent_automation\added
R:\uncen\torrent_automation\error
R:\uncen\torrent_automation\logs
R:\uncen\torrent_automation\downloads
R:\uncen\{site}_thumbnails
R:\uncen\{site}_new_mp4
R:\uncen\{site}
R:\uncen\{site}_trash
```

### 8. uncenの5段階自動化をR rootで動かす

| 時刻 | stage | PM2名 | 主な処理 |
|---|---|---|---|
| 06:30 | `stage0` | `daily-0630-uncen-video-stage` | 夜間完了動画の先行ステージ |
| 13:00 | `stage1` | `daily-1300-uncen-acquire` | 各サイトmaster差分、共通master、サムネイル |
| 14:00 | `stage2` | `daily-1400-uncen-p-batches` | 手動サムネイル、Sukebei検索、qB投入 |
| 15:00 | `stage3` | `daily-1500-uncen-import` | 完了動画の`*_new_mp4`配置、review/plan/apply |
| 21:00 | `stage4` | `daily-2100-uncen-finalize` | 再取込、動画metadata、API/Web再起動 |

対象は主に`10musume`, `1pondo`, `carib`, `paco`, `heyzo`, `h0930`, `tokyo_hot`である。

各stageは次の安全機構を持つ。

- `UNCEN_AUTOMATION_EXECUTE=YES`がない限り実行しない。
- `--list`と`--dry-run`はplan表示だけ。
- PM2では予定時刻から10分以内だけ実処理する。
- 全stage共通lockで重複実行を避ける。
- 子jobを順番に実行し、失敗時は後続へ進まない。
- `10musume`, `1pondo`, `carib`, `heyzo`, `h0930`, `tokyo_hot`のowned取込はreview CSV、ready-plan CSV、applyの順に進む。
- `paco`と`heydouga_4017`は、それぞれ既存jobのapply入口を使う別経路である。

### 9. uncenの許可ドライブとブラウザrootへRを追加

R切替では、共通root以外にもRを追加した。

- `ecosystem.ui.config.js`
  - `R:/uncen`
  - `R:/all_fc2`
- `apps/api/src/utils/path-guard.js`
  - 既定のuncen許可ドライブに`R`
- `apps/jobs/collect-video-metadata.js`
  - metadata取得の既定許可ドライブに`R`
- site別owned処理
  - `1pondo-owned-operations.js`
  - `carib-owned-operations.js`
  - `carib-manko-zukan-exception-operations.js`
  - `h0930-owned-operations.js`
  - `heyzo-owned-operations.js`
  - `tenmusume-owned-operations.js`
  - `tokyo-hot-owned-operations.js`

site別処理は`?:\uncen\{site}_new_mp4`を受け入れるドライブ一覧を持つため、共通rootだけを変えても不十分だった。

### 10. uncenブラウザ表示・再生でRを許可

uncen Collection Ledgerは次の経路で動く。

```text
http://127.0.0.1:5173/
  ↓
http://127.0.0.1:3103 API
  ↓
site別library view / owned table
  ↓
MEDIA_ALLOWED_ROOTS内か確認
  ↓
実ファイル存在確認
  ↓
MPC-BE alias / Explorer launcherで再生
```

Open fileは`ownedFileId`またはDBに存在する完全一致パスから実パスを解決し、`MEDIA_ALLOWED_ROOTS`内だけを開く。

## 2026-09-16の実状態確認

### FC2

- `R:\all_fc2`, `R:\hogehoge`, `R:\trash`が存在する。
- 2026-09-15 22:00のPhase2は`R:\trash\logs`へCSVを出して完了した。
- 2026-09-15 23:30のFC2 torrent取得は15件成功、エラー0件。
- 2026-09-15 23:50のtorrent importは15件追加、失敗0件。
- qBittorrentではR保存先のtorrentが14件、N→Rの未切替対象は0件、R上のerror状態は0件だった。
- 14件の状態は`downloading=1`, `stalledDL=10`, `stalledUP=1`, `uploading=2`だった。これはsave pathのR切替確認であり、全torrentのダウンロード・物理移動完了確認ではない。
- `xxx_tm002_owned_files`には`R:\all_fc2`配下が852件あった。
- FC2 Local Library APIは正常応答し、一覧は12,889件だった。
- 再生ランチャーhealthではMPC-BE aliasが利用可能だった。
- `local_mp4_ids_raw`にはR配下852件が未同期だった。Local Library本体には影響しないが、Seller Completion候補同期として未処理。
- R用`fc2new_mp4`手動バッチは未作成。

### uncen

- `R:\uncen`とsite別フォルダが存在する。
- 2026-09-16の`stage0`から`stage4`はすべて`COMPLETE`まで到達した。
- `stage2`は`R:\uncen\torrent_automation\logs`へログを出し、qBへ2件追加、失敗0件だった。
- `stage4`はmetadata処理後にAPI/Webを再起動して完了した。
- APIが返したR上の所持ファイル件数と実体存在件数は一致した。

| source | Rパス件数 | 実体存在 |
|---|---:|---:|
| `10musume` | 20 | 20 |
| `1pondo` | 14 | 14 |
| `carib` | 24 | 24 |
| `paco` | 14 | 14 |
| `heyzo` | 32 | 32 |
| `h0930` | 2 | 2 |
| `tokyo_hot` | 0 | 0 |

### PM2と再生

- `always-thumbnail-library-web/api`はonline。
- `always-collection-ledger-web/api`はonline。
- 定時jobが通常`stopped`と表示されるのは、cron起動後に処理を終えて常駐しない設計のため正常。
- 今回の確認では、MPC-BEを勝手に起動しないためGUI再生そのものは実行していない。
- API経路、許可root、DB実パス、実体存在、ランチャー準備状態までは確認済み。
- 完全な切替確認では、最後に人間が新ストレージ上の既知1件をブラウザから再生する。

## 現在残っている注意点

### 1. R切替関連が未コミット

2026-09-16時点で、両プロジェクトのR切替コードと自動化ファイルには未コミット差分がある。PC障害や誤操作から復元できる状態にするには、内容を確認したうえで別途commitが必要。

### 2. uncen既存仕様書がP表記のまま

`C:\uncen\collection-ledger\docs\uncen-daily-automation.md`は、タイトルと本文の保存先が`P:\uncen`のまま残っている。実稼働の正本は現在`ecosystem.uncen.config.js`の`UNCEN_P_ROOT=R:\uncen`である。

### 3. 一部の補助jobは許可ドライブ一覧にRがない

日次automationの主経路ではR対応済みだが、次の補助jobには2026-09-16時点でRがない。

- `apps/jobs/check-owned-relations.js`
- `apps/jobs/heydouga-4017-owned-file-dry-run.js`
- `apps/jobs/move-paco-files.js`
- `apps/jobs/owned-file-pipeline.js`

これらを使う作業では、実行前にRまたは次の新ドライブが対象か確認する。

### 4. `.env`の許可root表記ゆれ

`MEDIA_ALLOWED_ROOTS`に`\J:\all_fc2`と`\F:\all_fc2`という先頭`\`付き表記がある。R切替には影響していないが、F/Jの許可判定を確認する際は正規化が必要。

### 5. qBittorrent既存torrentは設定変更だけでは移らない

`.env`や`UNCEN_P_ROOT`を変更しても、qBittorrentにすでに登録済みのtorrentの`save_path`は自動変更されない。既存torrentがある場合だけ、専用retargetのDry-runと本実行が必要。

### 6. DBの既存パスは自動で一括移行されない

新規ファイルは新rootで登録される。旧ストレージに残す既存ファイルは旧パスのままで正しい。

既存ファイルも移す完全移行では、次を別作業として行う。

1. 移動前manifestを作る。
2. 元・先の絶対パスを検証する。
3. copy / move結果とサイズを確認する。
4. 対応するDB行だけをtransactionで更新する。
5. 更新後に実体存在、件数、重複パスを再確認する。
6. 元ファイル削除は別承認にする。

## 次回の新ストレージ切替手順

以下では例として`NEW_DRIVE=S:`、旧書込先を`R:`とする。実際のドライブ名に読み替える。

### Phase 0: 変更前記録

両プロジェクトで現在差分を確認する。

```powershell
git -C C:\Users\toyoaki\Desktop\filedatachange status --short
git -C C:\uncen\collection-ledger status --short
pm2.cmd list
```

確認項目:

- 新ドライブがWindowsから見える。
- 容量とファイルシステムを確認済み。
- 旧ドライブがまだ接続されている。
- `追加切替`か`完全移行`か決まっている。
- 実行中のqB torrentと各PM2 jobの状態を記録した。

### Phase 0.5: 保守ゲート

設定変更中に旧rootのjobと新rootのjobが同時実行されないよう、次のどちらかを作業前に選ぶ。

#### A. 対象定時jobをPM2から一時退避する（推奨）

1. `pm2.cmd list`で対象cron jobがすべて`stopped`であり、実行中PIDがないことを確認する。
2. qBittorrentで、保存先を変更する対象torrentを一時停止する。
3. ユーザー確認後、ストレージに関係する定時jobをPM2のprocess listから一時削除する。
4. `pm2.cmd save`し、保守中にWindowsが再起動しても旧設定のjobが復活しないようにする。
5. 切替、Dry-run、qB移行、DB/API確認が終わるまで定時jobを再登録しない。
6. 完了後にecosystemから再登録し、もう一度`pm2.cmd save`する。

一時退避対象:

- `daily-0530-phase2-file-pipeline`
- `daily-0530-qb-completed-cleanup`
- `daily-1600-sukebei-fc2-torrent`
- `torrent-import-batch`
- `daily-0630-uncen-video-stage`
- `daily-1300-uncen-acquire`
- `daily-1400-uncen-p-batches`
- `daily-1500-uncen-import`
- `daily-2100-uncen-finalize`

PM2名に旧時刻が含まれるものがあるため、名前ではなく`pm2 describe`の`cron restart`とscript pathも照合する。API/Web常駐processは停止対象ではない。

#### B. 実行ゲートを一時無効化する

ecosystemと`.env`にあるFC2/uncen/qBのexecute確認値を一時的にDry-runまたは`NO`へ変更し、PM2へ`--update-env`付きで反映する。実行中processが0であることを確認してから切替作業を行う。完了後に元の値へ戻し、再度PM2へ反映する。

この方式では複数のexecute flagを漏れなく管理する必要があるため、通常はAを使う。単に「全schedule window外だから大丈夫」と判断せず、job退避またはexecute無効化のどちらかを必須とする。

### Phase 1: フォルダ構造を用意

FC2系:

```text
S:\hogehoge
S:\hogehoge\downloads
S:\hogehoge\_torrent_added
S:\hogehoge\_torrent_error
S:\hogehoge\_torrent_logs
S:\all_fc2
S:\trash\unmatched
S:\trash\hold
S:\trash\error
S:\trash\inspection
S:\trash\logs
```

uncen系:

```text
S:\uncen\torrent_automation\inbox
S:\uncen\torrent_automation\added
S:\uncen\torrent_automation\error
S:\uncen\torrent_automation\logs
S:\uncen\torrent_automation\downloads
S:\uncen\{site}_new_mp4
S:\uncen\{site}
S:\uncen\{site}_trash
S:\uncen\{site}_thumbnails
```

siteは実際に運用するものだけを対象にする。フォルダを作っただけでは切替完了にしない。

### Phase 2: FC2の設定を変更

`C:\Users\toyoaki\Desktop\filedatachange\.env`で次を行う。

1. `MEDIA_ALLOWED_ROOTS`へ`S:\all_fc2`を追加する。
2. uncenも同じストレージを使う場合は`S:\uncen`も追加する。
3. 旧rootは既存DBパスが残る間は削除しない。
4. `PHASE2_FILE_PIPELINE_*`の書込先をSへ変更する。
5. `TORRENT_*`の書込先をSへ変更する。
6. `SUKEBEI_TORRENT_DOWNLOAD_DIR`と`SUKEBEI_CSV_LOG_DIR`をSへ変更する。

変更後、対象行だけを確認する。秘密情報は表示しない。

```powershell
Get-Content -Encoding UTF8 .env |
  Where-Object { $_ -match '^\s*(MEDIA_ALLOWED_ROOTS|PHASE2_FILE_PIPELINE_|TORRENT_|SUKEBEI_TORRENT_DOWNLOAD_DIR|SUKEBEI_CSV_LOG_DIR)' }
```

### Phase 3: FC2ストレージ別バッチを確認

まずDry-run。

```powershell
node project_scripts\create_fc2new_mp4_storage_batches.js --mode dry-run
```

確認項目:

- `drives`に新ドライブが1回だけ出る。
- 新ドライブの`directory`が`S:\fc2new_mp4`。
- `batchPath`が`S:\fc2new_mp4\run_fc2new_mp4_S.bat`。
- 既存ドライブを意図せず対象にしていない。

`--mode execute`は全対象ドライブのbatchを作成または更新する。既存batchはbackupされるが、対象一覧を確認してから実行する。

### Phase 4: uncenの共通rootと許可ドライブを変更

`C:\uncen\collection-ledger\ecosystem.uncen.config.js`:

```js
UNCEN_P_ROOT: "S:\\uncen"
```

次に、ブラウザとmetadataの許可rootへSを加える。

- `ecosystem.ui.config.js`
  - `S:/uncen`
  - FC2も表示対象なら`S:/all_fc2`
- `apps/api/src/utils/path-guard.js`
- `apps/jobs/collect-video-metadata.js`
- site別owned処理の`DRIVES`または`NAS_DRIVES`

ハードコードされた許可ドライブを検索する。

```powershell
rg -n -S 'DRIVES =|NAS_DRIVES|defaultRoots|MEDIA_ALLOWED_ROOTS|UNCEN_P_ROOT' `
  C:\uncen\collection-ledger\apps `
  C:\uncen\collection-ledger\ecosystem.uncen.config.js `
  C:\uncen\collection-ledger\ecosystem.ui.config.js
```

検索結果を見ずに全ファイルを一括置換しない。旧ドライブは既存ファイルの検索・再生に必要な間は一覧から削除しない。

uncen planが新rootだけを組み立てることを`--list`で確認する。

```powershell
$env:UNCEN_P_ROOT='S:\uncen'
node C:\uncen\collection-ledger\apps\jobs\uncen-daily-automation.js stage0 --list
node C:\uncen\collection-ledger\apps\jobs\uncen-daily-automation.js stage1 --list
node C:\uncen\collection-ledger\apps\jobs\uncen-daily-automation.js stage2 --list
node C:\uncen\collection-ledger\apps\jobs\uncen-daily-automation.js stage3 --list
node C:\uncen\collection-ledger\apps\jobs\uncen-daily-automation.js stage4 --list
Remove-Item Env:\UNCEN_P_ROOT
```

出力に旧書込先`R:\uncen\torrent_automation`や`R:\uncen\*_new_mp4`が残っていないことを確認する。ただし旧所持ファイル検索rootとしてRが残るのは`追加切替`では正常。

### Phase 5: JavaScript構文確認

変更したJSとecosystemを`node --check`する。

```powershell
node --check ecosystem.config.js
node --check ecosystem.config2.js
node --check ecosystem.torrent.config.js
node --check ecosystem.ui.config.js
node --check C:\uncen\collection-ledger\ecosystem.uncen.config.js
node --check C:\uncen\collection-ledger\ecosystem.ui.config.js
node --check C:\uncen\collection-ledger\apps\jobs\uncen-daily-automation.js
```

### Phase 6: qBittorrentの既存torrentを確認

新しい`.torrent`だけなら、新設定後の`torrent_import.js`が新保存先を使う。

すでにqBittorrentへ登録済みのtorrentを移す場合は、専用retargetスクリプトを旧→新mappingで用意する。R切替時と同様、最低限次を満たすこと。

- qB APIは`localhost`または`127.0.0.1`だけを許可。
- 通常実行はDry-run。
- sourceとtargetを完全一致で比較。
- 変更前に永続manifestをCSVまたはJSONで保存する。
- manifestには少なくとも`hash`, `name`, `old_save_path`, `new_save_path`, `content_path`, `total_size`, `downloaded`, `progress`, `state`を入れる。
- `target_count`と対象一覧を表示し、manifest件数と一致させる。
- 明示確認フラグがない限り`setLocation`しない。
- 対象torrentを一時停止してから`setLocation`する。
- 変更後にsave pathとtorrent stateを再取得して検証する。
- `moving`, `checkingDL`, `checkingUP`, `allocating`等の移動・検査中状態がなくなるまで完了扱いにしない。
- qB APIのtorrent/file情報と、新root上の実ファイル存在・ファイルサイズを照合する。
- 完了済みtorrentは必要に応じてqBのrecheckを行い、recheck完了後の`progress=1`を確認する。
- 部分ダウンロード中のtorrentは、manifestのfile単位progressと新rootの実体を照合し、旧rootをまだ解放しない。
- error状態がないか確認。
- 全hashの検証結果をmanifestへ追記する。
- 検証完了前に旧ストレージを切断・初期化・再利用しない。

`qb_retarget_n_to_r.js`はN→R専用なので、S切替時はそのまま本実行しない。

現行`qb_retarget_n_to_r.js`自体には、永続manifest、file単位サイズ照合、移動完了待ち、recheck完了確認がない。次回の完全移行で既存torrentを移す場合は、これらを実装・Dry-runレビューしてから使う。追加切替で旧ストレージを残し、既存torrentを移さない場合はretarget不要。

### Phase 7: UI/APIだけに新設定を反映

Phase 0.5でAを選び一時退避した定時jobは、qB移行、DB、API、ブラウザ確認が完了するまで再登録しない。このPhaseでは常駐UI/APIだけを更新する。

FC2系:

```powershell
Set-Location C:\Users\toyoaki\Desktop\filedatachange
pm2.cmd startOrReload ecosystem.ui.config.js --update-env
```

uncen系:

```powershell
Set-Location C:\uncen\collection-ledger
pm2.cmd startOrReload ecosystem.ui.config.js --update-env
```

```powershell
pm2.cmd list
pm2.cmd save
```

この時点の`pm2 save`は、Aで一時退避した定時jobを復活させず、更新後のUI/APIだけを保守中process listへ保存するためのもの。scheduled ecosystemはまだ`startOrReload`しない。

Phase 0.5でBを選んだ場合も、この時点ではexecute確認値をDry-runまたは`NO`のまま維持する。

### Phase 8: DBパスの扱い

#### 追加切替

- 新規FC2ファイルはPhase2が`S:\all_fc2\...`を`xxx_tm002_owned_files.current_path`へ登録する。
- 新規uncenファイルはsite別owned applyが`S:\uncen\...`を各owned tableへ登録する。
- 旧ファイルは旧DBパスのまま残す。
- ブラウザ許可rootも旧・新の両方を残す。

#### 完全移行

専用JSを作り、次の順で実施する。

1. SELECT / Dry-runで更新予定行をCSV化。
2. 旧パスと新パスを絶対パスへ正規化。
3. 新パスの実体存在とファイルサイズを確認。
4. 対象行だけをtransactionで更新。
5. 更新後に旧prefix件数、新prefix件数、重複パス、実体不存在を再確認。
6. FC2では必要に応じて`local_mp4_ids_raw`も同じmanifestで整合させる。
7. uncenではsourceごとのowned tableとlibrary viewを確認する。

PowerShellインラインSQLに`$1`, `$2`を書かない。DB確認・更新は専用`.js`で行う。

### Phase 9: FC2補助同期のDry-run

新rootを明示して確認する。

```powershell
$env:SYNC_TARGET_ROOT='S:\all_fc2'
node project_scripts\sync_owned_files_to_local_mp4_raw.js --mode dry-run
Remove-Item Env:\SYNC_TARGET_ROOT
```

確認項目:

- `target_root`がS。
- `candidates`が想定件数。
- `missing_sample`がS配下だけ。
- 本実行後に`remaining_missing=0`。

本実行はDB書込みなので、Dry-run結果確認後に別途実行する。

### Phase 10: ブラウザ/API確認

FC2:

```text
http://127.0.0.1/
http://127.0.0.1/api/library/health
```

uncen:

```text
http://127.0.0.1:5173/
http://127.0.0.1:3103/api/library/items?source=10musume
```

確認順序:

1. APIが200を返す。
2. 新ストレージの作品が一覧に出る。
3. DBが返すパスが新root。
4. その実体ファイルが存在する。
5. Open folderで新rootのフォルダが開く。
6. 既知の1件だけOpen fileで再生する。
7. 許可root外のパスが拒否される。

### Phase 10.5: 定時jobを復帰

Phase 6からPhase 10までのqB、DB、実体、API、ブラウザ確認がすべて成功してから行う。

#### Phase 0.5でAを選んだ場合

一時退避した定時jobをecosystemから再登録する。

```powershell
Set-Location C:\Users\toyoaki\Desktop\filedatachange
pm2.cmd startOrReload ecosystem.config.js --update-env
pm2.cmd startOrReload ecosystem.config2.config.js --update-env
pm2.cmd startOrReload ecosystem.torrent.config.js --update-env

Set-Location C:\uncen\collection-ledger
pm2.cmd startOrReload ecosystem.uncen.config.js --update-env
```

#### Phase 0.5でBを選んだ場合

1. `.env`とecosystemのexecute確認値を本番値へ戻す。
2. 変更値を再確認する。
3. 上記と同じscheduled ecosystemを`--update-env`付きで再読込する。

最後に、予定時刻とscript pathを確認して保存する。

```powershell
pm2.cmd list
pm2.cmd describe daily-0530-phase2-file-pipeline
pm2.cmd describe daily-1400-uncen-p-batches
pm2.cmd save
```

時刻窓内に再登録すると即時実行される可能性がある。全scheduled jobの予定時刻から10分以内を避け、実行中PIDがないことを確認して復帰する。

Windows再起動後も復元するには、既存のタスクスケジューラまたはPM2 Windows serviceが`pm2 resurrect`を実行する構成も確認する。`pm2 save`だけでWindows起動連携が新規作成されるわけではない。

### Phase 11: 定時処理の翌日確認

PM2が登録されているだけでは完了にしない。翌日の実ログで確認する。

FC2:

- torrent取得ログの保存先が新root。
- torrent importのCSVが新root。
- Phase2 CSVが新root。
- 新規owned DBパスが新root。

uncen:

- `stage0`から`stage4`が`COMPLETE`。
- `stage2`のtorrent logが新root。
- `stage3`/`stage4`の`*_new_mp4`が新root。
- `stage4`後にAPI/Webがonline。

## 完了条件

次がすべて確認できたときだけ切替完了とする。

- [ ] 新ストレージのフォルダ構造が存在する。
- [ ] FC2の新規書込設定がすべて新root。
- [ ] uncenの`UNCEN_P_ROOT`が新root。
- [ ] site別許可ドライブに新ドライブがある。
- [ ] qBittorrentの新規save pathが新root。
- [ ] 既存torrentを移す場合、retarget後の対象が0件。
- [ ] FC2のDry-runとCSVが新rootを示す。
- [ ] uncenの全stage `--list`が新rootを示す。
- [ ] 新規DB行の実パスが新root。
- [ ] DBパス先の実ファイルが存在する。
- [ ] FC2ブラウザに表示できる。
- [ ] uncenブラウザに表示できる。
- [ ] Open folderが動く。
- [ ] 新ストレージ上の既知1件を実再生できる。
- [ ] PM2のAPI/Webがonline。
- [ ] 定時jobの翌日ログが新rootへ出ている。
- [ ] `pm2 save`後の復元方法を確認した。
- [ ] 未コミット差分と未処理件数を記録した。

## ロールバック方針

### 追加切替のロールバック

1. 新規書込先を旧rootへ戻す。
2. `UNCEN_P_ROOT`を旧rootへ戻す。
3. PM2を`--update-env`付きで再読込する。
4. 旧・新のブラウザ許可rootは、DBパスが残る間は両方維持する。
5. 新ストレージ上のファイルは自動削除しない。
6. qB save pathを戻す場合は、逆方向の専用retargetをDry-runから行う。

### 完全移行のロールバック

移動manifestとDB更新manifestから逆操作を設計する。manifestなしの一括戻し、元ファイル削除、DBパスの一括置換は禁止する。

## 次回依頼テンプレート

次回はこの文書を指定し、次の形式で依頼する。

```text
storage_switch_runbook.mdを踏襲して、新ストレージを切り替える。

NEW_DRIVE=S:
OLD_WRITE_DRIVE=R:
SWITCH_MODE=追加切替
FC2=対象
UNCEN=対象
QB_EXISTING_TORRENTS=移行する / 移行しない
```

実作業は、調査、変更予定一覧、Dry-run、ユーザー確認、本実行、API/ブラウザ/再生確認の順に行う。

## 将来の1設定化について

現状は、このrunbookにより再現可能にはなったが、ドライブ名を1か所指定するだけの実装にはなっていない。完全な1設定化には、次の値を一つのstorage profileから生成・検証する仕組みが必要になる。

- FC2 active root。
- uncen active root。
- `MEDIA_ALLOWED_ROOTS`。
- PM2 ecosystemの環境変数。
- site別許可ドライブ。
- qB old/new mapping。
- DB移行対象の有無。

この自動生成ツールを作る場合も、既定はDry-runとし、qB変更、DB更新、既存ファイル移動はそれぞれ独立した明示確認を必須にする。
