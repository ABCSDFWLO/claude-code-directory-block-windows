'use strict';

const { execFileSync } = require('child_process');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, createFixture, fwd, gitBash, psBase64, removeFixture, useFixtureEnv } = require('./helpers');

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

function shell(command, opts = {}) {
  return analyze(fx, { ...opts, tool: opts.tool || 'Bash', input: { command } });
}

function assertBlocked(violations, label) {
  assert.ok(violations.length > 0, `expected a block for: ${label}`);
}

function assertAllowed(violations, label) {
  assert.deepEqual(violations.map((v) => `${v.type}: ${v.evidence}`), [], `expected no block for: ${label}`);
}

describe('blocks restricted paths in shell commands', () => {
  const cases = [
    ['absolute path with backslashes', () => `type ${fx.secrets}\\a.txt`],
    ['forward slashes', () => `cat ${fwd(fx.secrets)}/a.txt`],
    ['Git Bash drive path', () => `cat ${gitBash(fx.secrets)}/a.txt`],
    ['different letter case', () => `cat ${fx.secrets.toUpperCase()}\\A.TXT`],
    ['doubled backslashes', () => `python -c "print(open('${fx.secrets.replace(/\\/g, '\\\\')}\\\\a.txt').read())"`],
    ['quoted path with spaces', () => `cat "${fx.spaced}\\x.txt"`],
    ['the restricted directory itself', () => `ls ${fx.secrets}`],
    ['relative path from the project', () => 'cat ../secrets/a.txt'],
    ['cd then relative path', () => 'cd .. && cat secrets/a.txt'],
    ['Set-Location then relative path', () => 'Set-Location ..; Get-Content .\\secrets\\a.txt', { tool: 'PowerShell' }],
    ['cmd %VAR%', () => 'type %DB_TEST_ROOT%\\secrets\\a.txt'],
    ['PowerShell $env:VAR', () => 'Get-Content $env:DB_TEST_ROOT\\secrets\\a.txt', { tool: 'PowerShell' }],
    ['tilde', () => 'cat ~/.ssh/id_rsa'],
    ['$HOME', () => 'cat $HOME/.ssh/id_rsa'],
    ['$env:USERPROFILE in a string', () => 'Get-Content "$env:USERPROFILE\\.ssh\\id_rsa"', { tool: 'PowerShell' }],
    ['GetFolderPath plus concatenation', () => "Get-Content ([Environment]::GetFolderPath('UserProfile') + '\\.ssh\\id_rsa')", { tool: 'PowerShell' }],
    ['Join-Path', () => 'Get-Content (Join-Path $env:DB_TEST_ROOT secrets)', { tool: 'PowerShell' }],
    ['junction pointing into the restricted directory', () => 'type link\\a.txt'],
    ['trailing dot that Win32 strips', () => `type ${fx.secrets}.\\a.txt`],
    ['alternate data stream on the directory', () => `type ${fx.secrets}::$INDEX_ALLOCATION`],
    ['wildcard matching the restricted directory', () => `cat ${fx.root}\\sec*\\a.txt`],
    ['brace expansion', () => `cat ${fwd(fx.root)}/secret{s,x}/a.txt`],
    ['admin share on this machine', () => `type \\\\localhost\\${fx.secrets[0]}$\\${fx.secrets.slice(3)}\\a.txt`],
    ['long path prefix', () => `type \\\\?\\${fx.secrets}\\a.txt`],
    ['file URL', () => `curl file:///${fwd(fx.secrets)}/a.txt`],
    ['PowerShell provider path', () => `Get-Content FileSystem::${fx.secrets}\\a.txt`, { tool: 'PowerShell' }],
    ['redirect into a restricted directory', () => 'echo hi > private/x.txt'],
    ['bare relative directory name', () => 'ls private'],
    ['relative path from the project config', () => 'cat private/notes.txt'],
    ['python -c', () => `python -c "print(open('../secrets/a.txt').read())"`],
    ['bash -c', () => "bash -c 'cat ../secrets/a.txt'"],
    ['heredoc', () => "python - <<'EOF'\nprint(open('../secrets/a.txt').read())\nEOF"],
    ['string concatenation', () => `python -c "open('${fwd(fx.root)}/sec' + 'rets/a.txt')"`],
    ['os.path.join of literals', () => `python -c "import os; open(os.path.join('${fwd(fx.root)}', 'secrets', 'a.txt'))"`],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => assertBlocked(shell(command(), opts), label));
  }
});

describe('blocks recursive, destructive and implicit operations on parent directories', () => {
  const cases = [
    ['grep -r on the parent', () => 'grep -r password ..'],
    ['Get-ChildItem -Recurse on the parent', () => `Get-ChildItem ${fx.root} -Recurse`, { tool: 'PowerShell' }],
    ['gci -r through a pipeline', () => `gci ${fx.root} | ForEach-Object { Remove-Item $_.FullName -Recurse }`, { tool: 'PowerShell' }],
    ['rm -rf on the parent', () => `rm -rf ${fwd(fx.root)}`],
    ['wildcard delete in the parent', () => `Remove-Item ${fx.root}\\* -Recurse -Force`, { tool: 'PowerShell' }],
    ['moving the parent away', () => `Move-Item ${fx.root} D:\\elsewhere`, { tool: 'PowerShell' }],
    ['tar of the parent', () => `tar -czf out.tgz ${fwd(fx.root)}`],
    ['robocopy /mir into the parent', () => `robocopy src ${fx.root} /mir`],
    ['rg with no path from the parent', () => 'rg password', { cwd: fx.root }],
    ['find with no path from the parent', () => 'find -name "*.txt"', { cwd: fx.root }],
    ['cmd /c dir /s from the parent', () => 'cmd /c dir /s', { cwd: fx.root }],
    ['sh -c with cd and find', () => "sh -c 'cd .. && find .'"],
    ['python os.walk on the parent', () => `python -c "import os; print(list(os.walk('${fwd(fx.root)}')))"`],
    ['working directory inside the restricted path', () => 'ls', { cwd: fx.secrets }],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => assertBlocked(shell(command(), opts), label));
  }
});

describe('inspects what the command executes', () => {
  const cases = [
    ['powershell -File script', () => 'powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1'],
    ['script run directly', () => '.\\run.ps1', { tool: 'PowerShell' }],
    ['python script with os.path.join', () => 'python tool.py'],
    ['extensionless script', () => './deploy'],
    ['npm script from package.json', () => 'npm run leak', { cwd: fx.p('proj', 'pkg') }],
    ['powershell -EncodedCommand', () => `powershell -EncodedCommand ${psBase64(`Get-Content '${fx.secrets}\\a.txt'`)}`],
    ['pwsh -enc', () => `pwsh -enc ${psBase64('Get-Content ..\\secrets\\a.txt')}`],
    ['undecodable encoded command', () => 'powershell -enc !!notbase64!!'],
    ['base64 decoded in a pipeline', () => `echo ${Buffer.from(`${fwd(fx.secrets)}/a.txt`).toString('base64')} | base64 -d | xargs cat`],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => assertBlocked(shell(command(), opts), label));
  }

  it('never reads a restricted file, so its contents cannot leak into the block message', () => {
    const violations = shell(`& "${fx.secrets}\\inner.ps1"`, { tool: 'PowerShell' });
    assertBlocked(violations, 'restricted script');
    assert.ok(violations.every((v) => !v.evidence.includes('TOPSECRETWORD')), JSON.stringify(violations.map((v) => v.evidence)));
  });

  it('reports each restricted hit once', () => {
    const violations = shell(`type ${fx.secrets}\\a.txt`);
    assert.equal(violations.length, 1, JSON.stringify(violations.map((v) => v.evidence)));
  });

  it('reports where a finding inside a script came from', () => {
    const violations = shell('powershell -File run.ps1');
    assert.ok(violations.some((v) => v.origin.startsWith('script:') && v.origin.endsWith('run.ps1')));
  });
});

describe('does not block ordinary commands', () => {
  const cases = [
    ['plain project commands', () => 'ls && npm test && git status'],
    ['look-alike sibling directory', () => `cat ${fx.root}\\secrets2\\x.txt`],
    ['look-alike file name', () => `cat ${fx.root}\\secrets.txt`],
    ['allowed exception inside a restricted path', () => `cat ${fx.secrets}\\public\\readme.txt`],
    ['recursive grep on an unrelated directory', () => 'grep -r foo src'],
    ['listing the parent without recursion', () => 'ls ..'],
    ['ls -ltr in the parent (reverse sort, not recursion)', () => 'ls -ltr', { cwd: fx.root }],
    ['reading a file that mentions a restricted path', () => 'cat notes.md'],
    ['running a benign script', () => 'powershell -File benign.ps1'],
    ['cmd dir /s on a subdirectory', () => 'cmd /c dir /s src'],
    ['commit message that names a restricted folder', () => 'git commit -m "move private/ settings"'],
    ['echo of a restricted folder name', () => 'echo private'],
    ['rg with an explicit unrelated path from the parent', () => 'rg password secrets2', { cwd: fx.root }],
    ['copying into the parent directory', () => 'cp -r src ..'],
    ['moving a file into the parent directory', () => 'mv notes.md ..'],
    ['benign encoded command', () => `powershell -enc ${psBase64('Get-Date')}`],
    ['benign python -c', () => 'python -c "print(1 + 1)"'],
    ['URL with a matching path', () => 'curl https://example.com/secrets/a.txt'],
    ['cmd switches that look like root paths', () => 'cmd /c echo /s /q'],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => assertAllowed(shell(command(), opts), label));
  }
});

describe('8.3 short names', () => {
  it('resolves a short name to the restricted directory', (t) => {
    let short;
    try {
      short = execFileSync('cmd', ['/d', '/c', `for %I in ("${fx.root}") do @echo %~sI`], { encoding: 'utf8' }).trim();
    } catch {
      short = '';
    }
    if (!short || short.toLowerCase() === fx.root.toLowerCase()) {
      t.skip('8.3 names are disabled on this volume');
      return;
    }
    assertBlocked(shell(`type ${short}\\secrets\\a.txt`), 'short name');
  });
});

describe('self-protection', () => {
  const cases = [
    ['reading the global config through the shell', () => `cat ${fwd(fx.claude)}/directory-block.json`],
    ['overwriting the global config', () => `echo {} > ${fx.claude}\\directory-block.json`],
    ['editing the project config', () => 'Set-Content .claude/directory-block.json "{}"', { tool: 'PowerShell' }],
    ['deleting the folder that holds the config', () => `Remove-Item ${fx.claude} -Recurse`, { tool: 'PowerShell' }],
    ['touching the plugin directory', () => `cat ${fwd(fx.pluginRoot)}/scripts/guard.js`, { pluginRoot: fx.pluginRoot }],
  ];
  for (const [label, command, opts] of cases) {
    it(label, () => {
      const violations = shell(command(), opts);
      assert.ok(violations.some((v) => v.type === 'protected'), label);
    });
  }

  it('leaves the plugin directory alone when no plugin root is known', () => {
    const violations = analyze(fx, {
      input: { command: `cat ${fwd(fx.pluginRoot)}/scripts/guard.js` },
      pluginRoot: undefined,
    });
    assertAllowed(violations, 'no plugin root');
  });
});

describe('file tools', () => {
  const file = (tool, input, opts = {}) => analyze(fx, { tool, input, ...opts });

  it('blocks Read inside a restricted path', () => assertBlocked(file('Read', { file_path: `${fx.secrets}\\a.txt` }), 'Read'));
  it('blocks Read through a junction', () => assertBlocked(file('Read', { file_path: fx.p('proj', 'link', 'a.txt') }), 'Read junction'));
  it('blocks Write into a restricted path', () => assertBlocked(file('Write', { file_path: fx.p('proj', 'private', 'n.txt'), content: 'x' }), 'Write'));
  it('allows Read elsewhere', () => assertAllowed(file('Read', { file_path: fx.p('proj', 'src', 'app.py') }), 'Read app.py'));
  it('allows Read inside an allow exception', () => assertAllowed(file('Read', { file_path: fx.p('secrets', 'public', 'readme.txt') }), 'Read public'));
  it('allows Read of the config', () => assertAllowed(file('Read', { file_path: fx.p('claude', 'directory-block.json') }), 'Read config'));
  it('blocks Edit of the config', () => {
    const v = file('Edit', { file_path: fx.p('claude', 'directory-block.json'), old_string: 'a', new_string: 'b' });
    assert.ok(v.some((x) => x.type === 'protected'));
  });
  it('blocks Glob that descends into a restricted path', () => assertBlocked(file('Glob', { pattern: '**/*.txt', path: fx.root }), 'Glob **'));
  it('blocks Glob whose fixed part is restricted', () => assertBlocked(file('Glob', { pattern: 'secrets/*.txt', path: fx.root }), 'Glob literal'));
  it('allows Glob in an unrelated folder', () => assertAllowed(file('Glob', { pattern: 'src/*.py' }), 'Glob src'));
  it('allows Glob ** when recursive-ancestor checks are off', () => {
    assertAllowed(file('Glob', { pattern: '**/*.txt', path: fx.root }, { options: { checkRecursiveAncestors: false } }), 'Glob ** off');
  });
  it('blocks Grep over a parent directory', () => assertBlocked(file('Grep', { pattern: 'x', path: fx.root }), 'Grep parent'));
  it('allows Grep in an unrelated folder', () => assertAllowed(file('Grep', { pattern: 'x', path: fx.p('proj', 'src') }), 'Grep src'));
  it('leaves file tools alone when protectFileTools is off', () => {
    assertAllowed(file('Read', { file_path: `${fx.secrets}\\a.txt` }, { options: { protectFileTools: false } }), 'protectFileTools off');
  });
});
