// pm2: `pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup`
module.exports = { apps: [{ name: 'udc-crm', script: 'dist/server.js', cwd: '/opt/udc', env_file: '/opt/udc/.env', instances: 1, max_memory_restart: '600M', time: true }] };
