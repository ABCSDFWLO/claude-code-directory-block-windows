#!/usr/bin/env node
'use strict';

// Manage and test directory-block from your own terminal. Claude cannot run this: the plugin directory and the
// config files are protected from shell access.

const fs = require('fs');
const path = require('path');
const { globalConfigPath, loadConfig, projectConfigPath, readJsonFile, resolveEntryPath } = require('./lib/config');
const { analyzeToolCall } = require('./lib/analyzer');
const { formatReason, ruleReason } = require('./lib/messages');

const win = path.win32;

const USAGE = `directory-block CLI

  node cli.js list [--project DIR]
      Show config files, restricted paths, protected files and options.

  node cli.js check [--cwd DIR] [--tool Bash|PowerShell|Read|Write|Edit|Glob|Grep] -- <command or path>
      Show whether a tool call would be blocked.

  node cli.js init [--project DIR]
      Create an empty config file (global by default).

  node cli.js add <path> [--reason TEXT] [--allow] [--project DIR]
  node cli.js remove <path> [--allow] [--project DIR]
      Add or remove a restricted path (or, with --allow, an exception inside one).

  node cli.js add --pattern <pattern> [--reason TEXT] [--project DIR]
  node cli.js remove --pattern <pattern> [--project DIR]
      Add or remove a filename pattern such as .env, .env.* or *.pem ('!.env.example' adds an exception).
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.rest = argv.slice(i + 1).join(' ');
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function targetFile(flags) {
  if (!flags.project) return globalConfigPath();
  return projectConfigPath(flags.project === true ? process.cwd() : flags.project);
}

function loadRaw(file) {
  const res = readJsonFile(file);
  if (!res.exists) return {};
  if (res.error) throw new Error(`${file}: ${res.error}`);
  return res.data;
}

function save(file, data) {
  fs.mkdirSync(win.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`saved ${file}`);
}

function cmdList(flags) {
  const projectDir = flags.project ? (flags.project === true ? process.cwd() : flags.project) : process.cwd();
  const config = loadConfig({ projectDir, pluginRoot: win.resolve(__dirname, '..') });
  console.log('Config files:');
  for (const f of config.files) {
    const state = f.error ? `ERROR: ${f.error}` : f.exists ? 'loaded' : 'not found';
    console.log(`  [${f.scope}] ${f.file} (${state})`);
  }
  console.log('\nRestricted paths:');
  const restricted = config.rules.filter((r) => r.kind === 'restricted' && !r.pattern);
  if (!restricted.length) console.log('  (none)');
  for (const r of restricted) {
    console.log(`  [${r.source}] ${r.path}${r.reason ? `  — ${r.reason}` : ''}`);
    for (const extra of r.segForms.slice(1)) console.log(`      real path: ${extra.join('\\')}`);
  }
  console.log('\nRestricted file patterns:');
  const patterns = config.rules.filter((r) => r.pattern);
  if (!patterns.length) console.log('  (none)');
  for (const r of patterns) console.log(`  [${r.source}] ${r.pattern}${r.reason ? `  — ${r.reason}` : ''}`);
  const exceptions = [...new Set(patterns.flatMap((r) => r.exceptions))];
  if (exceptions.length) console.log(`  exceptions: ${exceptions.map((e) => `!${e}`).join(', ')}`);
  console.log('\nProtected (self-protection):');
  for (const r of config.rules.filter((x) => x.kind === 'protected')) console.log(`  ${r.path}  — ${ruleReason(r, 'en')}`);
  console.log('\nOptions:');
  for (const [k, v] of Object.entries(config.options)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  for (const e of config.errors) console.log(`\nERROR: ${e}`);
  for (const w of config.warnings) console.log(`warning: ${w}`);
}

function cmdCheck(args) {
  const subject = args.rest || args._.slice(1).join(' ');
  if (!subject) throw new Error('nothing to check; pass the command after --');
  const cwd = win.resolve(args.flags.cwd || process.cwd());
  const tool = args.flags.tool || 'Bash';
  const toolInput = ['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool) ? { file_path: subject }
    : tool === 'Glob' ? { pattern: subject }
      : tool === 'Grep' ? { pattern: 'x', path: subject }
        : { command: subject };
  const config = loadConfig({ projectDir: cwd, pluginRoot: win.resolve(__dirname, '..') });
  if (config.errors.length) {
    console.log(`BLOCKED (config errors):\n${config.errors.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  const { violations } = analyzeToolCall({ toolName: tool, toolInput, cwd, config });
  if (!violations.length) {
    console.log('ALLOWED');
    return;
  }
  const decision = config.options.onViolation === 'ask' && violations.every((v) => v.rule && v.rule.kind === 'restricted') ? 'ask' : 'deny';
  console.log(`${decision === 'ask' ? 'ASK' : 'BLOCKED'}\n${formatReason(violations, { lang: config.options.language, decision })}`);
  process.exitCode = 1;
}

function cmdInit(flags) {
  const file = targetFile(flags);
  if (fs.existsSync(file)) {
    console.log(`already exists: ${file}`);
    return;
  }
  save(file, { restricted: [], allow: [], options: flags.project ? {} : { onViolation: 'deny', language: 'ko' } });
}

function sameEntry(entry, resolved, baseDir) {
  const raw = typeof entry === 'string' ? entry : entry && entry.path;
  const p = raw && resolveEntryPath(raw, baseDir);
  return Boolean(p) && p.toLowerCase() === resolved.toLowerCase();
}

function cmdPattern(args, adding) {
  const input = typeof args.flags.pattern === 'string' ? args.flags.pattern : args._[1];
  if (!input || !input.trim()) throw new Error(`usage: ${adding ? 'add' : 'remove'} --pattern <pattern>`);
  const pattern = input.trim();
  const file = targetFile(args.flags);
  const data = loadRaw(file);
  const list = Array.isArray(data.restrictedPatterns) ? data.restrictedPatterns : [];
  const same = (e) => String(typeof e === 'string' ? e : e && e.pattern).trim().toLowerCase() === pattern.toLowerCase();
  const kept = list.filter((e) => !same(e));
  if (adding) {
    const reason = typeof args.flags.reason === 'string' ? args.flags.reason : '';
    kept.push(reason ? { pattern, reason } : pattern);
    console.log(`restrictedPatterns: + ${pattern}`);
  } else if (kept.length === list.length) {
    console.log(`not found in restrictedPatterns: ${pattern}`);
    return;
  } else {
    console.log(`restrictedPatterns: - ${pattern}`);
  }
  data.restrictedPatterns = kept;
  save(file, data);
}

function cmdAddRemove(args, adding) {
  if (args.flags.pattern) {
    cmdPattern(args, adding);
    return;
  }
  const input = args._[1];
  if (!input) throw new Error(`usage: ${adding ? 'add' : 'remove'} <path>`);
  const file = targetFile(args.flags);
  const baseDir = args.flags.project ? win.dirname(win.dirname(file)) : null;
  const resolved = resolveEntryPath(input, baseDir || process.cwd());
  if (!resolved) throw new Error(`not a usable path: ${input}`);
  const field = args.flags.allow ? 'allow' : 'restricted';
  const data = loadRaw(file);
  const list = Array.isArray(data[field]) ? data[field] : [];
  const kept = list.filter((e) => !sameEntry(e, resolved, baseDir));
  if (adding) {
    const reason = typeof args.flags.reason === 'string' ? args.flags.reason : '';
    kept.push(reason ? { path: resolved, reason } : resolved);
    console.log(`${field}: + ${resolved}`);
  } else if (kept.length === list.length) {
    console.log(`not found in ${field}: ${resolved}`);
    return;
  } else {
    console.log(`${field}: - ${resolved}`);
  }
  data[field] = kept;
  save(file, data);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args._[0]) {
    case 'list':
      cmdList(args.flags);
      break;
    case 'check':
      cmdCheck(args);
      break;
    case 'init':
      cmdInit(args.flags);
      break;
    case 'add':
      cmdAddRemove(args, true);
      break;
    case 'remove':
      cmdAddRemove(args, false);
      break;
    default:
      console.log(USAGE);
  }
}

try {
  main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 2;
}
