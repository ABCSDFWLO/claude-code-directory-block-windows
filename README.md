# directory-block — Windows용 제한 디렉토리 차단 플러그인

Claude Code가 실행하려는 **모든 셸 명령(Bash / PowerShell)** 과 파일 도구 호출을 `PreToolUse` 훅에서 가로채, 사용자가 지정한 **제한 디렉토리**에 닿는지 검사하고 자동으로 차단하는 Claude Code 플러그인입니다. 명령이 실행하는 스크립트 파일의 내용까지 검사합니다.

```
Claude ──(Bash/PowerShell/Read/Write/Edit/Glob/Grep 호출)──▶ PreToolUse 훅: guard.js
                                                              │
                         설정 로드 (~/.claude/directory-block.json + <프로젝트>/.claude/directory-block.json)
                                                              │
                         분석: 경로 표기 정규화 → 토큰/상대경로 해석 → 재귀·삭제 작업 → 실행 스크립트·인코딩 해독
                                                              │
                                  위반 없음 → 통과   /   위반 → deny(또는 ask) + 사유 + 감사 로그
```

## 무엇을 잡아내나

| 우회 시도 | 예시 (제한: `C:\Secrets`) |
|---|---|
| 슬래시·대소문자·따옴표 | `cat c:/SECRETS/a.txt`, `type "C:\Secrets\a b.txt"` |
| Git Bash / WSL / Cygwin 경로 | `cat /c/Secrets/a.txt`, `/mnt/c/...`, `/cygdrive/c/...` |
| 상대 경로, `cd` 후 접근 | `cat ../Secrets/a.txt`, `cd C:\ && type Secrets\a.txt`, `Set-Location` |
| 환경 변수 | `%USERPROFILE%`, `$env:USERPROFILE`, `${env:X}`, `$HOME`, `~`, `[Environment]::GetFolderPath(...)`, `os.environ[...]`, `process.env.X` |
| 경로 조립 | `Join-Path`, `os.path.join("C:\\", "Secrets")`, `"C:/Sec" + "rets"`, `$base + '\x'`, 중괄호 확장 `Secret{s,x}` |
| Windows 특수 표기 | `\\?\C:\...`, `\\localhost\C$\...`, `file:///C:/...`, `FileSystem::C:\...`, 끝의 점 `C:\Secrets.\`, ADS `C:\Secrets::$INDEX_ALLOCATION` |
| 링크·짧은 이름 | 정션/심볼릭 링크 (`mklink /J link C:\Secrets` 후 `type link\a.txt`), 8.3 이름 `C:\SECRE~1` |
| 와일드카드 | `cat C:\Sec*\a.txt`, `Remove-Item C:\* -Recurse` |
| 상위 디렉토리 재귀·삭제·이동 | `grep -r x C:\`, `Get-ChildItem C:\ -Recurse`, `rm -rf C:/`, `Move-Item C:\Parent ...`, `robocopy src C:\ /mir`, 경로 없는 `rg`/`find`/`dir /s` |
| 실행되는 파일의 내용 | `powershell -File x.ps1`, `.\x.ps1`, `python x.py`, `./deploy`, `npm run x`(package.json), `make`(Makefile) |
| 중첩·인코딩 | `bash -c "..."`, `cmd /c "..."`, `python -c "..."`, heredoc, `powershell -EncodedCommand <base64>`, `base64 -d` 파이프 |
| 파일 도구 | `Read`/`Write`/`Edit`/`NotebookEdit`의 경로, 제한 경로로 내려가는 `Glob`, 상위 디렉토리를 훑는 `Grep` |

오탐을 줄이기 위해 다음은 **통과**시킵니다: 이름만 비슷한 형제 경로(`C:\Secrets2`, `C:\Secrets.txt`), `allow` 예외, 커밋 메시지·`echo`의 상대 이름, 상위 디렉토리의 비재귀 조회(`ls ..`), 상위 디렉토리로 복사·이동(`cp -r dist ..`), 제한 경로를 언급만 하는 파일을 읽기(`cat notes.md`), URL.

## 설치

Node.js 18 이상이 필요합니다 (`node`가 PATH에 있어야 함).

**로컬 마켓플레이스로 설치** (Claude Code 터미널):

```
/plugin marketplace add C:\Users\admin\Documents\claude-code-directory-block-windows
/plugin install directory-block@directory-block-marketplace
```

**설치 없이 한 세션만 시험**:

```bash
claude --plugin-dir "C:\Users\admin\Documents\claude-code-directory-block-windows\plugins\directory-block"
```

> 로컬 경로에서 추가한 마켓플레이스의 플러그인은 **복사 없이 이 저장소에서 바로 로드**됩니다. 이 상태에서는 자체 보호 때문에 Claude가 이 저장소의 `plugins/directory-block`을 수정할 수 없습니다. 플러그인을 개발하는 동안에는 전역 설정에 `"protectPluginRoot": false`를 넣으세요.

## 설정

| 파일 | 권한 |
|---|---|
| `%USERPROFILE%\.claude\directory-block.json` (전역; `CLAUDE_CONFIG_DIR` 또는 `DIRECTORY_BLOCK_CONFIG`로 변경 가능) | 모든 항목과 옵션 |
| `<프로젝트>\.claude\directory-block.json` (프로젝트) | 제한 경로 **추가**와 옵션 **강화**만 가능 (저장소가 전역 설정을 느슨하게 만들 수 없음) |

```json
{
  "restricted": [
    "~\\.ssh",
    "%USERPROFILE%\\.aws",
    { "path": "D:\\finance", "reason": "재무 데이터 — 접근 금지" }
  ],
  "allow": ["D:\\finance\\public"],
  "options": { "onViolation": "deny" }
}
```

- 경로에는 `~`, `%VAR%`, `$env:VAR`, `/` 또는 `\`를 쓸 수 있습니다. 전역 파일은 절대 경로만, 프로젝트 파일은 프로젝트 기준 상대 경로도 허용합니다. `D:`만 쓰면 드라이브 전체입니다.
- 파일도 지정할 수 있습니다 (예: `~\\.claude\\settings.json`).
- `allow`는 **같은 파일**의 제한 경로 안에 있는 예외에만 적용됩니다.
- 변경은 다음 도구 호출부터 바로 적용됩니다 (재시작 불필요). 전체 예시: [config/directory-block.example.json](plugins/directory-block/config/directory-block.example.json)

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `onViolation` | `"deny"` | `"ask"`면 차단 대신 사용자에게 확인. 자체 보호 위반·검증 불가 인코딩은 항상 deny |
| `scanScripts` | `true` | 명령이 실행하는 스크립트·`package.json`·`Makefile` 내용 검사 |
| `maxScriptBytes` / `maxScriptDepth` | `1048576` / `3` | 스크립트당 읽는 최대 바이트, 중첩 검사 깊이 |
| `checkRecursiveAncestors` | `true` | 상위 디렉토리에 대한 재귀 탐색(`grep -r`, `gci -Recurse`, `Glob **`, `Grep`) 차단. 삭제·이동은 이 옵션과 무관하게 항상 차단 |
| `encodedCommands` | `"decode"` | `decode`: 해독해서 검사, 해독 불가면 차단 · `block`: 인코딩 명령 전면 차단 · `allow`: 검사 안 함 |
| `protectFileTools` | `true` | Read/Write/Edit/Glob/Grep 등 파일 도구에도 제한 적용 |
| `selfProtect` | `true` | 설정 파일·감사 로그 보호 (셸: 모든 접근 차단, 파일 도구: 쓰기만 차단) |
| `protectPluginRoot` | `true` | 플러그인 설치 경로 보호 |
| `protectClaudeSettings` | `false` | `settings.json`/`settings.local.json`도 보호 (Claude가 플러그인을 끄지 못하게) |
| `auditLog` | `true` | 차단 기록을 `~/.claude/directory-block/audit.jsonl`에 남김. 문자열이면 그 경로 |
| `announceToClaude` | `true` | 세션 시작 시 제한 경로 목록을 Claude에게 미리 알려 시도 자체를 줄임 |
| `language` | `"ko"` | 차단 메시지 언어 (`ko` / `en`) |

설정 파일이 깨지면(잘못된 JSON, 상대 경로 등) **안전을 위해 모든 셸 명령과 파일 쓰기를 차단**하고, 설정 파일 Read만 허용합니다.

## CLI (사용자 터미널에서)

```bash
node plugins/directory-block/scripts/cli.js add "D:\finance" --reason "재무 데이터"
```

```bash
node plugins/directory-block/scripts/cli.js check --cwd "C:\work" -- "type ..\finance\q3.xlsx"
```

`list`, `init`, `remove`, `--allow`, `--project DIR`도 지원합니다. Claude 세션 안에서는 `/directory-block:status`로 현재 설정을 요약해 볼 수 있습니다. Claude가 이 CLI를 실행하거나 설정 파일을 고치는 것은 자체 보호로 막혀 있습니다.

## 실제 세션에서 확인하기

1. 전역 설정에 테스트용 폴더를 추가합니다: `cli.js add "C:\temp\dirblock-test"` (폴더와 안에 `a.txt` 생성)
2. 플러그인을 켠 세션에서 "Bash로 `cat /c/temp/dirblock-test/a.txt` 실행해줘"라고 요청합니다.
3. `⛔ [directory-block] 제한된 경로에 대한 접근을 차단했습니다.` 메시지와 함께 차단되고 `~/.claude/directory-block/audit.jsonl`에 기록이 남으면 정상입니다.

## 한계

이 플러그인은 **명령을 실행하기 전에 텍스트를 분석하는 가드레일**이지 OS 수준의 샌드박스가 아닙니다. 다음은 잡지 못합니다.

- 실행 중에 문자열을 계산해 만드는 경로 (`[char]67 + ...`, 변수 여러 개로 쪼갠 조립, 네트워크에서 받은 스크립트)
- 경로 인자 없이 프로그램이 내부적으로 훑는 경우 (`git add -A`, 빌드 도구, 테스트 러너). 단 `rg`/`find`/`dir /s` 같은 탐색 명령은 현재 디렉토리 기준으로 검사합니다.
- 사전에 만들어 둔 `subst` 드라이브·하드 링크, Git Bash의 `/tmp`, `/usr` 같은 가상 루트
- MCP 서버가 제공하는 파일 도구

반대로 보수적으로 막는 경우도 있습니다. 프로젝트 하위 폴더를 제한하면, 프로젝트 루트에서 하는 재귀 검색(`grep -r`, `Glob **/*`, 경로 없는 `Grep`)도 그 폴더까지 내려가므로 차단됩니다. 이때 Claude는 차단 메시지를 보고 더 좁은 경로로 다시 시도합니다. 불편하면 `checkRecursiveAncestors: false`로 끌 수 있지만, 그러면 재귀 검색으로 제한 폴더 내용이 읽힐 수 있습니다.

악의적인 우회까지 확실히 막아야 한다면 Claude Code를 별도 Windows 계정으로 실행하고 NTFS 권한(`icacls ... /deny`)으로 해당 폴더를 막는 것과 함께 쓰세요.

## 구조

```
.claude-plugin/marketplace.json      로컬 마켓플레이스
plugins/directory-block/
  .claude-plugin/plugin.json         플러그인 매니페스트
  hooks/hooks.json                   PreToolUse(guard.js) · SessionStart(session-start.js), onFailure: block
  scripts/guard.js                   훅 진입점 — 판정, 메시지, 감사 로그, 실패 시 차단
  scripts/session-start.js           세션 시작 상태 표시 + Claude에게 제한 경로 안내
  scripts/cli.js                     사용자용 관리·점검 CLI
  scripts/lib/paths.js               경로 표기 정규화, 변수 확장, 글롭·상위 관계 판정, 링크/8.3 해석
  scripts/lib/shell.js               bash/PowerShell/cmd 겸용 토크나이저
  scripts/lib/analyzer.js            다층 분석기
  scripts/lib/config.js              설정 로드·병합·검증, 자체 보호 대상
  commands/status.md                 /directory-block:status
tests/                               node:test 테스트 (우회 시도 / 오탐 / 훅 프로세스 / 설정 / 매니페스트)
```

## 개발

```bash
npm test
```

외부 의존성은 없습니다. 테스트는 임시 폴더에 제한 폴더·정션·스크립트를 만들어 실제 파일 시스템으로 검사합니다. 검사 1회는 약 70 ms(대부분 Node 시작 시간)입니다.
