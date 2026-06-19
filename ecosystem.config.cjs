/* PM2 process configuration for the compiled production server.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup   # survive reboots
 *
 * Secrets/config are NOT here — they live in the server's .env file (loaded by
 * dotenv at runtime). See docs/DEPLOYMENT.md.
 *
 * instances:1 / fork: the app runs one nightly missed-clock-out timer in
 * process. The sweep is idempotent (a partial unique index dedupes flags), so
 * multiple instances would be safe but wasteful — keep one instance until the
 * sweep is moved to a dedicated cron/worker if you ever scale horizontally.
 */
module.exports = {
  apps: [
    {
      name: "trgbi-attendance",
      script: "dist/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
