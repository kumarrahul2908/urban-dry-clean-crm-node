// pm2: `pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save`. Settings come from /opt/udc/.env (dotenv reads it from cwd).
module.exports = { apps: [{ name: 'udc-crm', script: 'dist/server.js', cwd: '/opt/udc', instances: 1, max_memory_restart: '600M', time: true }] };
