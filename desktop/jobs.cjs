'use strict';
/**
 * Stand-in for the crontab the server deploy (deploy/crontab) sets up - there's no cron on a
 * shop-counter Windows PC, so while the app is open we run the same jobs on our own timers:
 *   - whatsappWorker.js   every 60s   (sends the queued outbound WhatsApp messages)
 *   - photoCleanup.js     daily       (prunes old order photos per PHOTO_RETENTION_DAYS)
 *   - nightlyBackup.js    daily       (Admin > Backup's "Take Backup Now", automated)
 *   - whatsappMarketing.js daily      (scheduled WhatsApp marketing sends)
 *
 * Times are the PC's local clock (no timezone library pulled in just for this). A failing job
 * is logged and skipped - it never takes the app down.
 *
 * nightlyBackup.js shells out to `mysqldump`; if that isn't on this PC's PATH (no MySQL/MariaDB
 * client tools installed), the backup job will fail every night. That's a pre-existing property
 * of DatabaseBackupService, not something this wrapper can work around - see desktop/README.md.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

function msUntil(hour, minute) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function startBackgroundJobs({ backendDir, runtimeEnv, log }) {
  const timers = [];

  function runScript(relPath, label) {
    const scriptPath = path.join(backendDir, 'dist', 'jobs', relPath);
    log(`[jobs] starting ${label}`);
    const child = spawn(process.execPath, [scriptPath], {
      cwd: backendDir,
      env: { ...process.env, ...runtimeEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => log(`[${label}] ${d}`.trimEnd()));
    child.stderr.on('data', (d) => log(`[${label}] ${d}`.trimEnd()));
    child.on('error', (err) => log(`[jobs] ${label} failed to start: ${err.message}`));
    child.on('exit', (code) => { if (code !== 0) log(`[jobs] ${label} exited with code ${code}`); });
  }

  function everyMinute(relPath, label) {
    runScript(relPath, label); // once right away, then on the interval
    const id = setInterval(() => runScript(relPath, label), 60 * 1000);
    timers.push(() => clearInterval(id));
  }

  function daily(relPath, label, hour, minute) {
    let id;
    const fire = () => { runScript(relPath, label); id = setTimeout(fire, 24 * 60 * 60 * 1000); };
    id = setTimeout(fire, msUntil(hour, minute));
    timers.push(() => clearTimeout(id));
  }

  everyMinute('whatsappWorker.js', 'whatsapp-worker');
  daily('photoCleanup.js', 'photo-cleanup', 3, 15);
  daily('nightlyBackup.js', 'nightly-backup', 2, 30);
  daily('whatsappMarketing.js', 'whatsapp-marketing', 9, 30);

  return { stop: () => timers.forEach((cancel) => cancel()) };
}

module.exports = { startBackgroundJobs };
