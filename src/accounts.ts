// ────────────────────────────────────────────────────────────────────────
//  접근 규칙 (비번 → 접근 가능한 폴더)
//
//  ⚠ 비밀값(비번)은 이 소스에 적지 않는다. 실제 값은 .env 에서 채운다(.env 는 gitignore).
//  이 파일은 .env 를 읽어 규칙으로 파싱하는 '로직'만 갖는다.
//
//  .env 형식 — 계정마다 한 줄, 파이프(|) 로 구분:
//    SCREEN_ACCOUNT_1=<비번>|<접근폴더>|<이름>
//    SCREEN_ACCOUNT_2=<비번2>|<접근폴더2>|<이름2>
//    SCREEN_ACCOUNT_3=<비번3>||<이름3>        ← root(접근폴더) 를 비우면 전체 접근(무제한)
//  · 1번부터 연속으로 읽는다(빈 번호를 만나면 멈춘다).
//  · password : 폰 접속 비번. (파이프 | 문자는 쓰지 말 것)
//  · root     : 접근 허용 폴더. 폴더 탐색·새 세션·에이전트 도구가 이 서브트리로 제한됨.
//               비우면 전체 접근. 제한(root 지정) 계정은 lite 화면을 못 쓴다.
//  · label    : 표시용 이름(선택). 부팅 로그에 함께 찍힌다.
//
//  규칙은 서버 부팅 시 1회 읽는다 → 바꾸면 서버를 재시작해야 반영된다.
//  .env 가 비어 있으면 auth.ts 가 SCREEN_ACCESS(JSON) → 단일 SCREEN_TOKEN 순으로 폴백.
// ────────────────────────────────────────────────────────────────────────

// .env 를 process.env 로 로드(Node 20.12+/21.7+ 내장). 없으면 조용히 무시.
// accounts.ts 는 auth.ts 보다 먼저 평가되므로, 여기서 로드하면 이후 모든 env 읽기에 반영된다.
try {
  process.loadEnvFile();
} catch {
  /* .env 파일이 없으면 그냥 환경변수/폴백을 쓴다 */
}

export interface AccountRule {
  password: string;
  root?: string;
  label?: string;
}

/** .env 의 SCREEN_ACCOUNT_1, _2, … 을 순서대로 파싱해 규칙 목록으로. */
function parseAccountRules(): AccountRule[] {
  const rules: AccountRule[] = [];
  for (let i = 1; ; i++) {
    const raw = process.env[`SCREEN_ACCOUNT_${i}`];
    if (raw == null) break; // 빈 번호를 만나면 종료
    const line = raw.trim();
    if (!line) continue; // 값이 비면 건너뛴다(번호는 계속)
    // password|root|label — label 에 | 가 들어가도 되도록 앞 2개만 분리한다.
    const parts = line.split('|');
    const password = (parts[0] ?? '').trim();
    const root = (parts[1] ?? '').trim();
    const label = parts.slice(2).join('|').trim();
    rules.push({
      password,
      root: root || undefined,
      label: label || undefined,
    });
  }
  return rules;
}

export const ACCOUNT_RULES: AccountRule[] = parseAccountRules();
