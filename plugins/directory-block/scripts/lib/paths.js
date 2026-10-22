'use strict';

// Windows path handling: variable expansion, the many spellings of one path (Git Bash, UNC, long-path prefixes,
// admin shares, file URLs), canonical segments for comparison, and glob-aware containment checks.

const fs = require('fs');
const os = require('os');
const path = require('path');

const win = path.win32;

// Variables that hold path *lists*; expanding them would turn every PATH entry into a candidate path.
const LIST_VARS = new Set(['path', 'pathext', 'psmodulepath']);

// A bare `$name` is usually a shell or script variable, so only well-known path variables are expanded in that form.
const BARE_VARS = new Set([
  'home', 'userprofile', 'appdata', 'localappdata', 'temp', 'tmp', 'tmpdir', 'programfiles',
  'programdata', 'systemroot', 'windir', 'public', 'onedrive', 'homedrive', 'homepath',
  'allusersprofile', 'commonprogramfiles', 'systemdrive',
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LOCAL_HOSTS = `(?:localhost|127\\.0\\.0\\.1|\\[?::1\\]?|${escapeRe(os.hostname())})`;
const ADMIN_SHARE_START = new RegExp(`^//${LOCAL_HOSTS}/([a-z])\\$(?=/|$)`, 'i');
const ADMIN_SHARE_TEXT = new RegExp(`//+${LOCAL_HOSTS}/+([a-z])\\$(?=/|$|[^\\w$])`, 'gi');
const GITBASH_TEXT = /(^|[\s'"`=(,;|&<>{[])\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/)/g;

function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

function envLookup(name) {
  const key = String(name).toLowerCase();
  if (LIST_VARS.has(key)) return undefined;
  if (key === 'home' && !process.env.HOME) return homeDir();
  if (process.env[name] !== undefined) return process.env[name];
  const hit = Object.keys(process.env).find((k) => k.toLowerCase() === key);
  return hit === undefined ? undefined : process.env[hit];
}

const SPECIAL_FOLDERS = {
  userprofile: () => homeDir(),
  desktop: () => win.join(homeDir(), 'Desktop'),
  desktopdirectory: () => win.join(homeDir(), 'Desktop'),
  mydocuments: () => win.join(homeDir(), 'Documents'),
  personal: () => win.join(homeDir(), 'Documents'),
  mypictures: () => win.join(homeDir(), 'Pictures'),
  mymusic: () => win.join(homeDir(), 'Music'),
  myvideos: () => win.join(homeDir(), 'Videos'),
  applicationdata: () => envLookup('APPDATA'),
  localapplicationdata: () => envLookup('LOCALAPPDATA'),
  commonapplicationdata: () => envLookup('ProgramData'),
  programfiles: () => envLookup('ProgramFiles'),
  programfilesx86: () => envLookup('ProgramFiles(x86)'),
  windows: () => envLookup('windir'),
  system: () => {
    const windir = envLookup('windir');
    return windir && win.join(windir, 'System32');
  },
};

// Expands cmd, PowerShell, bash and common scripting-language spellings of environment variables, `~`, and the
// current/script directory. Unknown variables are left untouched.
function expandVars(text, ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const scriptDir = ctx.scriptDir || cwd;
  const or = (fallback, value) => (value === undefined || value === null || value === '' ? fallback : value);
  let s = String(text);

  s = s.replace(/%~dp0/gi, () => `${scriptDir}\\`);
  s = s.replace(/%([A-Za-z_][\w()]*)%/g, (m, n) => or(m, n.toLowerCase() === 'cd' ? cwd : envLookup(n)));
  s = s.replace(/\$\{env:([^}]+)\}/gi, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\$env:([A-Za-z_]\w*)/gi, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\bos\.environ(?:\.get)?\s*[[(]\s*['"]([^'"]+)['"][^\])]*[\])]/g, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\b(?:os\.)?getenv\s*\(\s*['"]([^'"]+)['"][^)]*\)/gi, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\bprocess\.env\.([A-Za-z_]\w*)/g, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\bprocess\.env\[\s*['"]([^'"]+)['"]\s*\]/g, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\bENV\[\s*['"]([^'"]+)['"]\s*\]/g, (m, n) => or(m, envLookup(n)));
  s = s.replace(/\[(?:System\.)?Environment\]::GetFolderPath\(\s*(?:\[[^\]]*\]::)?['"]?(\w+)['"]?\s*\)/gi, (m, n) => {
    const folder = SPECIAL_FOLDERS[n.toLowerCase()];
    return or(m, folder && folder());
  });
  s = s.replace(/\b(?:os\.homedir|Path\.home)\(\)/g, () => homeDir());
  s = s.replace(/\$\(\s*(?:pwd|Get-Location|gl)\s*\)/gi, () => cwd);
  s = s.replace(/\$PSScriptRoot\b/gi, () => scriptDir);
  s = s.replace(/\$\{PWD\}|\$PWD\b/gi, () => cwd);
  s = s.replace(/\$\{([A-Za-z_]\w*)\}/g, (m, n) => (BARE_VARS.has(n.toLowerCase()) ? or(m, envLookup(n)) : m));
  s = s.replace(/\$([A-Za-z_]\w*)/g, (m, n) => (BARE_VARS.has(n.toLowerCase()) ? or(m, envLookup(n)) : m));
  s = s.replace(/(^|[\s'"`=(,;|&<>{[:])~(?=$|[\\/\s'"`),;|&<>}\]])/g, (m, pre) => pre + homeDir());
  return s;
}

// Rewrites one path token into a form path.win32 understands: Git Bash/WSL/Cygwin drives, file URLs, `\\?\` and
// `\\.\` prefixes, admin shares on this machine and PowerShell provider prefixes. Slashes become forward slashes.
function toWindowsPath(p) {
  let s = String(p).trim().replace(/\\/g, '/');
  s = s.replace(/^(?:microsoft\.powershell\.core\/)?filesystem::/i, '');
  s = s.replace(/^file:\/{2,3}(?=[a-z]:)/i, '').replace(/^file:\/\//i, '//');
  const lead = /^\/+/.exec(s);
  const leadLen = lead ? lead[0].length : 0;
  s = (leadLen >= 2 ? '//' : s.slice(0, leadLen)) + s.slice(leadLen).replace(/\/{2,}/g, '/');
  s = s.replace(/^\/\/[?.]\/unc\//i, '//').replace(/^\/\/[?.]\//, '');
  s = s.replace(ADMIN_SHARE_START, (m, d) => `${d}:`);
  s = s.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?=\/)/i, (m, d) => `${d}:`);
  return s;
}

function isAbsoluteLike(p) {
  const s = toWindowsPath(p);
  return /^[a-z]:\//i.test(s) || /^\/\/[^/]/.test(s);
}

function resolveCandidate(token, base) {
  const s = toWindowsPath(token);
  if (!s) return null;
  try {
    return win.resolve(base, s);
  } catch {
    return null;
  }
}

// Win32 ignores alternate data streams for containment and strips trailing dots and spaces from names.
function cleanSegment(seg) {
  const colon = seg.indexOf(':');
  const name = colon === -1 ? seg : seg.slice(0, colon);
  const trimmed = name.replace(/[. ]+$/, '');
  return trimmed || name;
}

const segmentCache = new Map();

// Canonical, case-folded segments of an absolute path: ['c:', 'users', 'me'] or ['//server', 'share', 'dir'].
function segmentsOf(p) {
  if (!p) return null;
  const key = String(p);
  if (segmentCache.has(key)) return segmentCache.get(key);
  const segs = computeSegments(key);
  if (segmentCache.size > 100000) segmentCache.clear();
  segmentCache.set(key, segs);
  return segs;
}

function computeSegments(p) {
  const s = p.normalize('NFC').toLowerCase().replace(/\\/g, '/');
  let head;
  let rest;
  const unc = /^\/\/([^/]+)\/([^/]+)(.*)$/.exec(s);
  if (unc) {
    head = [`//${unc[1]}`, cleanSegment(unc[2])];
    rest = unc[3];
  } else {
    const drive = /^([a-z]):(.*)$/.exec(s);
    if (!drive) return null;
    head = [`${drive[1]}:`];
    rest = drive[2];
  }
  const segs = rest.split('/').filter((x) => x && x !== '.').map(cleanSegment);
  return head.concat(segs);
}

function segmentsToPath(segs) {
  if (!segs || !segs.length) return null;
  if (segs[0].startsWith('//')) return `${segs.join('/')}`;
  return segs.length === 1 ? `${segs[0]}/` : segs.join('/');
}

function isGlobSegment(seg) {
  return /[*?]|\[[^\]]+\]|\{[^}]*,[^}]*\}/.test(seg);
}

function literalPrefix(segs) {
  const i = segs.findIndex(isGlobSegment);
  return i === -1 ? segs : segs.slice(0, i);
}

const globCache = new Map();

function globRegex(glob) {
  let re = globCache.get(glob);
  if (re) return re;
  let src = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') src += '.*';
    else if (c === '?') src += '.';
    else if (c === '{' && glob.indexOf('}', i) !== -1) {
      braces++;
      src += '(?:';
    } else if (c === ',' && braces > 0) src += '|';
    else if (c === '}' && braces > 0) {
      braces--;
      src += ')';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (body[0] === '!') body = `^${body.slice(1)}`;
        src += `[${body}]`;
        i = end;
      } else {
        src += '\\[';
      }
    } else {
      src += escapeRe(c);
    }
  }
  try {
    re = new RegExp(`^${src}$`);
  } catch {
    re = /^.*$/;
  }
  globCache.set(glob, re);
  return re;
}

function segMatch(g, r) {
  if (g === r) return true;
  return isGlobSegment(g) && globRegex(g).test(r);
}

// Whether glob segments `p` (which may contain `**`) match all of `s`.
function matchSegments(p, s) {
  const memo = new Map();
  const rec = (i, j) => {
    const key = i * 4096 + j;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (i === p.length) result = j === s.length;
    else if (p[i] === '**') result = rec(i + 1, j) || (j < s.length && rec(i, j + 1));
    else result = j < s.length && segMatch(p[i], s[j]) && rec(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return rec(0, 0);
}

// Whether a filename pattern names `segs` or one of its parent directories (gitignore-style: a match on a
// directory covers everything below it).
function patternHits(patternSegs, segs) {
  for (let end = 1; end <= segs.length; end++) {
    if (matchSegments(patternSegs, segs.slice(0, end))) return true;
  }
  return false;
}

// How candidate segments `g` (possibly with glob segments) relate to restricted segments `r`:
// 'inside' when g can name r itself or something below it, 'ancestor' when g can name a directory above r.
function relate(g, r) {
  if (!g || !r) return null;
  const n = Math.min(g.length, r.length);
  for (let i = 0; i < n; i++) {
    if (g[i] === '**') return 'inside';
    if (!segMatch(g[i], r[i])) return null;
  }
  return g.length >= r.length ? 'inside' : 'ancestor';
}

const realCache = new Map();
const dirCache = new Map();
const probeCache = new Map();

function realOf(p) {
  const key = p.toLowerCase();
  let real = realCache.get(key);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(p);
    } catch {
      real = null;
    }
    realCache.set(key, real);
  }
  return real;
}

function listDir(dir) {
  const key = dir.toLowerCase();
  let entries = dirCache.get(key);
  if (entries === undefined) {
    try {
      entries = new Map();
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) entries.set(d.name.normalize('NFC').toLowerCase(), d);
    } catch {
      entries = null;
    }
    dirCache.set(key, entries);
  }
  return entries;
}

// Walks an absolute path one directory listing at a time (each listing is read once and cached), following
// junctions and symlinks and expanding 8.3 short names. Returns the real path (unresolvable or glob tails kept as
// written) and whether the whole path exists.
function probePath(absPath) {
  const cacheKey = absPath.toLowerCase();
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;
  const root = win.parse(absPath).root;
  let result;
  if (!root) {
    result = { real: null, exists: false };
  } else {
    const rest = absPath.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let cur = realOf(root) || root;
    result = null;
    for (let i = 0; i < rest.length && !result; i++) {
      const seg = rest[i];
      const remainder = () => ({ real: win.join(cur, ...rest.slice(i)), exists: false });
      if (/[*?]/.test(seg)) {
        result = remainder();
      } else if (seg.includes('~')) {
        // Possibly an 8.3 short name, which directory listings do not show.
        const real = realOf(win.join(cur, seg));
        if (real) cur = real;
        else result = remainder();
      } else {
        const entries = listDir(cur);
        const entry = entries && entries.get(cleanSegment(seg.normalize('NFC').toLowerCase()));
        if (!entry) {
          result = remainder();
        } else {
          const next = win.join(cur, entry.name);
          cur = entry.isSymbolicLink() ? realOf(next) || next : next;
        }
      }
    }
    if (!result) result = { real: cur, exists: true };
  }
  if (probeCache.size > 100000) probeCache.clear();
  probeCache.set(cacheKey, result);
  return result;
}

function realpathLoose(absPath) {
  return probePath(absPath).real;
}

// Lower-cases and normalizes free text (a command or a script) so absolute paths in any spelling can be found
// with a plain substring search against canonPathText() of a restricted path.
function canonText(text) {
  let t = String(text).normalize('NFC').toLowerCase().replace(/\\/g, '/');
  t = t.replace(/(?:microsoft\.powershell\.core\/)?filesystem::/g, '');
  t = t.replace(/file:\/{2,3}(?=[a-z]:)/g, '');
  t = t.replace(/\/\/+[?.]\/+unc\//g, '//').replace(/\/\/+[?.]\/+(?=[a-z]:)/g, '');
  t = t.replace(ADMIN_SHARE_TEXT, (m, d) => `${d}:`);
  t = t.replace(GITBASH_TEXT, (m, pre, d) => `${pre}${d}:`);
  t = t.replace(/\/{2,}/g, '/');
  t = t.replace(/([^/.\s])\.+(?=\/)/g, (m, c) => c);
  return t;
}

function canonPathText(p) {
  return canonText(p).replace(/\/+$/, '');
}

// Characters that continue a file name; anything else ends it.
const NAME_CHAR = /[\p{L}\p{N}_\-~#@!+]/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const PATH_END = /[\s'"`;|&<>(),]/;

// Finds `form` (a canonPathText) in canonical text where it is a whole path or a prefix of one, and returns the
// full path text at each hit.
function findTextMatches(text, form) {
  const hits = [];
  if (!form) return hits;
  let i = text.indexOf(form);
  while (i !== -1) {
    const prev = i > 0 ? text[i - 1] : '';
    let j = i + form.length;
    while (text[j] === '.') j++;
    const next = text[j];
    if ((!prev || !WORD_CHAR.test(prev)) && (next === undefined || !NAME_CHAR.test(next))) {
      let end = i;
      while (end < text.length && !PATH_END.test(text[end])) end++;
      hits.push(text.slice(i, end));
    }
    i = text.indexOf(form, i + 1);
  }
  return hits;
}

module.exports = {
  canonPathText,
  canonText,
  envLookup,
  expandVars,
  findTextMatches,
  homeDir,
  isAbsoluteLike,
  isGlobSegment,
  listDir,
  literalPrefix,
  matchSegments,
  patternHits,
  probePath,
  realpathLoose,
  relate,
  resolveCandidate,
  segmentMatches: segMatch,
  segmentsOf,
  segmentsToPath,
  toWindowsPath,
};
