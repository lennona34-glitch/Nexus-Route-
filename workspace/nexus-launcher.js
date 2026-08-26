const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'server.log');
const out = fs.openSync(logFile, 'a');
const err = fs.openSync(logFile, 'a');

const child = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: __dirname,
  detached: true,
  stdio: ['ignore', out, err],
  shell: true,
  env: { ...process.env, PORT: '3000' }
});

child.unref();
console.log(`Server launched in background with PID: ${child.pid}`);
