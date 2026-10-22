'use strict';

// Runs the real hook scripts as child processes, the way Claude Code does.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PLUGIN, createFixture, removeFixture, write } = require('./helpers');

const GUARD = path.join(PLUGIN, 'scripts', 'guard.js');
const SESSION_START = path.join(PLUGIN, 'scripts', 'session-start.js');

let fx;

before(() => {
  fx = createFixture();
});

after(() => removeFixture(fx));

function env(extra = {}) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: fx.claude,
    USERPROFILE: fx.home,
    HOME: fx.home,
    CLAUDE_PROJECT_DIR: fx.proj,
    CLAUDE_PLUGIN_ROOT: fx.pluginRoot,
    ...extra,
  };
}

function run(script, input, extraEnv) {
  const res = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: env(extraEnv),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  return res.stdout ? JSON.parse(res.stdout) : null;
}

function hook(toolName, toolInput, extra = {}) {
  return run(GUARD, {
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    cwd: extra.cwd || fx.proj,
    tool_name: toolName,
    tool_input: toolInput,
  }, extra.env);
}

function decisionOf(out) {
  return out && out.hookSpecificOutput ? out.hookSpecificOutput.permissionDecision : 'none';
}

describe('guard.js', () => {
  it('denies a restricted shell command with a PreToolUse decision', () => {
    const out = hook('Bash', { command: `cat ${fx.secrets}\\a.txt` });
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(decisionOf(out), 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /directory-block/);
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(fx.secrets));
  });

  it('prints nothing for an allowed command', () => {
    assert.equal(hook('Bash', { command: 'git status' }), null);
    assert.equal(hook('PowerShell', { command: 'Get-ChildItem src' }), null);
  });

  it('checks the PowerShell tool', () => {
    assert.equal(decisionOf(hook('PowerShell', { command: 'Get-Content ..\\secrets\\a.txt' })), 'deny');
  });

  it('checks file tools', () => {
    assert.equal(decisionOf(hook('Read', { file_path: `${fx.secrets}\\a.txt` })), 'deny');
    assert.equal(hook('Read', { file_path: fx.p('proj', 'src', 'app.py') }), null);
  });

  it('writes an audit log entry for each block', () => {
    const log = path.join(fx.claude, 'directory-block', 'audit.jsonl');
    hook('Bash', { command: `type ${fx.secrets}\\a.txt` });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.tool, 'Bash');
    assert.equal(entry.decision, 'deny');
    assert.equal(entry.violations[0].type, 'reference');
  });

  it('fails closed on malformed input', () => {
    const out = run(GUARD, '{not json');
    assert.equal(decisionOf(out), 'deny');
  });

  it('asks instead of denying when onViolation is "ask"', () => {
    const dir = fx.p('claude-ask');
    write(path.join(dir, 'directory-block.json'), JSON.stringify({ restricted: [fx.secrets], options: { onViolation: 'ask' } }));
    const out = hook('Bash', { command: `cat ${fx.secrets}\\a.txt` }, { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(decisionOf(out), 'ask');
  });

  it('still hard-denies self-protection hits in "ask" mode', () => {
    const dir = fx.p('claude-ask2');
    write(path.join(dir, 'directory-block.json'), JSON.stringify({ restricted: [fx.secrets], options: { onViolation: 'ask' } }));
    const out = hook('Write', { file_path: path.join(dir, 'directory-block.json'), content: '{}' }, { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(decisionOf(out), 'deny');
  });

  it('denies everything but reading the config when the config is broken', () => {
    const dir = fx.p('claude-broken');
    write(path.join(dir, 'directory-block.json'), '{ "restricted": [ ');
    const opts = { env: { CLAUDE_CONFIG_DIR: dir } };
    const out = hook('Bash', { command: 'git status' }, opts);
    assert.equal(decisionOf(out), 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /invalid JSON/);
    assert.equal(hook('Read', { file_path: path.join(dir, 'directory-block.json') }, opts), null);
    assert.equal(decisionOf(hook('Read', { file_path: fx.p('proj', 'src', 'app.py') }, opts)), 'deny');
  });

  it('denies a filename-pattern hit and names the pattern', () => {
    const dir = fx.p('claude-pattern');
    write(path.join(dir, 'directory-block.json'), JSON.stringify({ restrictedPatterns: ['.env', '!.env.example'] }));
    write(fx.p('proj', '.env'), 'API_KEY=1');
    write(fx.p('proj', '.env.example'), 'API_KEY=');
    const opts = { env: { CLAUDE_CONFIG_DIR: dir } };
    const out = hook('Bash', { command: 'cat .env' }, opts);
    assert.equal(decisionOf(out), 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /파일 패턴 \.env/);
    assert.equal(hook('Bash', { command: 'cat .env.example' }, opts), null);
    const start = run(SESSION_START, { hook_event_name: 'SessionStart', cwd: fx.proj }, { CLAUDE_CONFIG_DIR: dir });
    assert.match(start.systemMessage, /파일 패턴 1개/);
    assert.match(start.hookSpecificOutput.additionalContext, /Exceptions \(allowed\): \.env\.example/);
  });

  it('switches messages to English with language "en"', () => {
    const dir = fx.p('claude-en');
    write(path.join(dir, 'directory-block.json'), JSON.stringify({ restricted: [fx.secrets], options: { language: 'en' } }));
    const out = hook('Bash', { command: `cat ${fx.secrets}\\a.txt` }, { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Blocked access to a restricted path/);
  });
});

describe('session-start.js', () => {
  it('reports the number of restricted paths and briefs Claude', () => {
    const out = run(SESSION_START, { hook_event_name: 'SessionStart', cwd: fx.proj });
    assert.match(out.systemMessage, /4/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput.additionalContext.includes(fx.secrets));
  });

  it('warns when the working directory is inside a restricted path', () => {
    const out = run(SESSION_START, { hook_event_name: 'SessionStart', cwd: fx.secrets }, { CLAUDE_PROJECT_DIR: fx.secrets });
    assert.ok(out.systemMessage.includes(fx.secrets));
  });

  it('nudges the user when nothing is configured', () => {
    const out = run(SESSION_START, { hook_event_name: 'SessionStart', cwd: fx.root }, {
      CLAUDE_CONFIG_DIR: fx.p('claude-empty'),
      CLAUDE_PROJECT_DIR: fx.root,
    });
    assert.match(out.systemMessage, /directory-block/);
    assert.equal(out.hookSpecificOutput, undefined);
  });
});
