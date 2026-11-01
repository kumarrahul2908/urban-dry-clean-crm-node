#!/usr/bin/env node
'use strict';
/**
 * Builds the existing Node/Fastify backend (repo root) and stages a self-contained copy of it -
 * dist/, public/, db/, production-only node_modules, plus a portable Windows Node.js runtime
 * (node.exe only - nothing else from the zip is needed to run the server) - so the native app
 * never requires Node.js to be separately installed on the shop PC.
 *
 * Output layout: <target>/backend/{node/node.exe, dist/, public/, db/, node_modules/, package.json}
 * BackendProcessManager (native/src/Udc.Client/BackendProcessManager.cs) expects exactly this
 * layout relative to Udc.App.exe's own directory, so <target> should be the `dotnet publish`
 * output directory (pass it as the first CLI argument) in CI / real builds.
 *
 * Windows-only: relies on `tar` (bsdtar, built into Windows 10/Server 2019+) to extract the
 * Node.js zip. This script is only ever meant to run on Windows (CI's windows-latest runner, or
 * a Windows dev machine) - same as the app it's staging for.
 */
const { execFileSync } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const NODE_VERSION = process.env.NATIVE_APP_NODE_VERSION || '22.11.0';
const NODE_ZIP_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;

const nativeDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(nativeDir, '..');
const targetArg = process.argv[2];
const targetDir = targetArg ? path.resolve(targetArg) : path.join(nativeDir, 'resources');
const backendOut = path.join(targetDir, 'backend');

function run(cmd, args, cwd) {
  console.log(`[prepare-backend] $ ${cmd} ${args.join(' ')}  (in ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${u} -> HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };
    request(url);
  });
}

async function stageNodeRuntime() {
  const nodeOutDir = path.join(backendOut, 'node');
  const nodeExeOut = path.join(nodeOutDir, 'node.exe');
  if (fs.existsSync(nodeExeOut)) {
    console.log('[prepare-backend] portable node.exe already staged, skipping download');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'udc-node-'));
  const zipPath = path.join(tmpDir, 'node.zip');
  console.log(`[prepare-backend] downloading ${NODE_ZIP_URL}`);
  await download(NODE_ZIP_URL, zipPath);

  console.log('[prepare-backend] extracting node.exe');
  run('tar', ['-xf', zipPath, '-C', tmpDir], tmpDir);
  const extractedDir = path.join(tmpDir, `node-v${NODE_VERSION}-win-x64`);
  const extractedExe = path.join(extractedDir, 'node.exe');
  if (!fs.existsSync(extractedExe)) {
    throw new Error(`node.exe not found at ${extractedExe} after extracting the Node.js zip`);
  }

  fs.mkdirSync(nodeOutDir, { recursive: true });
  fs.copyFileSync(extractedExe, nodeExeOut);
  rmrf(tmpDir);
}

async function main() {
  // 1. Build the backend (repo root) fresh, so the packaged app always ships the current code.
  run('npm', ['ci'], repoRoot);
  run('npm', ['run', 'build'], repoRoot);

  // 2. Reset the staging area.
  rmrf(backendOut);
  fs.mkdirSync(backendOut, { recursive: true });

  // 3. Copy the pieces the running server needs (same set as Dockerfile's final stage).
  copyDir(path.join(repoRoot, 'dist'), path.join(backendOut, 'dist'));
  copyDir(path.join(repoRoot, 'public'), path.join(backendOut, 'public'));
  copyDir(path.join(repoRoot, 'db'), path.join(backendOut, 'db'));
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(backendOut, 'package.json'));
  fs.copyFileSync(path.join(repoRoot, 'package-lock.json'), path.join(backendOut, 'package-lock.json'));

  // 4. Production-only node_modules for the staged copy (no tsx/typescript/vitest/dev tooling).
  //    Every runtime dependency (mysql2, fastify, bcryptjs, zod, ...) is pure JavaScript, so it
  //    runs unmodified under the bundled portable Node below - no native/ABI rebuild needed.
  run('npm', ['ci', '--omit=dev'], backendOut);

  // 5. Portable Node.js runtime, so the shop PC never needs Node.js installed separately.
  await stageNodeRuntime();

  console.log('[prepare-backend] done ->', backendOut);
}

main().catch((err) => {
  console.error('[prepare-backend] FAILED -', err.message);
  process.exitCode = 1;
});
