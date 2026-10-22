#!/usr/bin/env node
'use strict';

// PreToolUse hook. Reads the tool call from stdin and answers with a deny/ask decision when it touches a restricted
// path; prints nothing to let the call through. Any failure denies the call (fail closed).

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const { analyzeToolCall } = require('./lib/analyzer');
const { formatConfigError, formatInternalError, formatReason } = require('./lib/messages');
const P = require('./lib/paths');

const win = path.win32;

function respond(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

function appendAudit(file, entry) {
  if (!file) return;
  try {
    fs.mkdirSync(win.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never change the decision.
  }
}

function summarizeInput(toolInput) {
  const value = toolInput.command || toolInput.file_path || toolInput.notebook_path || toolInput.pattern || toolInput.path || '';
  const text = String(value);
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

// With a broken config only reading the config files themselves is allowed, so Claude can explain the problem.
function isConfigRead(input, config) {
  if (input.tool_name !== 'Read' || typeof input.tool_input.file_path !== 'string') return false;
  const target = P.segmentsOf(P.resolveCandidate(input.tool_input.file_path, input.cwd));
  return [config.globalFile, config.projectFile].some((f) => {
    const segs = f && P.segmentsOf(f);
    return target && segs && target.join('/') === segs.join('/');
  });
}

function main() {
  const raw = fs.readFileSync(0, 'utf8').replace(/^﻿/, '');
  const input = JSON.parse(raw);
  input.tool_input = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = input.cwd ? win.resolve(P.toWindowsPath(input.cwd)) : process.cwd();
  input.cwd = cwd;
  const config = loadConfig({
    projectDir: process.env.CLAUDE_PROJECT_DIR || cwd,
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
  });
  const lang = config.options.language;

  if (config.errors.length) {
    if (!isConfigRead(input, config)) respond('deny', formatConfigError(config.errors, lang));
    return;
  }

  const { violations } = analyzeToolCall({ toolName: input.tool_name, toolInput: input.tool_input, cwd, config });
  if (!violations.length) return;

  const hardDeny = violations.some((v) => !v.rule || v.rule.kind === 'protected');
  const decision = hardDeny || config.options.onViolation === 'deny' ? 'deny' : 'ask';
  respond(decision, formatReason(violations, { lang, decision }));
  appendAudit(config.auditLogPath, {
    time: new Date().toISOString(),
    session: input.session_id || null,
    tool: input.tool_name,
    decision,
    cwd,
    input: summarizeInput(input.tool_input),
    violations: violations.map((v) => ({
      path: v.rule ? v.rule.path : null,
      kind: v.rule ? v.rule.kind : null,
      type: v.type,
      evidence: v.evidence,
      origin: v.origin,
    })),
  });
}

try {
  main();
} catch (err) {
  respond('deny', formatInternalError(err));
}
