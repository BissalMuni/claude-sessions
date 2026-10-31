// pptx 안에 포함된 영상 추출 — PDF 미리보기는 영상을 정지 포스터로만 보여주므로,
// 웹 뷰어가 PDF 아래에 슬라이드별 재생 가능한 <video> 를 붙일 수 있게
// zip(pptx) 에서 영상 파일을 꺼내 캐시 폴더에 풀어 준다.
import AdmZip from 'adm-zip';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { CACHE_DIR, cacheKey } from './convert.js';

const VIDEO_RE = /\.(mp4|m4v|webm|mov)$/i;

export interface SlideVideo {
  slide: number; // 1-기반 슬라이드 번호 (표시 순서)
  name: string; // 캐시 폴더 안 파일명 (s3-media1.mp4 식)
}

/** <Relationship …/> 태그에서 속성 추출 (속성 순서 무관) */
function parseRels(xml: string): Array<{ id: string; type: string; target: string }> {
  const out: Array<{ id: string; type: string; target: string }> = [];
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const attr = (n: string) => tag.match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? '';
    out.push({ id: attr('Id'), type: attr('Type'), target: attr('Target') });
  }
  return out;
}

/** entry.getData 의 비동기판 (압축 해제를 이벤트 루프 밖에서) */
function entryData(e: AdmZip.IZipEntry): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    e.getDataAsync((data, err) => (err ? rejectP(new Error(err)) : resolveP(data)));
  });
}

// 같은 파일 동시 추출 방지 — 목록 요청과 영상 Range 요청이 캐시 미스에 겹치면 한 번만 푼다.
const inflight = new Map<string, Promise<{ dir: string; videos: SlideVideo[] }>>();

/**
 * pptx 의 슬라이드별 영상을 캐시에 추출하고 목록을 돌려준다.
 * 캐시 적중이면 manifest 만 읽어 즉시 반환. 영상이 없으면 빈 배열.
 * 전부 비동기 — 큰 pptx 추출 중에도 다른 세션의 SDK 읽기 루프/WS 가 멈추지 않는다.
 */
export function extractPptxVideos(absPath: string): Promise<{ dir: string; videos: SlideVideo[] }> {
  const key = cacheKey(absPath);
  const running = inflight.get(key);
  if (running) return running;
  const job = extract(absPath, key).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function extract(absPath: string, key: string): Promise<{ dir: string; videos: SlideVideo[] }> {
  const dir = join(CACHE_DIR, `media-${key}`);
  const manifest = join(dir, 'manifest.json');
  if (existsSync(manifest)) {
    return { dir, videos: JSON.parse(await readFile(manifest, 'utf8')) as SlideVideo[] };
  }

  const zip = new AdmZip(await readFile(absPath));
  const read = async (entry: string): Promise<string> => {
    const e = zip.getEntry(entry);
    return e ? (await entryData(e)).toString('utf8') : '';
  };

  // 슬라이드 순서: presentation.xml 의 sldIdLst(r:id 순) → presentation.xml.rels 로 파일명 해석
  const presRels = parseRels(await read('ppt/_rels/presentation.xml.rels'));
  const relById = new Map(presRels.map((r) => [r.id, r.target]));
  const pres = await read('ppt/presentation.xml');
  const slideFiles: string[] = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
    const target = relById.get(m[1]);
    if (target) slideFiles.push(posix.normalize(posix.join('ppt', target)));
  }

  const videos: SlideVideo[] = [];
  await mkdir(dir, { recursive: true });
  for (const [i, slidePath] of slideFiles.entries()) {
    const relsPath = posix.join(posix.dirname(slidePath), '_rels', posix.basename(slidePath) + '.rels');
    const rels = parseRels(await read(relsPath));
    const seen = new Set<string>(); // 같은 영상이 video+media 관계로 중복 참조되는 것 방지
    for (const r of rels) {
      if (!/\/(video|media)$/.test(r.type)) continue;
      const mediaEntry = posix.normalize(posix.join(posix.dirname(slidePath), r.target));
      if (!VIDEO_RE.test(mediaEntry) || seen.has(mediaEntry)) continue;
      seen.add(mediaEntry);
      const e = zip.getEntry(mediaEntry);
      if (!e) continue;
      // zip-slip 차단: Target 에 역슬래시 경로가 섞여도 캐시 폴더 밖으로 못 나가게
      // 파일명을 안전 문자만 남긴다(/preview-media/file 의 name 검사 규칙과 같은 문자 집합).
      const base = mediaEntry.split(/[\\/]/).pop()!.replace(/[^\w.-]/g, '_');
      const name = `s${i + 1}-${base}`;
      await writeFile(join(dir, name), await entryData(e));
      videos.push({ slide: i + 1, name });
    }
  }

  // manifest 는 마지막에 쓴다 — 중간에 죽으면 다음 요청이 처음부터 다시 푼다
  await writeFile(manifest, JSON.stringify(videos));
  return { dir, videos };
}
