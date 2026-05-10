# Thumbnail Library UI (Goal 5)

ローカル専用のライブラリページ（React + TypeScript）です。  
まずFEだけ先に作成し、API接続先は後で差し替えできるようにしています。

## 実行

```powershell
cd project_scripts\thumbnail_library_ui
npm run dev
```

## ビルド確認

```powershell
npm run build
```

## 後で差し替える場所

`src/App.tsx` の以下定数に `TODO(API_CONFIG)` コメントを付けています。

- `LIBRARY_API_ENDPOINT`
- `OPEN_FILE_ENDPOINT`
- `OPEN_FOLDER_ENDPOINT`

この3つを、後でNode側の実エンドポイントに置き換えてください。

## 画面の現状

- ID検索（`product_id`）
- タイトルあいまい検索（部分一致）
- seller絞り込み
- status絞り込み
- ソート（更新日 / `product_id`）
- ページング
- カード一覧（サムネイル、タイトル、seller、status）
- 詳細ダイアログ（ファイルを開く/フォルダを開くボタン）

API未接続時はFE確認のためサンプルデータに自動フォールバックします。

開発サーバー起動中は `vite.config.ts` のミドルウェアで  
`/api/library/items` がDBからデータを返します。

## API連携の注意

- 開く系API（`open-file` / `open-folder`）には、パス文字列ではなく `productId` / `ownedFileId` を送る前提です。
- サムネイル表示は `"/thumb/"` または `"/api/thumb/"` の同一オリジン経路のみ表示します。
