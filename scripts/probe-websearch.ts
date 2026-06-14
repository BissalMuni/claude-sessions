// WebSearch 동작 재현 probe.
// 실행: pnpm tsx scripts/probe-websearch.ts
// 목적: WebSearch 도구가 허가(canUseTool=allow) 후 실제로 완료되는지,
//       아니면 턴이 멈추는지(=서버 화면의 "정지") 콘솔 로그로 확인한다.

import { query } from '@anthropic-ai/claude-agent-sdk';

const abort = new AbortController();
// 40초 안에 result 가 안 오면 "멈춤"으로 간주하고 중단
const timer = setTimeout(() => {
  console.log('\n⏱  40초 동안 result 없음 → 턴이 멈춘 것으로 보임. abort.');
  abort.abort();
}, 40_000);

const run = query({
  prompt:
    'Use the WebSearch tool to find what day of the week 2026-06-06 is, then answer in one short sentence.',
  options: {
    cwd: process.cwd(),
    abortController: abort,
    settingSources: ['project'],
    permissionMode: 'default',
    canUseTool: async (toolName, input) => {
      console.log(`\n🔐 canUseTool 호출: ${toolName}`);
      console.log('   input =', JSON.stringify(input).slice(0, 300));
      console.log('   → allow 반환');
      return { behavior: 'allow', updatedInput: input };
    },
  },
});

(async () => {
  try {
    for await (const msg of run) {
      const m = msg as Record<string, any>;
      if (m.type === 'assistant') {
        const blocks = (m.message?.content ?? []) as Array<Record<string, any>>;
        for (const b of blocks) {
          // 블록 타입을 전부 찍는다 (server_tool_use / web_search_tool_result 등장 여부 확인)
          console.log(`📦 assistant block: ${b.type}` + (b.name ? ` (${b.name})` : ''));
          if (b.type === 'text') console.log('   text:', String(b.text).slice(0, 200));
        }
      } else if (m.type === 'result') {
        console.log(`\n✅ result: subtype=${m.subtype}`);
        if (m.usage?.server_tool_use) {
          console.log('   server_tool_use usage =', JSON.stringify(m.usage.server_tool_use));
        }
        break;
      } else {
        console.log(`· ${m.type}${m.subtype ? '/' + m.subtype : ''}`);
      }
    }
    console.log('\n루프 정상 종료.');
  } catch (err) {
    console.log('\n❌ 에러:', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
})();
