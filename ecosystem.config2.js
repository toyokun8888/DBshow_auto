// ============================================================
// ecosystem.config2.js
//
// phase2_file_pipeline.js
// PM2 定時実行設定
//
// 目的:
// - 毎日定時に phase2 execute を実行
// - P:\new_DL を監視対象として処理
// - FC2 master を利用して自動振分け
//
// 実行内容:
//
// node phase2_file_pipeline.js
//   --mode execute
//   --confirm-execute YES
//   --input "P:\new_DL"
//   --final-base "P:\all_fc2"
//   --unmatched-dir "P:\all_fc2_unmatched"
//   --hold-dir "P:\all_fc2_hold"
//   --log-dir "P:\all_fc2_logs"
//
// ============================================================

module.exports = {
  apps: [
    {
      // PM2上の表示名
      name: "phase2-file-pipeline-daily",

      // 実行するJS
      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/phase2_execute/phase2_file_pipeline.js",

      // 実行ディレクトリ
      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/phase2_execute",

      // node 引数
      args: [
        "--mode", "execute",
        "--confirm-execute", "YES",
        "--input", "P:\\new_DL",
        "--final-base", "P:\\all_fc2",
        "--unmatched-dir", "P:\\all_fc2_unmatched",
        "--hold-dir", "P:\\all_fc2_hold",
        "--log-dir", "P:\\all_fc2_logs"
      ],

      // 常駐再起動しない
      autorestart: false,

      // watch不要
      watch: false,

      // 毎日 AM 3:30 実行
      // 必要なら変更
      cron_restart: "30 3 * * *",

      // ログ
      out_file:
        "C:/Users/toyoaki/.pm2/logs/phase2-file-pipeline-out.log",

      error_file:
        "C:/Users/toyoaki/.pm2/logs/phase2-file-pipeline-error.log",

      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};