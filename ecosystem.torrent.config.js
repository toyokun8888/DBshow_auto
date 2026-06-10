module.exports = {
  apps: [
    {
      name: "torrent-import-batch",
      script: "project_scripts/pm2_scheduled_runner.js",
      cwd: "C:\\Users\\toyoaki\\Desktop\\filedatachange",
      cron_restart: "50 23 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        SCHEDULE_TARGET_SCRIPT:
          "C:\\Users\\toyoaki\\Desktop\\filedatachange\\torrent_import.js",
        SCHEDULE_TARGET_CWD:
          "C:\\Users\\toyoaki\\Desktop\\filedatachange",
        SCHEDULE_HOUR: "23",
        SCHEDULE_MINUTE: "50",
        SCHEDULE_WINDOW_MINUTES: "10",
      },
    },
  ],
};
