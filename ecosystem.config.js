module.exports = {
  apps: [
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
    }
  ]
};
