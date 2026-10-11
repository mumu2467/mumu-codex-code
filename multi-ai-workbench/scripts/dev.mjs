#!/usr/bin/env node
/**
 * 一键并行启动 server + web。
 * 不引入 concurrently 之类依赖，用 Node 原生 child_process 自己管。
 * 两个子进程的输出会加上 [server] / [web] 前缀，方便区分。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** @type {{name:string,args:string[],color:string}[]} */
const targets = [
  { name: 'server', args: ['run', 'dev', '--workspace', '@maw/server'], color: '\u001b[36m' },
  { name: 'web', args: ['run', 'dev', '--workspace', '@maw/web'], color: '\u001b[35m' },
];

const RESET = '\u001b[0m';
const children = [];

for (const target of targets) {
  const child = spawn(npmCmd, target.args, {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);

  const pipe = (stream, isErr) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        process.stdout.write(`${target.color}[${target.name}]${RESET} ${line}\n`);
      }
    });
    stream.on('end', () => {
      if (buffer) process.stdout.write(`${target.color}[${target.name}]${RESET} ${buffer}\n`);
    });
    if (isErr) stream.on('error', () => {});
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code) => {
    process.stdout.write(`${target.color}[${target.name}]${RESET} 进程退出，code=${code}\n`);
    if (code !== 0 && code !== null) shutdown(code ?? 1);
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));