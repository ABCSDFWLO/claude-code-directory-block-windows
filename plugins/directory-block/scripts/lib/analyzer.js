'use strict';

// Decides whether a tool call touches a restricted or self-protected path. Shell commands are examined in layers:
// a substring scan for absolute paths in any spelling, word-level resolution of relative paths against the working
// directory (and any `cd` targets), recursive operations on parent directories, scripts and build manifests the
// command executes, and base64-encoded payloads.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const { parseStatements } = require('./shell');

const win = path.win32;

// Commands that walk a directory tree, or unpack/sync into one, when given a directory.
const RECURSIVE_COMMANDS = new Set([
  'find', 'rg', 'fd', 'fdfind', 'tree', 'du', 'robocopy', 'xcopy', 'tar', 'zip', '7z', '7za', 'rsync',
  'ag', 'ack', 'compress-archive', 'expand-archive',
]);

// Commands that delete, move or rename their target, taking everything below it along.
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename',
  'rename-item', 'rni', 'shred', 'unlink',
]);

// Commands that search the current directory when no path argument is given.
const IMPLICIT_WALKERS = new Set([
  'find', 'rg', 'fd', 'fdfind', 'ag', 'ack', 'tree', 'du', 'grep', 'egrep', 'fgrep', 'ls', 'dir', 'gci',
  'get-childitem', 'findstr',
]);

const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

// Commands whose file arguments are executed or sourced rather than just read.
const INTERPRETERS = new Set([
  'python', 'py', 'node', 'deno', 'bun', 'ts-node', 'tsx', 'ruby', 'perl', 'php', 'bash', 'sh', 'zsh', 'dash',
  'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'cscript', 'wscript', 'rscript', 'lua', 'source', '.', 'call',
  'start', 'start-process', 'saps', 'invoke-expression', 'iex', 'invoke-command', 'icm', 'import-module',
  'ipmo', 'uv', 'poetry', 'pipenv', 'npx', 'pnpx', 'bunx', 'groovy', 'awk', 'gawk', 'sed',
]);

const MESSAGE_COMMANDS = new Set([
  'echo', 'printf', 'write-host', 'write-output', 'write-information', 'write-warning', 'write-error',
  'write-verbose', 'write-debug',
]);
const MESSAGE_FLAG = /^(?:-m|--message|-message|--title|--body|--subject|--notes?)$/i;

// File-name filters (`--exclude=.env*`, `-g '!*.pem'`, `-Filter *.ts`) describe files, they do not name them.
const FILTER_FLAG = /^(?:--exclude(?:-dir)?|--include|--i?glob|-g|-exclude|-include|-filter)$/i;
const FILTER_ASSIGN = /^(?:--exclude(?:-dir)?|--include|--i?glob)=/i;

const POWERSHELL_HOSTS = new Set(['powershell', 'pwsh']);

// Their quoted arguments (bash -c "...", cmd /c "...", powershell -Command "...") are whole commands.
const SHELL_HOSTS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl']);

// Copying or moving *into* a parent directory leaves the restricted path alone, unless the copy mirrors (deletes).
const TRANSFER_COMMANDS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'mv', 'move', 'move-item', 'mi', 'rsync', 'scp']);
const MIRROR_FLAG = /^(?:\/mir|\/purge|--delete\S*|--mirror)$/i;

const SCRIPT_EXTENSIONS = new Set([
  '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.sh', '.bash', '.zsh', '.ksh', '.fish', '.py', '.pyw', '.js', '.mjs',
  '.cjs', '.ts', '.mts', '.cts', '.rb', '.pl', '.pm', '.php', '.vbs', '.vbe', '.wsf', '.jse', '.lua', '.r',
  '.groovy', '.tcl', '.awk', '.sed',
]);

// Package managers and build tools run commands defined in these files.
const MANIFESTS = new Map([
  ['npm', ['package.json']],
  ['yarn', ['package.json']],
  ['pnpm', ['package.json']],
  ['bun', ['package.json']],
  ['make', ['Makefile', 'makefile', 'GNUmakefile']],
  ['mingw32-make', ['Makefile', 'makefile', 'GNUmakefile']],
  ['just', ['justfile', 'Justfile', '.justfile']],
]);

// Library calls that walk or delete a directory tree.
const CODE_RECURSION = /\bos\.walk\b|\.rglob\(|\brecursive\s*[=:]\s*(?:true|\$true)\b|\bshutil\.(?:rmtree|copytree|move)\b|\brimraf\b|\bwalkdir\b|\bfilepath\.walk|\bfiles\.walk\b|\bsearchoption\.alldirectories\b|\bdirectory\.delete\([^)]*\btrue\b/i;

const DECODE_PRIMITIVE = /frombase64string|\bbase64\s+(?:-d|--decode|-D)\b|\bcertutil\b[^\n]*-decode|\bb64decode\b|\batob\s*\(|['"]base64['"]/i;
const BASE64_TOKEN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const MAX_BASES = 16;

// Commands that read file contents; together with a recursive walk they read every file below a directory.
const CONTENT_READERS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'cat', 'type', 'get-content', 'gc',
  'head', 'tail', 'less', 'more', 'strings', 'xargs', 'sed', 'awk', 'tar', 'zip', '7z', '7za', 'robocopy', 'xcopy',
  'rsync', 'scp', 'cp', 'copy', 'copy-item', 'cpi', 'compress-archive',
]);
// Searchers that skip hidden files unless told otherwise.
const HIDDEN_SKIPPERS = new Set(['rg', 'ag']);
const SHOW_HIDDEN_FLAG = /^(?:--hidden|-\.|-u+|--unrestricted|--no-ignore-hidden)$/;
// Never descended into while looking for protected files below a directory.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
const SEARCH_BUDGET = 20000;
const MAX_GLOB_MATCHES = 500;

// File-name filters a command was given. Excludes: grep/tar --exclude(-dir), rg -g '!x', PowerShell -Exclude,
// zip -x, 7z -x!, robocopy /xf and /xd. Includes: grep --include, rg -g 'x', PowerShell -Include and -Filter.
function collectFilters(words, names) {
  const excludes = [];
  const includes = [];
  const glob = (g) => (g.startsWith('!') ? excludes.push(g.slice(1)) : includes.push(g));
  for (let k = 0; k < words.length; k++) {
    const v = words[k].value;
    const next = words[k + 1] ? words[k + 1].value : '';
    let m;
    if ((m = /^--exclude(?:-dir)?=(.+)$/i.exec(v))) excludes.push(m[1]);
    else if (/^(?:--exclude(?:-dir)?|-exclude)$/i.test(v)) excludes.push(next);
    else if ((m = /^--include=(.+)$/i.exec(v))) includes.push(m[1]);
    else if (/^(?:--include|-include|-filter)$/i.test(v)) includes.push(next);
    else if ((m = /^--i?glob=(.+)$/.exec(v))) glob(m[1]);
    else if (/^(?:-g|--i?glob)$/.test(v) && next) glob(next);
    else if ((m = /^-xr?!(.+)$/.exec(v))) excludes.push(m[1]);
    else if (v === '-x' && names.includes('zip')) excludes.push(next);
    else if (/^\/x[fd]$/i.test(v)) {
      for (let j = k + 1; j < words.length && !words[j].value.startsWith('/'); j++) excludes.push(words[j].value);
    }
  }
  const clean = (list) => list.filter(Boolean).map((g) => g.replace(/^.*[\\/]/, '').toLowerCase());
  return { excludes: clean(excludes), includes: clean(includes) };
}

function isRecursiveFlag(v, names, shell) {
  if (/^--?(?:recursive|recurse)$/i.test(v)) return true;
  if (/^-rec(?:u(?:r(?:s(?:e)?)?)?)?(?::\$?true)?$/i.test(v)) return true;
  if (/^-depth$/i.test(v)) return true;
  // Short option clusters such as -r, -R, -rf, -avr. In bash, `ls -r` only reverses the sort order.
  if (/^-[a-z]{1,4}$/i.test(v)) {
    if (/R/.test(v)) return true;
    if (/r/.test(v)) return !(shell === 'bash' && names.includes('ls'));
  }
  if (/^-a[a-z]{0,3}$/.test(v) && names.some((n) => n === 'cp' || n === 'rsync' || n === 'scp')) return true;
  // cmd and robocopy switches: dir /s, del /s, xcopy /e, icacls /t, takeown /r, robocopy /mir.
  return /^\/(?:s|e|t|r|mir|move|purge)$/i.test(v);
}

function isEncodedFlag(v) {
  const m = /^[-/]([a-z]+)$/i.exec(v);
  if (!m) return false;
  const flag = m[1].toLowerCase();
  return flag === 'ec' || 'encodedcommand'.startsWith(flag);
}

function looksLikePath(v, mode) {
  if (!v || v.length > 2048 || /[\r\n\0]/.test(v)) return false;
  if (v.startsWith('-')) return false;
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(v) && !/^file:/i.test(v)) return false;
  if (P.isAbsoluteLike(v)) return true;
  if (mode === 'absolute') return false;
  if (/^[\\/]+$/.test(v)) return mode === 'bare';
  if (/[\\/]/.test(v) || v.startsWith('.') || v.startsWith('~') || /^[a-z]:/i.test(v)) return true;
  return mode === 'bare';
}

// The word itself plus the value of `--opt=value`, `-Opt:value`, `/opt:value` and `NAME=value` forms.
function wordValues(v) {
  const out = [v];
  const opt = /^(?:--?|\/)[\w-]+[:=](.+)$/.exec(v);
  if (opt) out.push(opt[1]);
  else if (/^[A-Za-z_][\w.-]*=/.test(v)) out.push(v.slice(v.indexOf('=') + 1));
  return out;
}

// Path-like pieces inside a word that holds code (python -c "...", bash -c '...', heredocs, script bodies).
function embeddedPieces(text) {
  const out = new Set();
  for (const m of text.matchAll(/"([^"\r\n]{1,1024})"|'([^'\r\n]{1,1024})'/g)) out.add(m[1] !== undefined ? m[1] : m[2]);
  for (const piece of text.split(/[\s"'`(){}[\]<>;,|&=+]+/)) if (piece) out.add(piece);
  return out;
}

// `a`, `b`, `c` → a/b, a/b/c, a/b/c/d (up to three parts) when `a` is absolute. Used for Join-Path and the like.
function joinParts(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!P.isAbsoluteLike(parts[i])) continue;
    let acc = parts[i];
    for (let k = 1; k <= 3 && i + k < parts.length; k++) {
      const next = parts[i + k];
      if (!next || P.isAbsoluteLike(next) || next.startsWith('-') || /:\/\//.test(next)) break;
      acc = `${acc.replace(/[\\/]+$/, '')}/${next.replace(/^[\\/]+/, '')}`;
      out.push(acc);
    }
  }
  return out;
}

// Adjacent string literals joined by `,`, `+` or `/`: os.path.join("C:\\x", "y"), "C:/x" + "y", Path("C:/x") / "y".
function joinLiterals(text) {
  const literals = [...text.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'/g)].map((m) => ({
    value: m[1] !== undefined ? m[1] : m[2],
    start: m.index,
    end: m.index + m[0].length,
  }));
  const out = [];
  let group = [];
  const flush = () => {
    if (group.length > 1) {
      const parts = group.map((g) => g.value);
      out.push(parts.join(''), ...joinParts(parts));
    }
    group = [];
  };
  for (const lit of literals) {
    if (group.length && !/^\s*\)?\s*[,+/]\s*\(?\s*$/.test(text.slice(group[group.length - 1].end, lit.start))) flush();
    group.push(lit);
  }
  flush();
  return out;
}

// Extra spellings of the text for the substring scan: quoting removed, string concatenation folded, and one level
// of brace expansion.
function textVariants(text) {
  const variants = new Set([text]);
  variants.add(text.replace(/["'`^]/g, ''));
  let folded = text;
  for (let i = 0; i < 10; i++) {
    const next = folded.replace(/(['"])([^'"\r\n]*)\1\s*\+\s*(['"])([^'"\r\n]*)\3/g, (m, q, a, q2, b) => `"${a}${b}"`);
    if (next === folded) break;
    folded = next;
  }
  variants.add(folded);
  variants.add(text.replace(/([^\s{}'"]*)\{([^{}\s]*,[^{}\s]*)\}([^\s{}'"]*)/g, (m, pre, body, post) => (
    body.split(',').map((alt) => `${pre}${alt}${post}`).join(' ')
  )));
  return variants;
}

function isMostlyPrintable(text) {
  if (!text) return false;
  let bad = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) bad++;
  }
  return bad / text.length < 0.05;
}

function decodePowerShell(payload) {
  const clean = payload.replace(/^['"]|['"]$/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const text = Buffer.from(clean, 'base64').toString('utf16le');
  return isMostlyPrintable(text) ? text : null;
}

function decodeBase64Text(token) {
  const buf = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return [buf.toString('utf8'), buf.toString('utf16le')].filter(isMostlyPrintable);
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) {
    // UTF-16LE without a BOM has a zero in every other byte for ASCII text; anything else with NULs is binary.
    let zeros = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
    return zeros > sample.length / 4 ? buf.toString('utf16le') : null;
  }
  return buf.toString('utf8');
}

function readText(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(maxBytes, fs.fstatSync(fd).size);
    // Look at the head first so executables are rejected without reading them whole.
    const head = Buffer.alloc(Math.min(size, 8192));
    const headLen = fs.readSync(fd, head, 0, head.length, 0);
    if (decodeText(head.subarray(0, headLen)) === null) return null;
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return decodeText(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function uniquePaths(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, MAX_BASES);
}

// Word indexes that are only the destination of a copy or move.
function destinationWords(words) {
  const out = new Set();
  if (words.some((w) => MIRROR_FLAG.test(w.value))) return out;
  const stages = new Set(words.filter((w) => w.cmdPos && TRANSFER_COMMANDS.has(w.name)).map((w) => w.stage));
  for (const stage of stages) {
    const positional = [];
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (w.stage !== stage || w.cmdPos || w.redirect) continue;
      if (/^-dest/i.test(w.value) && k + 1 < words.length) out.add(k + 1);
      if (!w.value.startsWith('-')) positional.push(k);
    }
    if (positional.length >= 2) out.add(positional[positional.length - 1]);
  }
  return out;
}

class Analyzer {
  constructor(config, cwd, shell) {
    this.rules = config.rules;
    this.patternRules = config.rules.filter((r) => r.patternSegs);
    this.options = config.options;
    this.cwd = cwd;
    this.shell = shell;
    this.violations = [];
    this.seen = new Set();
    this.scannedFiles = new Set();
    this.formCache = new Map();
  }

  add(rule, type, evidence, resolved, origin) {
    const segs = resolved && P.segmentsOf(resolved);
    const key = `${rule ? rule.id : '-'}|${type}|${segs ? segs.join('/') : String(evidence).toLowerCase()}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.violations.push({ rule, type, evidence: String(evidence), resolved, origin });
  }

  // The violation type for a direct hit on a rule.
  static hitType(rule) {
    if (rule.kind === 'protected') return 'protected';
    return rule.patternSegs ? 'pattern' : 'reference';
  }

  patternCovers(segs, rule) {
    return P.patternHits(rule.patternSegs, segs)
      && !rule.negations.some((n) => P.patternHits(n, segs))
      && !this.isAllowedSegs(segs, rule);
  }

  // Lexical segments plus, when different, the real location behind junctions, symlinks and 8.3 names.
  pathForms(absPath) {
    const key = absPath.toLowerCase();
    let forms = this.formCache.get(key);
    if (forms) return forms;
    forms = [];
    const lexical = P.segmentsOf(absPath);
    if (lexical) {
      forms.push(lexical);
      const real = P.realpathLoose(absPath);
      const realSegs = real && P.segmentsOf(real);
      if (realSegs && realSegs.join('/') !== lexical.join('/')) forms.push(realSegs);
    }
    this.formCache.set(key, forms);
    return forms;
  }

  isAllowedSegs(segs, rule) {
    const lit = P.literalPrefix(segs);
    return rule.allow.some((a) => lit.length >= a.length && P.relate(lit, a) === 'inside');
  }

  // 'inside' when the path (in any of its forms) is the rule's path or below it and no allow entry covers it,
  // 'ancestor' when it is a directory above the rule's path, otherwise null.
  classify(absPath, rule) {
    if (rule.patternSegs) {
      return this.pathForms(absPath).some((segs) => this.patternCovers(segs, rule)) ? 'inside' : null;
    }
    let ancestor = false;
    for (const segs of this.pathForms(absPath)) {
      for (const r of rule.segForms) {
        const rel = P.relate(segs, r);
        if (rel === 'inside' && !this.isAllowedSegs(segs, rule)) return 'inside';
        if (rel === 'ancestor') ancestor = true;
      }
    }
    return ancestor ? 'ancestor' : null;
  }

  exists(absPath) {
    return P.probePath(absPath).exists;
  }

  // Resolves one candidate against every base directory and records direct hits. Ancestor hits go to `ancestors`
  // and existing argument paths to `found` when the caller tracks them. Filename patterns only count for paths that
  // exist or are written to, so code such as `process.env` is not mistaken for a file.
  evaluate(c, bases, origin, ancestors, found) {
    for (const base of bases) {
      const abs = P.resolveCandidate(c.value, base);
      if (!abs) continue;
      const exists = this.exists(abs);
      if (exists && c.arg && found) found.push({ abs, word: c.word });
      for (const rule of this.rules) {
        if (rule.patternSegs && !exists && !c.redirect) continue;
        const rel = this.classify(abs, rule);
        if (rel === 'inside') this.add(rule, Analyzer.hitType(rule), c.value, abs, origin);
        else if (rel === 'ancestor' && ancestors) ancestors.push({ rule, evidence: c.value, resolved: abs, word: c.word });
      }
      if (this.patternRules.length && /[*?[{]/.test(abs)) {
        for (const hit of this.expandGlob(abs)) {
          for (const rule of this.patternRules) {
            if (this.classify(hit, rule) === 'inside') this.add(rule, 'pattern', c.value, hit, origin);
          }
        }
      }
      if (P.isAbsoluteLike(c.value)) break;
    }
  }

  // Existing paths a wildcard path names. In bash a leading `*` or `?` does not match dotfiles.
  expandGlob(absPath) {
    const root = win.parse(absPath).root;
    if (!root) return [];
    const segs = absPath.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let frontier = [root];
    for (const seg of segs) {
      const next = [];
      const glob = seg.toLowerCase();
      for (const dir of frontier) {
        if (!P.isGlobSegment(seg)) {
          next.push(win.join(dir, seg));
          continue;
        }
        const entries = P.listDir(dir);
        if (!entries) continue;
        for (const [lower, d] of entries) {
          if (this.shell === 'bash' && lower.startsWith('.') && !glob.startsWith('.')) continue;
          if (P.segmentMatches(glob === '**' ? '*' : glob, lower)) next.push(win.join(dir, d.name));
          if (next.length >= MAX_GLOB_MATCHES) break;
        }
      }
      frontier = next;
      if (!frontier.length) return [];
    }
    return frontier.filter((p) => this.exists(p));
  }

  // Breadth-first search below `dirs` for files that a filename pattern protects. Bounded, does not follow links,
  // and skips node_modules and VCS folders.
  findProtectedFiles(dirs, { skipHidden = false, excludes = [], includes = [] } = {}) {
    const hits = [];
    const queue = dirs.map((dir) => ({ dir, root: dir }));
    const seen = new Set();
    let budget = SEARCH_BUDGET;
    for (let qi = 0; qi < queue.length && hits.length < 3 && budget > 0; qi++) {
      const { dir, root } = queue[qi];
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entries = P.listDir(dir);
      if (!entries) continue;
      for (const [lower, d] of entries) {
        if (--budget <= 0 || hits.length >= 3) break;
        const isDir = d.isDirectory();
        if ((isDir && SKIP_DIRS.has(lower)) || (skipHidden && lower.startsWith('.'))) continue;
        if (excludes.some((g) => P.segmentMatches(g, lower))) continue;
        const full = win.join(dir, d.name);
        const segs = P.segmentsOf(full);
        const rule = this.patternRules.find((r) => this.patternCovers(segs, r));
        if (rule && (isDir || !includes.length || includes.some((g) => P.segmentMatches(g, lower)))) {
          hits.push({ rule, path: full, dir: root });
        } else if (isDir) {
          queue.push({ dir: full, root });
        }
      }
    }
    return hits;
  }

  analyzeShell(command) {
    for (const rule of this.rules) {
      if (rule.kind === 'restricted' && this.classify(this.cwd, rule) === 'inside') {
        this.add(rule, 'cwd-inside', this.cwd, this.cwd, 'command');
      }
    }
    this.scanText(command, { cwd: this.cwd, scriptDir: null, origin: 'command', depth: 0, wholeFile: false });
  }

  // `wholeFile` treats a script as one unit for recursion checks, since paths flow through variables across lines.
  scanText(text, src) {
    if (src.depth > this.options.maxScriptDepth) return;
    const expanded = P.expandVars(text, { cwd: src.cwd, scriptDir: src.scriptDir });
    const statements = parseStatements(expanded);
    const state = { bases: uniquePaths([src.cwd, src.scriptDir]), walk: false, ancestors: [] };
    for (const st of statements) this.scanStatement(st, src, state);
    // After the word-level pass, so its original-case evidence wins the de-duplication.
    this.textScan(expanded, src);
    for (const joined of joinLiterals(expanded)) {
      if (looksLikePath(joined, 'path')) this.evaluate({ value: joined }, state.bases, src.origin, src.wholeFile ? state.ancestors : null, null);
    }
    if (src.wholeFile) {
      const walk = state.walk || CODE_RECURSION.test(expanded);
      this.checkAncestors({ walk, destructive: false, ancestors: state.ancestors.filter((a) => a.rule.kind === 'restricted') }, src);
    }
    this.scanEncoded(expanded, statements, src);
  }

  // Absolute paths in any spelling, wherever they appear (arguments, strings, comments).
  textScan(text, src) {
    for (const variant of textVariants(text)) {
      const canon = P.canonText(variant);
      for (const rule of this.rules) {
        for (const form of rule.textForms) {
          for (const hit of P.findTextMatches(canon, form)) {
            const resolved = P.resolveCandidate(hit, src.cwd);
            const segs = resolved && P.segmentsOf(resolved);
            if (segs && this.isAllowedSegs(segs, rule)) continue;
            this.add(rule, rule.kind === 'protected' ? 'protected' : 'reference', hit, resolved || hit, src.origin);
          }
        }
      }
    }
  }

  statementCandidates(words, names) {
    const out = [];
    const seen = new Set();
    const push = (value, mode, arg, word) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      const redirect = word >= 0 && words[word].redirect;
      if (looksLikePath(value, mode)) out.push({ value, arg, word, redirect });
    };
    let stage = -1;
    let stageCommand = null;
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (w.stage !== stage) {
        stage = w.stage;
        stageCommand = null;
      }
      if (w.cmdPos) {
        stageCommand = w.name;
        if (/[\\/]/.test(w.value)) push(w.value, 'path', false, k);
        continue;
      }
      const prev = k > 0 ? words[k - 1].value : '';
      if (FILTER_ASSIGN.test(w.value) || FILTER_FLAG.test(prev) || (prev === '-x' && names.includes('zip'))) continue;
      // Free text (echo, commit messages) is only checked for absolute paths, never resolved as relative ones.
      const message = !w.redirect && (MESSAGE_COMMANDS.has(stageCommand) || (k > 0 && MESSAGE_FLAG.test(words[k - 1].value)));
      for (const v of wordValues(w.value)) push(v, message ? 'absolute' : 'bare', true, k);
      for (const piece of embeddedPieces(w.value)) push(piece, message ? 'absolute' : 'path', false, k);
      for (const joined of joinLiterals(w.value)) push(joined, message ? 'absolute' : 'path', false, k);
      // PowerShell/JS string building: $base + '\.ssh'
      if (w.value === '+' && k > 0 && k + 1 < words.length) push(words[k - 1].value + words[k + 1].value, 'path', false, k);
    }
    if (names.includes('join-path')) {
      const parts = words.filter((w) => !w.cmdPos && !w.value.startsWith('-')).map((w) => w.value);
      for (const joined of joinParts(parts)) push(joined, 'path', false, -1);
    }
    return out;
  }

  scanStatement(st, src, state) {
    const { words } = st;
    const names = words.filter((w) => w.cmdPos).map((w) => w.name);
    const text = words.map((w) => w.value).join(' ');
    const destructive = names.some((n) => DESTRUCTIVE_COMMANDS.has(n));
    const walk = names.some((n) => RECURSIVE_COMMANDS.has(n))
      || words.some((w) => !w.cmdPos && isRecursiveFlag(w.value, names, this.shell))
      || CODE_RECURSION.test(text);

    const ancestors = [];
    const found = [];
    for (const c of this.statementCandidates(words, names)) this.evaluate(c, state.bases, src.origin, ancestors, found);
    const explicitPath = found.length > 0;
    const destinations = destinationWords(words);

    if (words.some((w) => w.cmdPos && SHELL_HOSTS.has(w.name))) {
      for (const w of words) {
        if (!w.cmdPos && /\s/.test(w.value)) this.scanText(w.value, { ...src, depth: src.depth + 1, wholeFile: false });
      }
    }

    if (src.wholeFile) {
      state.walk = state.walk || walk;
      state.ancestors.push(...ancestors);
    } else {
      const sources = ancestors.filter((a) => !destinations.has(a.word));
      this.checkAncestors({ walk, destructive, ancestors: sources }, src);
      if (walk && !explicitPath && this.options.checkRecursiveAncestors && names.some((n) => IMPLICIT_WALKERS.has(n))) {
        for (const base of state.bases) {
          for (const rule of this.rules) {
            if (rule.kind === 'restricted' && this.classify(base, rule) === 'ancestor') {
              this.add(rule, 'implicit-cwd', text, base, src.origin);
            }
          }
        }
      }
    }

    // A recursive read (grep -r, rg, tar, cp -r, gci -Recurse | Select-String ...) reads every file below its
    // directories, so it is blocked when a pattern-protected file is actually there and not excluded.
    if (walk && this.patternRules.length && this.options.checkPatternsInRecursiveReads
      && names.some((n) => CONTENT_READERS.has(n))) {
      let dirs = found.filter((f) => !destinations.has(f.word) && P.listDir(f.abs)).map((f) => f.abs);
      if (!found.length && names.some((n) => IMPLICIT_WALKERS.has(n))) dirs = state.bases;
      const skipHidden = names.some((n) => HIDDEN_SKIPPERS.has(n)) && !words.some((w) => SHOW_HIDDEN_FLAG.test(w.value));
      const filters = collectFilters(words, names);
      for (const hit of this.findProtectedFiles(dirs, { skipHidden, ...filters })) {
        this.add(hit.rule, 'pattern-recursive', hit.dir, hit.path, src.origin);
      }
    }

    this.trackDirectoryChanges(words, state);
    if (this.options.scanScripts) {
      this.scanExecutedFiles(words, state, src);
      this.scanManifests(names, state, src);
    }
  }

  // Deleting, moving or recursively walking a parent directory reaches the restricted path below it.
  checkAncestors({ walk, destructive, ancestors }, src) {
    for (const a of ancestors) {
      if (a.rule.kind === 'protected') {
        if (destructive) this.add(a.rule, 'protected', a.evidence, a.resolved, src.origin);
      } else if (destructive || (walk && this.options.checkRecursiveAncestors)) {
        this.add(a.rule, 'recursive-ancestor', a.evidence, a.resolved, src.origin);
      }
    }
  }

  trackDirectoryChanges(words, state) {
    for (let k = 0; k < words.length; k++) {
      if (!words[k].cmdPos || !CD_COMMANDS.has(words[k].name)) continue;
      let target = null;
      for (let m = k + 1; m < words.length && !words[m].cmdPos; m++) {
        const v = words[m].value;
        if ((v.startsWith('-') && v !== '-') || /^\/d$/i.test(v)) continue;
        target = v;
        break;
      }
      if (target === '-') continue;
      if (target === null) target = P.homeDir();
      const next = state.bases.map((base) => P.resolveCandidate(target, base)).filter(Boolean);
      state.bases = uniquePaths([...state.bases, ...next]);
    }
  }

  scanExecutedFiles(words, state, src) {
    const interpreterStages = new Set(words.filter((w) => w.cmdPos && INTERPRETERS.has(w.name)).map((w) => w.stage));
    let firstArg = false;
    for (const w of words) {
      const ext = win.extname(w.value).toLowerCase();
      if (w.cmdPos) {
        firstArg = INTERPRETERS.has(w.name);
        if (/[\\/]/.test(w.value) || SCRIPT_EXTENSIONS.has(ext)) this.scanFileCandidate(w.value, state.bases, src);
        continue;
      }
      if (!interpreterStages.has(w.stage) || w.value.startsWith('-')) continue;
      // Any script-like argument of an interpreter, or its first argument whatever the extension.
      if (SCRIPT_EXTENSIONS.has(ext) || firstArg) this.scanFileCandidate(w.value, state.bases, src);
      firstArg = false;
    }
  }

  scanFileCandidate(value, bases, src) {
    for (const base of bases) {
      const abs = P.resolveCandidate(value, base);
      if (abs && !/[*?]/.test(abs) && this.scanFile(abs, src, `script:${abs}`, true)) return;
    }
  }

  scanManifests(names, state, src) {
    for (const name of names) {
      const files = MANIFESTS.get(name);
      if (!files) continue;
      for (const base of state.bases) {
        for (const file of files) {
          const abs = win.join(base, file);
          this.scanFile(abs, src, `manifest:${abs}`, false);
        }
      }
    }
  }

  scanFile(abs, src, origin, wholeFile) {
    const key = abs.toLowerCase();
    if (this.scannedFiles.has(key)) return true;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    this.scannedFiles.add(key);
    // Never read restricted or protected files: the reference is already reported, and their contents must not
    // end up in a block message.
    if (this.rules.some((rule) => this.classify(abs, rule) === 'inside')) return true;
    const content = readText(abs, this.options.maxScriptBytes);
    if (content === null) return true;
    this.scanText(content, { cwd: src.cwd, scriptDir: win.dirname(abs), origin, depth: src.depth + 1, wholeFile });
    return true;
  }

  scanEncoded(expanded, statements, src) {
    const mode = this.options.encodedCommands;
    if (mode === 'allow') return;
    for (const { words } of statements) {
      if (!words.some((w) => w.cmdPos && POWERSHELL_HOSTS.has(w.name))) continue;
      for (let k = 0; k < words.length; k++) {
        if (words[k].cmdPos || !isEncodedFlag(words[k].value)) continue;
        const payload = words[k + 1] ? words[k + 1].value : '';
        const decoded = mode === 'decode' && payload ? decodePowerShell(payload) : null;
        if (decoded === null) {
          const shown = payload.length > 40 ? `${payload.slice(0, 40)}...` : payload;
          this.add(null, 'encoded-command', `${words[k].value} ${shown}`.trim(), null, src.origin);
        } else {
          this.scanText(decoded, { ...src, origin: 'encoded', depth: src.depth + 1, wholeFile: false });
        }
      }
    }
    if (mode === 'decode' && DECODE_PRIMITIVE.test(expanded)) {
      for (const piece of embeddedPieces(expanded)) {
        if (!BASE64_TOKEN.test(piece)) continue;
        for (const text of decodeBase64Text(piece)) {
          this.scanText(text, { ...src, origin: 'encoded', depth: src.depth + 1, wholeFile: false });
        }
      }
    }
  }

  // Where a glob reaches into a restricted path: 'literal' when its fixed prefix is already inside, 'wild' when
  // wildcards descend into it.
  globReach(absPattern, rule) {
    const lexical = P.segmentsOf(absPattern);
    if (!lexical) return null;
    const literal = P.segmentsToPath(P.literalPrefix(lexical));
    if (literal && this.classify(literal, rule) === 'inside') return 'literal';
    if (!this.options.checkRecursiveAncestors) return null;
    for (const r of rule.segForms) {
      if (P.relate(lexical, r) === 'inside' && (lexical.includes('**') || lexical.length > r.length)) return 'wild';
    }
    return null;
  }

  analyzeFileTool(toolName, input) {
    const write = WRITE_TOOLS.has(toolName);
    const origin = 'tool';
    const applies = (rule) => (rule.kind === 'protected' ? write : this.options.protectFileTools);
    const filePath = input.file_path || input.notebook_path;
    if (typeof filePath === 'string' && filePath) {
      const abs = P.resolveCandidate(filePath, this.cwd);
      for (const rule of this.rules) {
        if (abs && applies(rule) && this.classify(abs, rule) === 'inside') {
          this.add(rule, Analyzer.hitType(rule), filePath, abs, origin);
        }
      }
    }
    if ((toolName === 'Glob' || toolName === 'Grep') && this.options.protectFileTools) {
      const shown = input.path || this.cwd;
      const base = P.resolveCandidate(shown, this.cwd);
      if (!base) return;
      const pattern = toolName === 'Glob' && typeof input.pattern === 'string' ? P.resolveCandidate(input.pattern, base) : null;
      for (const rule of this.rules) {
        // Glob only returns names, so filename patterns do not apply to it.
        if (rule.kind !== 'restricted' || (rule.patternSegs && toolName === 'Glob')) continue;
        const rel = this.classify(base, rule);
        if (rel === 'inside') {
          this.add(rule, Analyzer.hitType(rule), shown, base, origin);
        } else if (toolName === 'Grep' && rel === 'ancestor' && this.options.checkRecursiveAncestors) {
          this.add(rule, 'recursive-ancestor', shown, base, origin);
        } else if (pattern) {
          const reach = this.globReach(pattern, rule);
          if (reach) this.add(rule, reach === 'literal' ? 'reference' : 'recursive-ancestor', input.pattern, pattern, origin);
        }
      }
      // Grep reads hidden files too, so a pattern-protected file below the searched folder is read unless the
      // glob filter leaves it out.
      if (toolName === 'Grep' && this.patternRules.length && this.options.checkPatternsInRecursiveReads
        && !input.type && P.listDir(base)) {
        const glob = typeof input.glob === 'string' ? input.glob.trim() : '';
        const name = glob.replace(/^!/, '').split(/[\\/]/).pop().toLowerCase();
        const filters = glob.startsWith('!') ? { excludes: [name] } : { includes: name ? [name] : [] };
        for (const hit of this.findProtectedFiles([base], filters)) {
          this.add(hit.rule, 'pattern-recursive', shown, hit.path, origin);
        }
      }
    }
  }
}

function analyzeToolCall({ toolName, toolInput, cwd, config }) {
  const analyzer = new Analyzer(config, cwd, toolName === 'PowerShell' ? 'powershell' : 'bash');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (typeof input.command === 'string') analyzer.analyzeShell(input.command);
  else analyzer.analyzeFileTool(toolName, input);
  return { violations: analyzer.violations };
}

module.exports = { analyzeToolCall, WRITE_TOOLS };
