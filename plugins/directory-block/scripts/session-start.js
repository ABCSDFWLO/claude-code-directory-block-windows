#!/usr/bin/env node
'use strict';

// SessionStart hook: shows the user a one-line status and tells Claude up front which paths are off-limits, so it
// avoids them instead of running into blocks.

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const P = require('./lib/paths');

const win = path.win32;

const TEXT = {
  ko: {
    error: (n) => `⚠️ directory-block: 설정 파일 오류 ${n}건 — 고칠 때까지 셸 명령과 파일 쓰기가 모두 차단됩니다. /directory-block:status 로 확인하세요.`,
    empty: (file) => `ℹ️ directory-block: 제한 경로가 없습니다. ${file} 에 추가하세요 (/directory-block:status 참고).`,
    active: (n) => `🛡️ directory-block: 제한 경로 ${n}개 보호 중`,
    cwdInside: (p) => ` · 경고: 현재 디렉토리가 제한 경로(${p}) 안에 있어 모든 셸 명령이 차단됩니다`,
    warnings: (n) => ` · 설정 경고 ${n}건`,
  },
  en: {
    error: (n) => `⚠️ directory-block: ${n} config error(s) — shell commands and file writes are blocked until fixed. Run /directory-block:status.`,
    empty: (file) => `ℹ️ directory-block: no restricted paths yet. Add them to ${file} (see /directory-block:status).`,
    active: (n) => `🛡️ directory-block: protecting ${n} restricted path(s)`,
    cwdInside: (p) => ` · warning: the current directory is inside restricted path ${p}, so every shell command is blocked`,
    warnings: (n) => ` · ${n} config warning(s)`,
  },
};

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
  } catch {
    input = {};
  }
  const cwd = input.cwd ? win.resolve(P.toWindowsPath(input.cwd)) : process.cwd();
  const config = loadConfig({ projectDir: process.env.CLAUDE_PROJECT_DIR || cwd, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT });
  const t = TEXT[config.options.language] || TEXT.ko;
  const restricted = config.rules.filter((r) => r.kind === 'restricted');

  let message;
  if (config.errors.length) {
    message = t.error(config.errors.length);
  } else if (!restricted.length) {
    message = t.empty(config.globalFile);
  } else {
    message = t.active(restricted.length);
    const cwdSegs = P.segmentsOf(cwd);
    const holder = restricted.find((r) => r.segForms.some((s) => P.relate(cwdSegs, s) === 'inside'));
    if (holder) message += t.cwdInside(holder.path);
  }
  if (config.warnings.length) message += t.warnings(config.warnings.length);

  const out = { systemMessage: message };
  if (config.options.announceToClaude && restricted.length && !config.errors.length) {
    const lines = restricted.map((r) => `- ${r.path}${r.reason ? ` (${r.reason})` : ''}`);
    out.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: [
        'The directory-block plugin is active. The user has made these paths off-limits for every tool',
        '(shell commands, scripts you run, and file tools). Do not read, list, search, modify or execute anything',
        'inside them, and do not try alternative spellings, links or encodings to reach them. Calls that touch them',
        'are blocked automatically. If a task needs them, tell the user instead.',
        ...lines,
        'Its config files are read-only for you: view them only with the Read tool, and never edit them.',
      ].join('\n'),
    };
  }
  process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch (err) {
  process.stdout.write(JSON.stringify({ systemMessage: `⚠️ directory-block: ${err.message}` }));
}
