// 컴팩션 검증: (1) applyFlagSettings({autoCompactWindow}) 가 에러 없이 적용되는가,
// (2) 입력 스트림에 "/compact" 를 넣으면 compact_boundary(수동 컴팩션)가 발생하는가.
// 실행: pnpm tsx scripts/probe-compact.ts
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../src/asyncQueue.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const q = new AsyncQueue<SDKUserMessage>();

const run = query({
  prompt: q,
  options: {
    cwd: process.cwd(),
    settingSources: ['project'],
    permissionMode: 'bypassPermissions', // probe: 승인 게이트 없이 빠르게
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  },
});

function push(text: string) {
  q.push({ type: 'user', message: { role: 'user', content: text as never }, parent_tool_use_id: null });
}

let applied = false;
let sentCompact = false;
let resultsAfterCompact = 0;

(async () => {
  push('아주 짧게 "ok"라고만 답해줘.');
  for await (const msg of run) {
    const m = msg as Record<string, any>;
    const tag = `${m.type}${m.subtype ? '/' + m.subtype : ''}`;
    // /compact 이후 메시지는 내용을 상세히 덤프해 컴팩션 신호를 찾는다
    if (sentCompact) {
      let extra = '';
      if (m.compact_metadata) extra = ' compact_metadata=' + JSON.stringify(m.compact_metadata);
      else if (m.type === 'system') extra = ' ' + JSON.stringify(m).slice(0, 200);
      else if (m.type === 'assistant') extra = ' ' + JSON.stringify(m.message?.content)?.slice(0, 120);
      log('  [after /compact] ', tag, extra);
    } else {
      log('msg:', tag);
    }

    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      log('✅✅ compact_boundary 감지:', JSON.stringify(m.compact_metadata));
    }

    if (m.type === 'system' && m.subtype === 'init' && !applied) {
      applied = true;
      try {
        await (run as any).applyFlagSettings({ autoCompactEnabled: true, autoCompactWindow: 100_000 });
        log('✅ applyFlagSettings(autoCompactWindow=100000) 적용 성공');
      } catch (e) {
        log('❌ applyFlagSettings 실패:', e instanceof Error ? e.message : String(e));
      }
    }

    if (m.type === 'result') {
      if (!sentCompact) {
        sentCompact = true;
        log('→ /compact 1회 전송 (이후 신호 관찰)');
        push('/compact');
      } else if (++resultsAfterCompact >= 2) {
        log('=== /compact 이후 2 result 관찰 종료 ===');
        q.close();
        process.exit(0);
      }
    }
  }
})().catch((e) => { log('루프 에러:', e?.message || e); process.exit(1); });

setTimeout(() => { log('TIMEOUT(60s)'); process.exit(2); }, 60_000);
