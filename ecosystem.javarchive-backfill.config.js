module.exports = {
  apps: [
    {
      name: "once-fc2-javarchive-backfill",
      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/fc2_javarchive_thumbnail_collector.js",
      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange",
      args: [
        "--mode",
        "backfill",
        "--run-id",
        "javarchive_backfill_20260920",
        "--confirm-execute",
        "YES",
        "--confirm-db-write",
        "YES"
      ],
      env: {
        FC2_JAVARCHIVE_MAX_TOTAL_PAGES: "6000",
        FC2_JAVARCHIVE_BACKFILL_END_PAGE: "3716"
      },
      autorestart: false,
      watch: false
    }
  ]
};
