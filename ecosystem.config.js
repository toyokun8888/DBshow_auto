module.exports = {
  apps: [
    {
      name: "daily-0100-fc2-javarchive-thumbnail",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/fc2_javarchive_thumbnail_collector.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "1",
        SCHEDULE_MINUTE: "0",
        SCHEDULE_WINDOW_MINUTES: "10",
        FC2_JAVARCHIVE_MODE: "daily",
        FC2_JAVARCHIVE_CONFIRM_EXECUTE: "YES",
        FC2_JAVARCHIVE_CONFIRM_DB_WRITE: "YES",
        FC2_JAVARCHIVE_DAILY_PAGES: "6",
        FC2_JAVARCHIVE_DAILY_CAP: "100",
        FC2_JAVARCHIVE_LOCK_WAIT_MINUTES: "180"
      },

      autorestart: false,

      watch: false,

      cron_restart: "0 1 * * *"
    },
    {
      name: "daily-0300-fc2-article-collect",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/fc2_article_collector_operational.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "3",
        SCHEDULE_MINUTE: "0",
        SCHEDULE_WINDOW_MINUTES: "10"
      },

      autorestart: false,

      watch: false,

      cron_restart: "0 3 * * *"
    },
    {
      name: "daily-2100-fc2-delta-thumbnail",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/fc2_article_delta_thumbnail_collector_operational.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "21",
        SCHEDULE_MINUTE: "0",
        SCHEDULE_WINDOW_MINUTES: "10"
      },

      autorestart: false,

      watch: false,

      cron_restart: "0 21 * * *"
    },
    {
      name: "daily-0330-seller-cache-refresh",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui/simple_server/refresh_seller_completion_cache.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "3",
        SCHEDULE_MINUTE: "30",
        SCHEDULE_WINDOW_MINUTES: "10"
      },

      autorestart: false,

      watch: false,

      cron_restart: "30 3 * * *"
    },
    {
      name: "daily-2200-seller-cache-refresh",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui/simple_server/refresh_seller_completion_cache.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "22",
        SCHEDULE_MINUTE: "0",
        SCHEDULE_WINDOW_MINUTES: "10"
      },

      autorestart: false,

      watch: false,

      cron_restart: "0 22 * * *"
    },
    {
      name: "daily-0800-fc2-wiki-thumbnail",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/fc2_wiki_thumbnail_collector_operational.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "8",
        SCHEDULE_MINUTE: "0",
        SCHEDULE_WINDOW_MINUTES: "10"
      },

      autorestart: false,

      watch: false,

      cron_restart: "0 8 * * *"
    },
    {
      // Name is kept stable so PM2 reloads the existing scheduled process.
      name: "daily-1600-sukebei-fc2-torrent",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/pm2_scheduled_runner.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      env: {
        SCHEDULE_TARGET_SCRIPT:
          "C:/Users/toyoaki/Desktop/filedatachange/sukebei_fc2_torrent_downloader.js",
        SCHEDULE_TARGET_CWD:
          "C:/Users/toyoaki/Desktop/filedatachange",
        SCHEDULE_HOUR: "23",
        SCHEDULE_MINUTE: "30",
        SCHEDULE_WINDOW_MINUTES: "10"
      },

      autorestart: false,

      watch: false,

      cron_restart: "30 23 * * *"
    }
  ]
};
