module.exports = {
  apps: [
    {
      name: "daily-0430-rapidgator-delta",
      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",
      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",
      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/rapidgator_daily_delta.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "4",
        SCHEDULE_MINUTE: "30",
        SCHEDULE_WINDOW_MINUTES: "10",
        RAPIDGATOR_DAILY_EXECUTE: "YES",
        RAPIDGATOR_DAILY_CONFIRM_DB_WRITE: "YES",
        RAPIDGATOR_DAILY_EXPECTED_FOLDERS: "7",
        RAPIDGATOR_DAILY_KNOWN_BOUNDARY_PAGES: "2",
        RAPIDGATOR_DAILY_MAX_PROBE_PAGES: "50",
        RAPIDGATOR_DAILY_MAX_ATTEMPTS: "3",
      },
      autorestart: false,
      watch: false,
      cron_restart: "30 4 * * *",
    },
  ],
};
