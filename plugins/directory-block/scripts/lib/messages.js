'use strict';

const MAX_LISTED = 5;
const MAX_EVIDENCE = 160;

function clip(s) {
  const text = String(s).replace(/\s+/g, ' ').trim();
  return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE)}...` : text;
}

const TEXT = {
  ko: {
    deny: '⛔ [directory-block] 제한된 경로에 대한 접근을 차단했습니다.',
    ask: '⚠️ [directory-block] 제한된 경로에 대한 접근이 감지되었습니다. 허용할지 확인하세요.',
    reference: (v) => `제한 경로를 참조합니다: "${clip(v.evidence)}"`,
    'recursive-ancestor': (v) => `상위 디렉토리 "${clip(v.evidence)}"에 대한 재귀·삭제·이동 작업이 제한 경로까지 미칩니다`,
    'implicit-cwd': (v) => `경로 없이 실행한 재귀 탐색이 현재 디렉토리(${v.resolved})에서 제한 경로까지 내려갑니다`,
    'cwd-inside': () => '현재 작업 디렉토리가 제한 경로 안에 있습니다',
    protected: (v) => `보호된 directory-block 파일입니다: "${clip(v.evidence)}" (내용 확인은 Read 도구만 허용)`,
    'encoded-command': (v) => `해독·검증할 수 없는 인코딩 명령입니다: ${clip(v.evidence)}`,
    reason: (r) => `사유: ${r}`,
    script: (p) => `(실행되는 파일 ${p} 안에서 발견)`,
    manifest: (p) => `(${p}에 정의된 스크립트에서 발견)`,
    encoded: '(인코딩된 명령 안에서 발견)',
    more: (n) => `…외 ${n}건`,
    footer: '사용자가 접근 금지로 지정한 경로입니다. 다른 경로 표기·스크립트·인코딩 등으로 우회하지 말고, 이 경로 없이 작업하거나 사용자에게 직접 요청하세요.',
    reasons: {
      globalConfig: 'directory-block 전역 설정 파일',
      projectConfig: 'directory-block 프로젝트 설정 파일',
      auditLog: 'directory-block 감사 로그',
      pluginRoot: 'directory-block 플러그인 설치 경로',
      claudeSettings: 'Claude Code 설정 파일 (protectClaudeSettings)',
    },
    configError: (errors) => [
      '⛔ [directory-block] 설정 파일에 오류가 있어 안전을 위해 셸 명령과 파일 쓰기를 모두 차단합니다.',
      ...errors.map((e) => `• ${e}`),
      '사용자가 편집기에서 설정 파일을 직접 고쳐야 합니다. Claude는 이 파일을 수정할 수 없습니다.',
    ].join('\n'),
    internalError: (msg) => `⛔ [directory-block] 검사 중 내부 오류가 발생해 안전을 위해 차단했습니다: ${msg}`,
  },
  en: {
    deny: '⛔ [directory-block] Blocked access to a restricted path.',
    ask: '⚠️ [directory-block] This touches a restricted path. Confirm whether to allow it.',
    reference: (v) => `references a restricted path: "${clip(v.evidence)}"`,
    'recursive-ancestor': (v) => `a recursive, delete or move operation on parent directory "${clip(v.evidence)}" reaches the restricted path`,
    'implicit-cwd': (v) => `a recursive search with no path argument walks from the current directory (${v.resolved}) into the restricted path`,
    'cwd-inside': () => 'the current working directory is inside the restricted path',
    protected: (v) => `protected directory-block file: "${clip(v.evidence)}" (only the Read tool may view it)`,
    'encoded-command': (v) => `encoded command that cannot be decoded and verified: ${clip(v.evidence)}`,
    reason: (r) => `reason: ${r}`,
    script: (p) => `(found in executed file ${p})`,
    manifest: (p) => `(found in scripts defined in ${p})`,
    encoded: '(found inside an encoded command)',
    more: (n) => `...and ${n} more`,
    footer: 'The user has made this path off-limits. Do not work around it with other path spellings, scripts or encodings; continue without it or ask the user directly.',
    reasons: {
      globalConfig: 'directory-block global config',
      projectConfig: 'directory-block project config',
      auditLog: 'directory-block audit log',
      pluginRoot: 'directory-block plugin install directory',
      claudeSettings: 'Claude Code settings file (protectClaudeSettings)',
    },
    configError: (errors) => [
      '⛔ [directory-block] The config file has errors, so shell commands and file writes are blocked until it is fixed.',
      ...errors.map((e) => `• ${e}`),
      'The user has to fix the file in an editor; Claude cannot modify it.',
    ].join('\n'),
    internalError: (msg) => `⛔ [directory-block] Blocked because the check failed with an internal error: ${msg}`,
  },
};

function strings(lang) {
  return TEXT[lang] || TEXT.ko;
}

function ruleReason(rule, lang) {
  if (!rule) return '';
  if (rule.reasonKey) return strings(lang).reasons[rule.reasonKey] || '';
  return rule.reason || '';
}

function originNote(origin, t) {
  if (!origin || origin === 'command' || origin === 'tool') return '';
  if (origin === 'encoded') return ` ${t.encoded}`;
  if (origin.startsWith('script:')) return ` ${t.script(origin.slice(7))}`;
  if (origin.startsWith('manifest:')) return ` ${t.manifest(origin.slice(9))}`;
  return '';
}

function formatReason(violations, { lang, decision }) {
  const t = strings(lang);
  const lines = [decision === 'ask' ? t.ask : t.deny];
  for (const v of violations.slice(0, MAX_LISTED)) {
    const describe = t[v.type] || t.reference;
    const target = v.rule ? `${v.rule.path} — ` : '';
    lines.push(`• ${target}${describe(v)}${originNote(v.origin, t)}`);
    const reason = ruleReason(v.rule, lang);
    if (reason) lines.push(`  ${t.reason(reason)}`);
  }
  if (violations.length > MAX_LISTED) lines.push(t.more(violations.length - MAX_LISTED));
  lines.push(t.footer);
  return lines.join('\n');
}

function formatConfigError(errors, lang) {
  return strings(lang).configError(errors);
}

function formatInternalError(err, lang) {
  return strings(lang).internalError(err && err.message ? err.message : String(err));
}

module.exports = { formatConfigError, formatInternalError, formatReason, ruleReason, strings };
