'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'directory-block');
const LIB = path.join(PLUGIN, 'scripts', 'lib');

const { loadConfig } = require(path.join(LIB, 'config.js'));
const { analyzeToolCall } = require(path.join(LIB, 'analyzer.js'));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const fwd = (p) => p.replace(/\\/g, '/');
const gitBash = (p) => `/${p[0].toLowerCase()}${fwd(p.slice(2))}`;
const psBase64 = (text) => Buffer.from(text, 'utf16le').toString('base64');

// A throwaway tree:
//   root/secrets (restricted, with an allowed public/ subfolder), root/My Secrets (restricted),
//   root/home/.ssh (restricted via ~), root/proj/private (restricted by the project config),
//   root/proj/link -> root/secrets (junction), plus scripts and decoys with look-alike names.
function createFixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dirblock-')));
  const p = (...parts) => path.join(root, ...parts);
  const fx = {
    root,
    p,
    home: p('home'),
    proj: p('proj'),
    secrets: p('secrets'),
    spaced: p('My Secrets'),
    claude: p('claude'),
    pluginRoot: p('plugin-root'),
  };

  write(p('secrets', 'a.txt'), 'top secret');
  write(p('secrets', 'inner.ps1'), 'Write-Output TOPSECRETWORD\n');
  write(p('secrets', 'public', 'readme.txt'), 'shareable');
  write(p('secrets2', 'x.txt'), 'look-alike sibling');
  write(p('secrets.txt'), 'look-alike file');
  write(p('My Secrets', 'x.txt'), 'secret');
  write(p('home', '.ssh', 'id_rsa'), 'key');
  write(p('home', 'notes.txt'), 'notes');
  write(p('plugin-root', 'scripts', 'guard.js'), '// plugin');

  write(p('proj', 'src', 'app.py'), 'print("hi")\n');
  write(p('proj', 'private', 'notes.txt'), 'private');
  write(p('proj', 'run.ps1'), 'Get-Content "$PSScriptRoot\\..\\secrets\\a.txt"\n');
  write(p('proj', 'benign.ps1'), 'Write-Output "hello"\nGet-ChildItem src\n');
  write(p('proj', 'tool.py'), `import os\nbase = os.path.join(r"${root}", "secrets")\nprint(open(os.path.join(base, "a.txt")).read())\n`);
  write(p('proj', 'deploy'), '#!/bin/sh\ncat ../secrets/a.txt\n');
  write(p('proj', 'notes.md'), `See ${p('secrets')} for details.\n`);
  write(p('proj', 'package.json'), JSON.stringify({ scripts: { build: 'node src/build.js' } }, null, 2));
  write(p('proj', 'pkg', 'package.json'), JSON.stringify({ scripts: { leak: 'cat ../../secrets/a.txt' } }, null, 2));
  write(p('proj', '.claude', 'directory-block.json'), JSON.stringify({ restricted: [{ path: 'private', reason: 'project-private' }] }));

  fs.symlinkSync(p('secrets'), p('proj', 'link'), 'junction');

  write(p('claude', 'directory-block.json'), JSON.stringify({
    restricted: [fx.secrets, { path: fx.spaced, reason: 'spaced' }, '~\\.ssh'],
    allow: [p('secrets', 'public')],
  }, null, 2));

  return fx;
}

function useFixtureEnv(fx) {
  const saved = {};
  for (const key of ['CLAUDE_CONFIG_DIR', 'USERPROFILE', 'HOME', 'DB_TEST_ROOT']) saved[key] = process.env[key];
  process.env.CLAUDE_CONFIG_DIR = fx.claude;
  process.env.USERPROFILE = fx.home;
  process.env.HOME = fx.home;
  process.env.DB_TEST_ROOT = fx.root;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function removeFixture(fx) {
  try {
    fs.unlinkSync(fx.p('proj', 'link'));
  } catch {
    // already gone
  }
  fs.rmSync(fx.root, { recursive: true, force: true });
}

function analyze(fx, { tool = 'Bash', input, cwd, projectDir, pluginRoot, options } = {}) {
  const config = loadConfig({ projectDir: projectDir || fx.proj, pluginRoot });
  if (config.errors.length) throw new Error(config.errors.join('\n'));
  Object.assign(config.options, options);
  return analyzeToolCall({ toolName: tool, toolInput: input, cwd: cwd || fx.proj, config }).violations;
}

module.exports = { PLUGIN, LIB, analyze, createFixture, fwd, gitBash, psBase64, removeFixture, useFixtureEnv, write };
