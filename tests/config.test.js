'use strict';

const path = require('path');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LIB, createFixture, removeFixture, useFixtureEnv, write } = require('./helpers');

const { loadConfig } = require(path.join(LIB, 'config.js'));
const P = require(path.join(LIB, 'paths.js'));

let fx;
let restoreEnv;

before(() => {
  fx = createFixture();
  restoreEnv = useFixtureEnv(fx);
});

after(() => {
  restoreEnv();
  removeFixture(fx);
});

function withGlobal(data, fn) {
  const dir = fx.p(`claude-${Math.random().toString(36).slice(2)}`);
  write(path.join(dir, 'directory-block.json'), typeof data === 'string' ? data : JSON.stringify(data));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn(dir);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

describe('loadConfig', () => {
  it('merges global and project restrictions', () => {
    const config = loadConfig({ projectDir: fx.proj });
    const restricted = config.rules.filter((r) => r.kind === 'restricted').map((r) => r.path.toLowerCase());
    assert.deepEqual(restricted, [fx.secrets, fx.spaced, fx.p('home', '.ssh'), fx.p('proj', 'private')].map((p) => p.toLowerCase()));
    assert.deepEqual(config.errors, []);
  });

  it('expands ~, %VAR% and $env:VAR in entries', () => {
    withGlobal({ restricted: ['~\\a', '%DB_TEST_ROOT%\\b', '$env:DB_TEST_ROOT\\c'] }, () => {
      const paths = loadConfig({}).rules.filter((r) => r.kind === 'restricted').map((r) => r.path);
      assert.deepEqual(paths, [fx.p('home', 'a'), fx.p('b'), fx.p('c')]);
    });
  });

  it('accepts a bare drive letter as the whole drive', () => {
    withGlobal({ restricted: ['Q:'] }, () => {
      assert.equal(loadConfig({}).rules[0].path, 'Q:\\');
    });
  });

  it('rejects relative paths in the global file', () => {
    withGlobal({ restricted: ['relative\\dir'] }, () => {
      assert.match(loadConfig({}).errors[0], /not a usable Windows path/);
    });
  });

  it('reports invalid JSON as an error', () => {
    withGlobal('{ nope', () => {
      assert.match(loadConfig({}).errors[0], /invalid JSON/);
    });
  });

  it('lets the project file tighten options but never loosen them', () => {
    withGlobal({ restricted: [], options: { onViolation: 'ask', scanScripts: false, encodedCommands: 'decode' } }, () => {
      write(fx.p('proj2', '.claude', 'directory-block.json'), JSON.stringify({
        options: { onViolation: 'deny', scanScripts: true, encodedCommands: 'allow', selfProtect: false, language: 'en' },
      }));
      const config = loadConfig({ projectDir: fx.p('proj2') });
      assert.equal(config.options.onViolation, 'deny');
      assert.equal(config.options.scanScripts, true);
      assert.equal(config.options.encodedCommands, 'decode');
      assert.equal(config.options.selfProtect, true);
      assert.equal(config.options.language, 'ko');
      assert.ok(config.warnings.some((w) => /only read from the global config/.test(w)));
    });
  });

  it('keeps the default for an invalid option value and warns', () => {
    withGlobal({ options: { onViolation: 'allow' } }, () => {
      const config = loadConfig({});
      assert.equal(config.options.onViolation, 'deny');
      assert.ok(config.warnings.length > 0);
    });
  });

  it('only applies allow entries that sit inside a restricted path', () => {
    const config = loadConfig({ projectDir: fx.proj });
    const secrets = config.rules.find((r) => r.path.toLowerCase() === fx.secrets.toLowerCase());
    assert.equal(secrets.allow.length > 0, true);
    const ssh = config.rules.find((r) => r.path.toLowerCase().endsWith('.ssh'));
    assert.equal(ssh.allow.length, 0);
  });

  it('protects the config files and audit log, and the plugin root when given', () => {
    const config = loadConfig({ projectDir: fx.proj, pluginRoot: fx.pluginRoot });
    const kinds = config.rules.filter((r) => r.kind === 'protected').map((r) => r.reasonKey);
    assert.deepEqual(kinds, ['globalConfig', 'projectConfig', 'auditLog', 'pluginRoot']);
  });

  it('adds Claude settings files with protectClaudeSettings', () => {
    withGlobal({ options: { protectClaudeSettings: true } }, () => {
      const keys = loadConfig({ projectDir: fx.proj }).rules.map((r) => r.reasonKey).filter((k) => k === 'claudeSettings');
      assert.equal(keys.length, 4);
    });
  });
});

describe('paths', () => {
  it('normalizes Windows path spellings', () => {
    assert.equal(P.toWindowsPath('/c/Users/x'), 'c:/Users/x');
    assert.equal(P.toWindowsPath('/mnt/d/data'), 'd:/data');
    assert.equal(P.toWindowsPath('\\\\?\\C:\\x'), 'C:/x');
    assert.equal(P.toWindowsPath('\\\\?\\UNC\\srv\\share\\x'), '//srv/share/x');
    assert.equal(P.toWindowsPath('file:///C:/x'), 'C:/x');
    assert.equal(P.toWindowsPath('FileSystem::C:\\x'), 'C:/x');
    assert.equal(P.toWindowsPath('\\\\localhost\\d$\\x'), 'd:/x');
  });

  it('relates paths, globs and ancestors', () => {
    const r = P.segmentsOf('C:\\Data\\Secret');
    assert.equal(P.relate(P.segmentsOf('c:/data/secret/x.txt'), r), 'inside');
    assert.equal(P.relate(P.segmentsOf('C:\\DATA\\SECRET'), r), 'inside');
    assert.equal(P.relate(P.segmentsOf('C:\\Data'), r), 'ancestor');
    assert.equal(P.relate(P.segmentsOf('C:\\Data\\Secret2'), r), null);
    assert.equal(P.relate(P.segmentsOf('C:\\Data\\Sec*\\x'), r), 'inside');
    assert.equal(P.relate(P.segmentsOf('C:\\**\\x'), r), 'inside');
    assert.equal(P.relate(P.segmentsOf('C:\\Data\\*.txt'), r), null);
    assert.equal(P.relate(P.segmentsOf('C:\\Data\\Secret. \\x'), r), 'inside');
    assert.equal(P.relate(P.segmentsOf('\\\\srv\\share\\x'), P.segmentsOf('\\\\SRV\\Share')), 'inside');
  });

  it('expands variables in every shell dialect', () => {
    const ctx = { cwd: 'C:\\work' };
    assert.equal(P.expandVars('%DB_TEST_ROOT%\\x', ctx), `${fx.root}\\x`);
    assert.equal(P.expandVars('$env:DB_TEST_ROOT\\x', ctx), `${fx.root}\\x`);
    assert.equal(P.expandVars('${env:DB_TEST_ROOT}\\x', ctx), `${fx.root}\\x`);
    assert.equal(P.expandVars('cat ~/x', ctx), `cat ${fx.home}/x`);
    assert.equal(P.expandVars('$PWD/x', ctx), 'C:\\work/x');
    assert.equal(P.expandVars("os.environ['DB_TEST_ROOT']", ctx), fx.root);
    assert.equal(P.expandVars('$path; $x; $PATH', ctx), '$path; $x; $PATH');
  });
});
