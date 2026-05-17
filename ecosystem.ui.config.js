// ============================================================
// ecosystem.ui.config.js
//
// PM2 config for the local thumbnail library UI.
//
// Apps:
// - thumbnail-library-web:
//   Serves the built Vite frontend on http://127.0.0.1:80
//   and keeps the Vite preview library APIs available.
// - thumbnail-library-api:
//   Serves Seller Completion / Rapidgator APIs on http://127.0.0.1:3001
//
// Build before starting:
//   cd C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui
//   npm run build
//
// Start:
//   pm2 start C:/Users/toyoaki/Desktop/filedatachange/ecosystem.ui.config.js
// ============================================================

module.exports = {
  apps: [
    {
      name: "always-thumbnail-library-web",
      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui/node_modules/vite/bin/vite.js",
      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui",
      args: ["preview", "--host", "127.0.0.1", "--port", "80", "--strictPort"],
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      out_file:
        "C:/Users/toyoaki/.pm2/logs/thumbnail-library-web-out.log",
      error_file:
        "C:/Users/toyoaki/.pm2/logs/thumbnail-library-web-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "always-thumbnail-library-api",
      script:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui/simple_server/server.js",
      cwd:
        "C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_library_ui/simple_server",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: "3001",
      },
      out_file:
        "C:/Users/toyoaki/.pm2/logs/thumbnail-library-api-out.log",
      error_file:
        "C:/Users/toyoaki/.pm2/logs/thumbnail-library-api-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
