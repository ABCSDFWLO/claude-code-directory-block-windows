'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LIB, write } = require('./helpers');

const { loadConfig } = require(path.join(LIB, 'config.js'));
const { analyzeToolCall } = require(path.join(LIB, 'analyzer.js'));

// root/proj    .env  .env.local  .env.example  config/prod.env  certs/server.pem  certs/server.key  src/...
// root/web     only a hidden .env next to index.js
// root/pkgdir  a .env that exists only inside node_modules
let root;
let saved;
const p = (...parts) => path.join(root, ...parts);

before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dirblock-pat-')));
  write(p('proj', '.env'), 'API_KEY=SENTINEL\n');
  write(p('proj', '.env.local'), 'API_KEY=SENTINEL\n');
  write(p('proj', '.env.example'), 'API_KEY=\n');
  write(p('proj', 'config', 'prod.env'), 'API_KEY=SENTINEL\n');
  write(p('proj', 'config', 'app.json'), '{}\n');
  write(p('proj', 'certs', 'server.pem'), 'PEM\n');
  write(p('proj', 'certs', 'server.key'), 'KEY\n');
  write(p('proj', 'src', 'app.js'), "require('dotenv').config();\nconsole.log(process.env.API_KEY);\n");
  write(p('proj', 'src', 'util.ts'), 'export const x = 1;\n');
  write(p('proj', 'run.sh'), '#!/bin/sh\ncat .env\n');
  write(p('proj', 'clean', 'a.txt'), 'nothing\n');
  write(p('web', '.env'), 'API_KEY=SENTINEL\n');
  write(p('web', 'index.js'), 'console.log(1);\n');
  write(p('pkgdir', 'node_modules', 'dep', '.env'), 'X=1\n');
  write(p('pkgdir', 'index.js'), 'console.log(1);\n');
  // Created up front: directory listings are cached for the life of the process, as in one hook run.
  write(p('proj2', '.claude', 'directory-block.json'), JSON.stringify({ restrictedPatterns: ['*.sqlite'] }));
  write(p('proj2', 'data.sqlite'), 'db');
  write(p('claude', 'directory-block.json'), JSON.stringify({
    restrictedPatterns: ['.env', '.env.*', '!.env.example', '*.env', '*.pem', { pattern: 'certs/*.key', reason: 'TLS keys' }],
  }));
  saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, DIRECTORY_BLOCK_CONFIG: process.env.DIRECTORY_BLOCK_CONFIG };
  process.env.CLAUDE_CONFIG_DIR = p('claude');
  delete process.env.DIRECTORY_BLOCK_CONFIG;
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function check(tool, input, { cwd = p('proj'), options } = {}) {
  const config = loadConfig({ projectDir: cwd });
  assert.deepEqual(config.errors, []);
  Object.assign(config.options, options);
  return analyzeToolCall({ toolName: tool, toolInput: input, cwd, config }).violations;
}

const shell = (command, opts = {}) => check(opts.tool || 'Bash', { command }, opts);
const blocked = (v, label) => assert.ok(v.length > 0, `expected a block for: ${label}`);
const allowed = (v, label) => assert.deepEqual(v.map((x) => `${x.type}: ${x.evidence} -> ${x.resolved}`), [], `expected no block for: ${label}`);

describe('filename patterns: blocked', () => {
  const cases = [
    ['cat .env', () => 'cat .env'],
    ['PowerShell Get-Content .\\.env.local', () => 'Get-Content .\\.env.local', { tool: 'PowerShell' }],
    ['*.env in a subfolder', () => 'type config\\prod.env'],
    ['absolute path', () => `cat ${p('proj', '.env').replace(/\\/g, '/')}`],
    ['different letter case', () => 'cat .ENV'],
    ['source .env', () => 'source .env'],
    ['docker --env-file', () => 'docker compose --env-file .env up'],
    ['python open()', () => `python -c "print(open('.env').read())"`],
    ['*.pem', () => 'cat certs/server.pem'],
    ['pattern with a folder (certs/*.key)', () => 'cat certs/server.key'],
    ['wildcard that expands to a protected file', () => 'cat config/*'],
    ['PowerShell * includes dotfiles', () => 'Get-Content *', { tool: 'PowerShell' }],
    ['writing a new .env via redirect', () => 'echo KEY=1 > web2.env'],
    ['copying over .env', () => 'cp .env.example .env'],
    ['script that reads .env', () => 'bash run.sh'],
    ['grep -r over a folder with .env', () => 'grep -r API_KEY .'],
    ['grep -r with no path', () => 'grep -rn API_KEY'],
    ['rg finds non-hidden *.env files', () => 'rg API_KEY'],
    ['rg --hidden', () => 'rg --hidden API_KEY', { cwd: p('web') }],
    ['Get-ChildItem -Recurse | Select-String', () => 'Get-ChildItem -Recurse | Select-String API_KEY', { tool: 'PowerShell' }],
    ['tar of the project', () => 'tar -czf out.tgz .'],
    ['cp -r of the project', () => `cp -r . ${p('backup').replace(/\\/g, '/')}`],
    ['findstr /s', () => 'findstr /s API_KEY *'],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => blocked(shell(command(), opts), label));
  }

  it('reports the matched pattern and the file', () => {
    const [v] = shell('cat .env');
    assert.equal(v.type, 'pattern');
    assert.equal(v.rule.pattern, '.env');
    assert.equal(v.resolved.toLowerCase(), p('proj', '.env').toLowerCase());
  });

  it('names the protected file found under a recursive read', () => {
    const v = shell('grep -r API_KEY .', { cwd: p('web') });
    assert.equal(v[0].type, 'pattern-recursive');
    assert.equal(v[0].resolved.toLowerCase(), p('web', '.env').toLowerCase());
  });
});

describe('filename patterns: allowed', () => {
  const cases = [
    ['negated exception .env.example', () => 'cat .env.example'],
    ['code that mentions process.env', () => 'node -e "const e = process.env; console.log(e.NODE_ENV)"'],
    ['assignment of process.env', () => 'node -e "x=process.env"'],
    ['commit message mentioning .env', () => 'git commit -m "ignore .env files"'],
    ['echo .env into .gitignore', () => 'echo .env >> .gitignore'],
    ['non-recursive listing', () => 'ls -la'],
    ['recursive listing without reading', () => 'ls -R'],
    ['find by name only', () => 'find . -name "*.ts"'],
    ['other files in the same folder', () => 'cat config/app.json'],
    ['grep -r in a folder without protected files', () => 'grep -r API_KEY src'],
    ['rg skips hidden files by default', () => 'rg API_KEY', { cwd: p('web') }],
    ['grep -r with --exclude', () => "grep -r --exclude='.env*' API_KEY .", { cwd: p('web') }],
    ['grep -r with --include', () => "grep -r --include='*.js' API_KEY .", { cwd: p('web') }],
    ['rg with a negated glob', () => "rg --hidden -g '!.env' API_KEY", { cwd: p('web') }],
    ['protected files only inside node_modules', () => 'grep -r foo .', { cwd: p('pkgdir') }],
    ['bash * skips dotfiles', () => 'cat *', { cwd: p('web') }],
    ['a script that loads dotenv implicitly (known limit)', () => 'node src/app.js'],
    ['recursive read check turned off', () => 'grep -r API_KEY .', { cwd: p('web'), options: { checkPatternsInRecursiveReads: false } }],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => allowed(shell(command(), opts), label));
  }
});

describe('filename patterns: file tools', () => {
  it('blocks Read of .env', () => blocked(check('Read', { file_path: p('proj', '.env') }), 'Read .env'));
  it('blocks Write of a new .env', () => blocked(check('Write', { file_path: p('proj', 'sub', '.env'), content: 'x' }), 'Write .env'));
  it('blocks Edit of prod.env', () => blocked(check('Edit', { file_path: p('proj', 'config', 'prod.env'), old_string: 'a', new_string: 'b' }), 'Edit'));
  it('allows Read of .env.example', () => allowed(check('Read', { file_path: p('proj', '.env.example') }), 'Read example'));
  it('allows Glob for .env files (names only)', () => allowed(check('Glob', { pattern: '**/.env*' }), 'Glob'));
  it('blocks Grep over a folder holding .env', () => {
    const v = check('Grep', { pattern: 'API_KEY', path: p('web') });
    assert.equal(v[0].type, 'pattern-recursive');
  });
  it('allows Grep with an include glob', () => allowed(check('Grep', { pattern: 'API_KEY', path: p('web'), glob: '*.js' }), 'Grep *.js'));
  it('allows Grep with a negated glob', () => allowed(check('Grep', { pattern: 'API_KEY', path: p('web'), glob: '!.env*' }), 'Grep !.env*'));
  it('allows Grep in a folder without protected files', () => allowed(check('Grep', { pattern: 'x', path: p('proj', 'src') }), 'Grep src'));
  it('blocks Grep pointed at a protected file', () => blocked(check('Grep', { pattern: 'x', path: p('proj', '.env') }), 'Grep .env'));
});

describe('filename patterns: config', () => {
  it('parses patterns, reasons and exceptions', () => {
    const config = loadConfig({ projectDir: p('proj') });
    const rules = config.rules.filter((r) => r.pattern);
    assert.deepEqual(rules.map((r) => r.pattern), ['.env', '.env.*', '*.env', '*.pem', 'certs/*.key']);
    assert.equal(rules[4].reason, 'TLS keys');
    assert.deepEqual(rules[0].exceptions, ['.env.example']);
  });

  it('lets a project add patterns', () => {
    const config = loadConfig({ projectDir: p('proj2') });
    assert.ok(config.rules.some((r) => r.pattern === '*.sqlite' && r.source === 'project'));
    const v = analyzeToolCall({ toolName: 'Bash', toolInput: { command: 'cat data.sqlite' }, cwd: p('proj2'), config }).violations;
    blocked(v, 'project pattern');
  });

  it('rejects empty and bare-negation patterns', () => {
    const dir = p('claude-bad');
    write(path.join(dir, 'directory-block.json'), JSON.stringify({ restrictedPatterns: ['', '!', '../x'] }));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      assert.equal(loadConfig({}).errors.length, 3);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
