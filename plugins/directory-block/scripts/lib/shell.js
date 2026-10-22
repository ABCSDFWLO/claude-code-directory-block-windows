'use strict';

// A forgiving command-line splitter. It accepts bash, PowerShell and cmd syntax at once and only needs to be good
// enough to find path-like words, statement and pipeline boundaries, and which words are in command position.

const OPERATOR_CHARS = new Set([';', '|', '&', '<', '>', '(', ')', '{', '}']);

// Words after which the next word is again a command.
const PREFIX_COMMANDS = new Set([
  'sudo', 'time', 'nohup', 'env', 'xargs', 'exec', 'command', 'builtin', 'nice', 'call', 'start',
  'start-process', 'saps', 'invoke-command', 'icm', 'foreach-object', '%', 'where-object', '?', 'wsl',
]);

function commandName(word) {
  let base = String(word).split(/[\\/]/).pop().toLowerCase();
  base = base.replace(/\.(?:exe|cmd|bat|com)$/, '');
  if (/^python[\d.]*w?$/.test(base)) return 'python';
  if (/^pwsh(?:-preview)?$/.test(base)) return 'pwsh';
  return base;
}

function tokenize(text) {
  const tokens = [];
  let buf = '';
  let has = false;
  let quote = null;
  const flush = () => {
    if (has) tokens.push({ word: buf });
    buf = '';
    has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else buf += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' && i + 1 < text.length) buf += text[++i];
      else buf += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    // PowerShell's escape character (and cmd's `^`) only shields the next character.
    if (c === '`' || c === '^') {
      if (i + 1 < text.length && !/\s/.test(text[i + 1])) {
        buf += text[++i];
        has = true;
      }
      continue;
    }
    if (c === '\n' || c === '\r') {
      flush();
      tokens.push({ op: ';' });
      continue;
    }
    if (/\s/.test(c) || c === ',') {
      flush();
      continue;
    }
    if (OPERATOR_CHARS.has(c)) {
      flush();
      let op = c;
      const next = text[i + 1];
      if ((c === '&' || c === '|' || c === '>') && next === c) op += next;
      else if ((c === '>' && next === '&') || (c === '&' && next === '>')) op += next;
      if (op.length === 2) i++;
      tokens.push({ op });
      continue;
    }
    buf += c;
    has = true;
  }
  flush();
  return tokens;
}

// Groups words into statements (split on `;`, `&&`, `||`, newlines and background `&`). Pipeline stages stay in
// one statement because later stages act on what earlier ones produce.
function parseStatements(text) {
  const statements = [];
  let words = [];
  let stage = 0;
  let expectCmd = true;
  let redirect = false;
  let stageCommand = null;
  const end = () => {
    if (words.length) statements.push({ words });
    words = [];
    stage = 0;
    expectCmd = true;
    redirect = false;
    stageCommand = null;
  };
  for (const tok of tokenize(text)) {
    if (tok.op !== undefined) {
      switch (tok.op) {
        case ';':
        case '&&':
        case '||':
          end();
          break;
        case '&':
          // At a command position this is PowerShell's call operator; elsewhere it backgrounds a bash command.
          if (!expectCmd) end();
          break;
        case '|':
          stage++;
          expectCmd = true;
          redirect = false;
          stageCommand = null;
          break;
        case '(':
        case '{':
          expectCmd = true;
          break;
        case '<':
        case '>':
        case '>>':
        case '>&':
        case '&>':
          redirect = true;
          break;
        default:
          break;
      }
      continue;
    }
    const value = tok.word;
    const word = { value, stage, cmdPos: expectCmd && !redirect, redirect };
    if (word.cmdPos) {
      word.name = commandName(value);
      stageCommand = word.name;
      expectCmd = PREFIX_COMMANDS.has(word.name) || /^[A-Za-z_]\w*=/.test(value);
    } else {
      // `cmd /c dir /s`: the word after /c, /k or /r is a command again.
      expectCmd = value === '=' || (stageCommand === 'cmd' && /^\/[ckr]$/i.test(value));
    }
    redirect = false;
    words.push(word);
  }
  end();
  return statements;
}

module.exports = { commandName, parseStatements, tokenize };
