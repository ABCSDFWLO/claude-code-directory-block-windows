'use strict';

// Loads the restricted-path rules. The global file (~/.claude/directory-block.json) has full authority. The project
// file (<project>/.claude/directory-block.json) lives in the repository, so it may add restrictions and tighten
// options but never loosen what the global file set.

const fs = require('fs');
const path = require('path');
const P = require('./paths');

const win = path.win32;

const CONFIG_NAME = 'directory-block.json';

const DEFAULT_OPTIONS = Object.freeze({
  onViolation: 'deny',
  scanScripts: true,
  maxScriptBytes: 1024 * 1024,
  maxScriptDepth: 3,
  checkRecursiveAncestors: true,
  checkPatternsInRecursiveReads: true,
  encodedCommands: 'decode',
  protectFileTools: true,
  selfProtect: true,
  protectPluginRoot: true,
  protectClaudeSettings: false,
  auditLog: true,
  announceToClaude: true,
  language: 'ko',
});

// Allowed values, ordered from weakest to strictest where that matters.
const ENUMS = {
  onViolation: ['ask', 'deny'],
  encodedCommands: ['allow', 'decode', 'block'],
  language: ['ko', 'en'],
};
const NUMBERS = { maxScriptBytes: [0, 64 * 1024 * 1024], maxScriptDepth: [0, 10] };
// Booleans where `true` is the stricter setting.
const TIGHTENING_BOOLEANS = new Set([
  'scanScripts', 'checkRecursiveAncestors', 'checkPatternsInRecursiveReads', 'protectFileTools', 'selfProtect',
  'protectPluginRoot', 'protectClaudeSettings',
]);
// Options that are not about enforcement; only the global file sets them.
const GLOBAL_ONLY = new Set(['language', 'auditLog', 'announceToClaude']);

const KNOWN_KEYS = new Set(['$schema', '$comment', 'restricted', 'restrictedPatterns', 'allow', 'options']);

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR ? win.resolve(process.env.CLAUDE_CONFIG_DIR) : win.join(P.homeDir(), '.claude');
}

// DIRECTORY_BLOCK_CONFIG points the global file elsewhere (managed machines, tests). Hooks inherit Claude Code's
// environment, so commands Claude runs cannot change it.
function globalConfigPath() {
  const override = process.env.DIRECTORY_BLOCK_CONFIG;
  return override ? win.resolve(override) : win.join(claudeDir(), CONFIG_NAME);
}

function projectConfigPath(projectDir) {
  return win.join(win.resolve(projectDir), '.claude', CONFIG_NAME);
}

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { exists: false };
    return { exists: true, error: err.message };
  }
  try {
    const data = JSON.parse(raw.replace(/^﻿/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { exists: true, error: 'top level must be a JSON object' };
    return { exists: true, data };
  } catch (err) {
    return { exists: true, error: `invalid JSON: ${err.message}` };
  }
}

function resolveEntryPath(raw, baseDir) {
  const expanded = P.expandVars(String(raw).trim(), { cwd: baseDir || P.homeDir() });
  let s = P.toWindowsPath(expanded);
  if (/^[a-z]:$/i.test(s)) s += '/';
  if (!s) return null;
  if (P.isAbsoluteLike(s)) return win.resolve(s);
  return baseDir ? win.resolve(baseDir, s) : null;
}

function parseEntries(list, field, ctx) {
  const out = [];
  if (list === undefined) return out;
  if (!Array.isArray(list)) {
    ctx.errors.push(`${ctx.file}: "${field}" must be an array`);
    return out;
  }
  list.forEach((item, i) => {
    const isObject = item && typeof item === 'object' && !Array.isArray(item);
    const raw = typeof item === 'string' ? item : isObject ? item.path : undefined;
    const reason = isObject && typeof item.reason === 'string' ? item.reason : '';
    if (typeof raw !== 'string' || !raw.trim()) {
      ctx.errors.push(`${ctx.file}: ${field}[${i}] must be a path string or { "path": ..., "reason": ... }`);
      return;
    }
    const resolved = resolveEntryPath(raw, ctx.baseDir);
    if (!resolved || !P.segmentsOf(resolved)) {
      const hint = ctx.baseDir ? '' : ' (the global file needs absolute paths)';
      ctx.errors.push(`${ctx.file}: ${field}[${i}] "${raw}" is not a usable Windows path${hint}`);
      return;
    }
    out.push({ raw, path: resolved, reason });
  });
  return out;
}

// Glob segments for a gitignore-style filename pattern. Relative patterns match at any depth, with or without a
// slash (`.env`, `*.pem`, `config/*.key`); absolute ones (`C:/data/**/*.csv`, `~/.aws/*`) match from that root.
function patternSegments(raw, baseDir) {
  const expanded = P.expandVars(raw.trim(), { cwd: baseDir || P.homeDir() });
  const s = P.toWindowsPath(expanded).replace(/\/+$/, '');
  if (P.isAbsoluteLike(s)) return P.segmentsOf(s);
  const segs = s.replace(/^(?:\.\/)+/, '').normalize('NFC').toLowerCase().split('/').filter(Boolean);
  if (!segs.length || segs.some((x) => x === '.' || x === '..')) return null;
  return segs[0] === '**' ? segs : ['**', ...segs];
}

function parsePatterns(list, ctx) {
  const positives = [];
  const negations = [];
  const exceptions = [];
  if (list === undefined) return { positives, negations, exceptions };
  if (!Array.isArray(list)) {
    ctx.errors.push(`${ctx.file}: "restrictedPatterns" must be an array`);
    return { positives, negations, exceptions };
  }
  list.forEach((item, i) => {
    const isObject = item && typeof item === 'object' && !Array.isArray(item);
    const raw = typeof item === 'string' ? item : isObject ? item.pattern : undefined;
    const reason = isObject && typeof item.reason === 'string' ? item.reason : '';
    if (typeof raw !== 'string' || !raw.trim() || raw.trim() === '!') {
      ctx.errors.push(`${ctx.file}: restrictedPatterns[${i}] must be a pattern string or { "pattern": ..., "reason": ... }`);
      return;
    }
    const negated = raw.trim().startsWith('!');
    const text = negated ? raw.trim().slice(1) : raw.trim();
    const segs = patternSegments(text, ctx.baseDir);
    if (!segs) {
      ctx.errors.push(`${ctx.file}: restrictedPatterns[${i}] "${raw}" is not a usable pattern`);
      return;
    }
    if (negated) {
      negations.push(segs);
      exceptions.push(text);
    } else {
      positives.push({ raw: text, segs, reason });
    }
  });
  return { positives, negations, exceptions };
}

function buildPatternRule(id, entry, source, patterns, allowEntries) {
  return {
    id,
    kind: 'restricted',
    path: null,
    pattern: entry.raw,
    patternSegs: entry.segs,
    negations: patterns.negations,
    exceptions: patterns.exceptions,
    raw: entry.raw,
    reason: entry.reason,
    reasonKey: null,
    source,
    allow: allowEntries.flatMap((a) => pathForms(a.path).segForms),
    segForms: [],
    textForms: [],
  };
}

function pathForms(p) {
  const segForms = [P.segmentsOf(p)];
  const textForms = [P.canonPathText(p)];
  const real = P.realpathLoose(p);
  const realSegs = real && P.segmentsOf(real);
  if (realSegs && realSegs.join('/') !== segForms[0].join('/')) {
    segForms.push(realSegs);
    textForms.push(P.canonPathText(real));
  }
  return { segForms, textForms: [...new Set(textForms)] };
}

function buildRule(id, kind, entry, source, allowEntries) {
  const forms = pathForms(entry.path);
  const allow = [];
  for (const a of allowEntries) {
    const aForms = pathForms(a.path).segForms;
    if (aForms.some((s) => forms.segForms.some((r) => P.relate(s, r) === 'inside'))) allow.push(...aForms);
  }
  return {
    id,
    kind,
    path: entry.path,
    raw: entry.raw,
    reason: entry.reason || '',
    reasonKey: entry.reasonKey || null,
    source,
    allow,
    segForms: forms.segForms,
    textForms: forms.textForms,
  };
}

function isValidOption(key, value) {
  if (ENUMS[key]) return ENUMS[key].includes(value);
  if (NUMBERS[key]) return Number.isInteger(value) && value >= NUMBERS[key][0] && value <= NUMBERS[key][1];
  if (key === 'auditLog') return typeof value === 'boolean' || (typeof value === 'string' && value.trim() !== '');
  return typeof value === 'boolean';
}

function stricter(key, a, b) {
  if (ENUMS[key]) return ENUMS[key][Math.max(ENUMS[key].indexOf(a), ENUMS[key].indexOf(b))];
  if (NUMBERS[key]) return Math.max(a, b);
  if (TIGHTENING_BOOLEANS.has(key)) return a || b;
  return a;
}

function mergeOptions(current, raw, src, warnings) {
  if (raw === undefined) return current;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${src.file}: "options" must be an object`);
    return current;
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_OPTIONS)) {
      warnings.push(`${src.file}: unknown option "${key}"`);
    } else if (!isValidOption(key, value)) {
      warnings.push(`${src.file}: invalid value for option "${key}" (kept ${JSON.stringify(current[key])})`);
    } else if (src.scope === 'global') {
      next[key] = value;
    } else if (GLOBAL_ONLY.has(key)) {
      warnings.push(`${src.file}: option "${key}" is only read from the global config`);
    } else {
      next[key] = stricter(key, current[key], value);
    }
  }
  return next;
}

function resolveAuditLog(option) {
  if (option === false) return null;
  if (option === true) return win.join(claudeDir(), 'directory-block', 'audit.jsonl');
  return resolveEntryPath(option, null);
}

// The config files, the audit log and the plugin itself, so Claude cannot loosen or erase its own restrictions.
function protectedEntries({ sources, auditLogPath, pluginRoot, options, projectDir }) {
  const entries = sources.map((src) => ({ path: src.file, reasonKey: src.scope === 'global' ? 'globalConfig' : 'projectConfig' }));
  if (auditLogPath) entries.push({ path: auditLogPath, reasonKey: 'auditLog' });
  if (options.protectPluginRoot && pluginRoot) {
    const root = resolveEntryPath(pluginRoot, null);
    if (root) entries.push({ path: root, reasonKey: 'pluginRoot' });
  }
  if (options.protectClaudeSettings) {
    const dirs = [claudeDir()];
    if (projectDir) dirs.push(win.join(win.resolve(projectDir), '.claude'));
    for (const dir of dirs) {
      entries.push({ path: win.join(dir, 'settings.json'), reasonKey: 'claudeSettings' });
      entries.push({ path: win.join(dir, 'settings.local.json'), reasonKey: 'claudeSettings' });
    }
  }
  return entries.map((e, i) => buildRule(`protected:${i}`, 'protected', { raw: e.path, path: e.path, reasonKey: e.reasonKey }, 'self', []));
}

function loadConfig({ projectDir, pluginRoot } = {}) {
  const errors = [];
  const warnings = [];
  const files = [];
  const rules = [];
  let options = { ...DEFAULT_OPTIONS };

  const sources = [{ scope: 'global', file: globalConfigPath(), baseDir: null }];
  if (projectDir) {
    const file = projectConfigPath(projectDir);
    if (file.toLowerCase() !== sources[0].file.toLowerCase()) {
      sources.push({ scope: 'project', file, baseDir: win.resolve(projectDir) });
    }
  }

  for (const src of sources) {
    const res = readJsonFile(src.file);
    files.push({ scope: src.scope, file: src.file, exists: res.exists, error: res.error || null });
    if (!res.exists) continue;
    if (res.error) {
      errors.push(`${src.file}: ${res.error}`);
      continue;
    }
    const { data } = res;
    for (const key of Object.keys(data)) {
      if (!KNOWN_KEYS.has(key)) warnings.push(`${src.file}: unknown key "${key}"`);
    }
    const ctx = { file: src.file, baseDir: src.baseDir, errors };
    const allow = parseEntries(data.allow, 'allow', ctx);
    parseEntries(data.restricted, 'restricted', ctx).forEach((entry, i) => {
      rules.push(buildRule(`${src.scope}:${i}`, 'restricted', entry, src.scope, allow));
    });
    const patterns = parsePatterns(data.restrictedPatterns, ctx);
    patterns.positives.forEach((entry, i) => {
      rules.push(buildPatternRule(`${src.scope}:pattern:${i}`, entry, src.scope, patterns, allow));
    });
    options = mergeOptions(options, data.options, src, warnings);
  }

  const auditLogPath = resolveAuditLog(options.auditLog);
  if (options.selfProtect) {
    rules.push(...protectedEntries({ sources, auditLogPath, pluginRoot, options, projectDir }));
  }

  return {
    rules,
    options,
    errors,
    warnings,
    files,
    auditLogPath,
    globalFile: sources[0].file,
    projectFile: sources[1] ? sources[1].file : null,
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  claudeDir,
  globalConfigPath,
  loadConfig,
  projectConfigPath,
  readJsonFile,
  resolveEntryPath,
};
