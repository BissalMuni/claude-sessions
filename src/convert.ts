// 오피스 문서 → PDF 변환 (LibreOffice headless) + 캐시.
// 웹 파일 뷰어가 pptx/docx/xlsx 를 미리보기할 때 사용한다. 변환 결과는
// .data/preview-cache/ 에 "경로+수정시각" 해시로 캐시되어 재변환을 피한다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 미리보기 캐시 폴더 — PDF(<key>.pdf) 와 pptx 영상(media-<key>/) 이 함께 산다 */
export const CACHE_DIR = join(__dirname, '..', '.data', 'preview-cache');
// soffice 전용 사용자 프로필. 기본 프로필을 쓰면 사용자가 LibreOffice 를 켜 둔 상태에서
// 변환 요청이 그 인스턴스로 넘어가거나 프로필 잠금에 막혀 PDF 가 안 나온다.
const PROFILE_URL = pathToFileURL(join(__dirname, '..', '.data', 'soffice-profile')).href;

/** LibreOffice 로 PDF 변환 가능한 확장자 (웹 뷰어의 OFFICE_EXT 와 짝) */
export const CONVERTIBLE_EXT = new Set([
  'pptx', 'ppt', 'odp',
  'docx', 'doc', 'odt', 'rtf',
  'xlsx', 'xls', 'ods', 'csv' /* csv 는 텍스트 뷰어가 우선이지만 혹시 몰라 허용 */,
]);

/**
 * soffice 경로 탐색 — 설치 직후에도 PATH 갱신 없이 찾도록 고정 경로 우선.
 * 매번 다시 찾는다(existsSync 2회 — 저렴): 서버 실행 중 설치해도 재시작 없이 인식된다.
 * 반드시 .com(콘솔 래퍼)을 쓴다: .exe 는 즉시 분리(detach)되어 변환 완료를 기다릴 수 없다.
 */
export function findSoffice(): string | null {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 동시 변환 직렬화 — soffice 는 동시 기동에 취약해서 한 번에 하나만 돌린다 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** 캐시 키 = 경로+수정시각+크기 해시. 파일이 바뀌면 키가 바뀌어 자연히 재생성된다. */
export function cacheKey(absPath: string): string {
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
          [
            `-env:UserInstallation=${PROFILE_URL}`,
            '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, absPath,
          ],
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

/** 폴더 전체 크기(재귀) */
function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/**
 * 캐시 청소 — 500MB 초과 시 오래된 것부터 삭제 (서버 부팅 때 한 번 호출).
 * PDF 뿐 아니라 pptx 영상 폴더(media-*)도 센다 — 대개 이쪽이 가장 크다.
 * 부팅 시점엔 변환이 돌지 않으므로 남은 작업 임시 폴더(job-*)는 무조건 지운다.
 */
export function pruneCache(maxBytes = 500 * 1024 * 1024): void {
  if (!existsSync(CACHE_DIR)) return;
  try {
    const files: Array<{ p: string; size: number; atime: number }> = [];
    for (const e of readdirSync(CACHE_DIR, { withFileTypes: true })) {
      const p = join(CACHE_DIR, e.name);
      if (e.isDirectory() && e.name.startsWith('job-')) {
        rmSync(p, { recursive: true, force: true });
      } else if (e.isDirectory() && e.name.startsWith('media-')) {
        files.push({ p, size: dirSize(p), atime: statSync(p).atimeMs });
      } else if (e.isFile() && e.name.endsWith('.pdf')) {
        const st = statSync(p);
        files.push({ p, size: st.size, atime: st.atimeMs });
      }
    }
    files.sort((a, b) => a.atime - b.atime);
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= maxBytes) break;
      rmSync(f.p, { recursive: true, force: true });
      total -= f.size;
    }
  } catch {
    /* 청소 실패는 치명적이지 않음 */
  }
}
