module.exports = {
  apps: [
    {
      name: "torrent-import-batch",
      script: "torrent_import.js",
      cwd: "C:\\Users\\toyoaki\\Desktop\\filedatachange",
      cron_restart: "0 17 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
