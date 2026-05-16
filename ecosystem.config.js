module.exports = {
  apps: [
    {
      name: "fc2-article-daily",

      script:
        "C:/Users/toyoaki/Desktop/filedatachange/fc2_article_collector_operational.js",

      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",

      autorestart: false,

      watch: false,

      cron_restart: "0 3 * * *"
    }
  ]
};