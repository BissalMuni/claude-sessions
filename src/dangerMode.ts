// 위험 모드(danger)의 런타임 상태. 폰 UI 스위치로 토글되며, 모든 세션의
// canUseTool 이 매 호출마다 isDanger() 를 읽어 동작을 바꾼다.
//
// 기본값은 ON 이다. 운영 정책상 위험 모드를 기본으로 켠 채 시작한다.
// 끄고 시작하려면 환경변수 SCREEN_DANGER=0 으로만 가능하다(미설정/그 외 값은 ON).
let danger = process.env.SCREEN_DANGER !== '0';

/** 현재 위험 모드 여부 */
export function isDanger(): boolean {
  return danger;
}

/** 위험 모드를 켜고/끈다 (폰 스위치 → API → 여기). 실제 바뀐 값 반환. */
export function setDanger(on: boolean): boolean {
  danger = on;
  return danger;
}
