'use strict';

// Static checks on the plugin manifest, hooks file and marketplace entry.

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PLUGIN } = require('./helpers');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('plugin layout', () => {
  it('has a valid manifest', () => {
    const manifest = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
    assert.equal(manifest.name, 'directory-block');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(!/^(claude|anthropic)/.test(manifest.name), 'reserved prefix');
  });

  it('hooks point at scripts that exist and fail closed', () => {
    const { hooks } = readJson(path.join(PLUGIN, 'hooks', 'hooks.json'));
    const handlers = Object.values(hooks).flat().flatMap((group) => group.hooks);
    for (const h of handlers) {
      assert.equal(h.command, 'node');
      const script = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN);
      assert.ok(fs.existsSync(script), script);
    }
    const pre = hooks.PreToolUse[0];
    assert.equal(pre.hooks[0].onFailure, 'block');
    for (const tool of ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) {
      assert.ok(pre.matcher.split('|').includes(tool), tool);
    }
  });

  it('is listed in the local marketplace', () => {
    const market = readJson(path.join(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json'));
    const entry = market.plugins.find((p) => p.name === 'directory-block');
    assert.ok(entry);
    assert.ok(fs.existsSync(path.resolve(PLUGIN, '..', '..', entry.source)));
  });

  it('ships a valid example config', () => {
    const example = readJson(path.join(PLUGIN, 'config', 'directory-block.example.json'));
    assert.ok(Array.isArray(example.restricted));
  });
});
