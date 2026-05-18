// ============================================================
// ecosystem.config2.js
//
// PM2 schedule for the Phase2 file pipeline.
//
// The script reads production defaults from:
//   C:/Users/toyoaki/Desktop/filedatachange/.env
//
// Main .env keys:
//   PHASE2_FILE_PIPELINE_MODE
//   PHASE2_FILE_PIPELINE_CONFIRM_EXECUTE
//   PHASE2_FILE_PIPELINE_INPUT_DIR
//   PHASE2_FILE_PIPELINE_FINAL_BASE
//   PHASE2_FILE_PIPELINE_UNMATCHED_DIR
//   PHASE2_FILE_PIPELINE_HOLD_DIR
//   PHASE2_FILE_PIPELINE_ERROR_DIR
//   PHASE2_FILE_PIPELINE_INSPECTION_DIR
//   PHASE2_FILE_PIPELINE_LOG_DIR
//
// Manual run from cwd:
//   node phase2_file_pipeline2.js
//
// PM2 start:
//   pm2 start ecosystem.config2.config.js
// ============================================================

module.exports = {
  apps: [
    {
      name: "daily-0530-phase2-file-pipeline",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/phase2_execute",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/phase2_execute/phase2_file_pipeline2.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/phase2_execute",
        SCHEDULE_HOUR: "5",
        SCHEDULE_MINUTE: "30",
        SCHEDULE_WINDOW_MINUTES: "10",
      },

      // Keep args empty so the target script uses the same .env-backed behavior as manual runs.
      args: [],

      autorestart: false,
      watch: false,

      // Daily 05:30 local time.
      cron_restart: "30 5 * * *",

      out_file:
        "C:/Users/toyoaki/.pm2/logs/phase2-file-pipeline-out.log",

      error_file:
        "C:/Users/toyoaki/.pm2/logs/phase2-file-pipeline-error.log",

      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
