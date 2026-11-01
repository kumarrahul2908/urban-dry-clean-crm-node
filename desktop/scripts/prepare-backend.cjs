#!/usr/bin/env node
'use strict';
/**
 * Builds the existing Node/Fastify backend (repo root) and copies the production-ready
 * pieces (dist/, public/, db/) into desktop/resources/backend, then installs that copy's
 * production-only node_modules there. electron-builder packages resources/backend verbatim
 * (extraResources) and main.cjs runs dist/server.js from inside it at app launch.
 *
 * Every runtime dependency of the backend (mysql2, fastify, bcryptjs, zod, ...) is pure
 * JavaScript - nothing here needs native compilation, so the node_modules built by this
 * script run unmodified under Electron's bundled Node.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const backendOut = path.join(desktopDir, 'resources', 'backend');

function run(cmd, args, cwd) {
  console.log(`[prepare-backend] $ ${cmd} ${args.join(' ')}  (in ${path.relative(desktopDir, cwd)})`);
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
run('npm', ['ci', '--omit=dev'], backendOut);

console.log('[prepare-backend] done ->', path.relative(repoRoot, backendOut));
