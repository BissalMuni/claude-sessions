// 오피스 문서 → PDF 변환 (LibreOffice headless) + 캐시.
// 웹 파일 뷰어가 pptx/docx/xlsx 를 미리보기할 때 사용한다. 변환 결과는
// .data/preview-cache/ 에 "경로+수정시각" 해시로 캐시되어 재변환을 피한다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.data', 'preview-cache');

/** LibreOffice 로 PDF 변환 가능한 확장자 (웹 뷰어의 OFFICE_EXT 와 짝) */
export const CONVERTIBLE_EXT = new Set([
  'pptx', 'ppt', 'odp',
  'docx', 'doc', 'odt', 'rtf',
  'xlsx', 'xls', 'ods', 'csv' /* csv 는 텍스트 뷰어가 우선이지만 혹시 몰라 허용 */,
]);

/**
 * soffice 경로 탐색 — 설치 직후에도 PATH 갱신 없이 찾도록 고정 경로 우선.
 * 반드시 .com(콘솔 래퍼)을 쓴다: .exe 는 즉시 분리(detach)되어 변환 완료를 기다릴 수 없다.
 */
let sofficeCache: string | null | undefined;
export function findSoffice(): string | null {
  if (sofficeCache !== undefined) return sofficeCache;
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
  ];
  sofficeCache = candidates.find((p) => existsSync(p)) ?? null;
  return sofficeCache;
}
/** 설치 직후 재탐색용 (캐시 무효화) */
export function resetSofficeCache(): void {
  sofficeCache = undefined;
}

/** 동시 변환 직렬화 — soffice 는 동시 기동에 취약해서 한 번에 하나만 돌린다 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

function cacheKey(absPath: string): string {
  const st = statSync(absPath);
  return createHash('sha1').update(`${absPath.toLowerCase()}|${st.mtimeMs}|${st.size}`).digest('hex');
}

/**
 * 문서를 PDF 로 변환해 캐시된 PDF 절대경로를 돌려준다.
 * 캐시 적중이면 즉시, 아니면 soffice 실행(수 초). 실패 시 throw.
 */
export async function toPdf(absPath: string): Promise<string> {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice(soffice.com)가 설치되어 있지 않습니다');

  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(absPath);
  const cached = join(CACHE_DIR, `${key}.pdf`);
  if (existsSync(cached)) return cached;

  return enqueue(async () => {
    if (existsSync(cached)) return cached; // 대기 중 다른 요청이 만들었을 수 있음
    // soffice 는 출력 파일명을 "<원본이름>.pdf" 로 고정하므로 작업별 임시 폴더에 변환 후 캐시명으로 이동
    const tmp = join(CACHE_DIR, `job-${key}`);
    mkdirSync(tmp, { recursive: true });
    try {
      await new Promise<void>((resolveP, rejectP) => {
        execFile(
          soffice,
          ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, absPath],
          { timeout: 120_000, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) rejectP(new Error(`변환 실패: ${stderr || err.message}`));
            else resolveP();
          },
        );
      });
      const produced = readdirSync(tmp).find((f) => f.toLowerCase().endsWith('.pdf'));
      if (!produced) throw new Error(`변환 결과 PDF 없음 (${basename(absPath)})`);
      renameSync(join(tmp, produced), cached);
      return cached;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

/** 캐시 청소 — 500MB 초과 시 오래된 것부터 삭제 (서버 부팅 때 한 번 호출) */
export function pruneCache(maxBytes = 500 * 1024 * 1024): void {
  if (!existsSync(CACHE_DIR)) return;
  try {
    const files = readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => {
        const p = join(CACHE_DIR, f);
        const st = statSync(p);
        return { p, size: st.size, atime: st.atimeMs };
      })
      .sort((a, b) => a.atime - b.atime);
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= maxBytes) break;
      rmSync(f.p, { force: true });
      total -= f.size;
    }
  } catch {
    /* 청소 실패는 치명적이지 않음 */
  }
}
