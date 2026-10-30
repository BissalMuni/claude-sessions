// pptx 안에 포함된 영상 추출 — PDF 미리보기는 영상을 정지 포스터로만 보여주므로,
// 웹 뷰어가 PDF 아래에 슬라이드별 재생 가능한 <video> 를 붙일 수 있게
// zip(pptx) 에서 영상 파일을 꺼내 캐시 폴더에 풀어 준다.
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.data', 'preview-cache');

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

function cacheKey(absPath: string): string {
  const st = statSync(absPath);
  return createHash('sha1').update(`${absPath.toLowerCase()}|${st.mtimeMs}|${st.size}`).digest('hex');
}

/**
 * pptx 의 슬라이드별 영상을 캐시에 추출하고 목록을 돌려준다.
 * 캐시 적중이면 manifest 만 읽어 즉시 반환. 영상이 없으면 빈 배열.
 */
export function extractPptxVideos(absPath: string): { dir: string; videos: SlideVideo[] } {
  const key = cacheKey(absPath);
  const dir = join(CACHE_DIR, `media-${key}`);
  const manifest = join(dir, 'manifest.json');
  if (existsSync(manifest)) {
    return { dir, videos: JSON.parse(readFileSync(manifest, 'utf8')) as SlideVideo[] };
  }

  const zip = new AdmZip(absPath);
  const read = (entry: string): string | null => {
    const e = zip.getEntry(entry);
    return e ? e.getData().toString('utf8') : null;
  };

  // 슬라이드 순서: presentation.xml 의 sldIdLst(r:id 순) → presentation.xml.rels 로 파일명 해석
  const presRels = parseRels(read('ppt/_rels/presentation.xml.rels') ?? '');
  const relById = new Map(presRels.map((r) => [r.id, r.target]));
  const pres = read('ppt/presentation.xml') ?? '';
  const slideFiles: string[] = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
    const target = relById.get(m[1]);
    if (target) slideFiles.push(posix.normalize(posix.join('ppt', target)));
  }

  const videos: SlideVideo[] = [];
  mkdirSync(dir, { recursive: true });
  slideFiles.forEach((slidePath, i) => {
    const relsPath = posix.join(posix.dirname(slidePath), '_rels', posix.basename(slidePath) + '.rels');
    const rels = parseRels(read(relsPath) ?? '');
    const seen = new Set<string>(); // 같은 영상이 video+media 관계로 중복 참조되는 것 방지
    for (const r of rels) {
      if (!/\/(video|media)$/.test(r.type)) continue;
      const mediaEntry = posix.normalize(posix.join(posix.dirname(slidePath), r.target));
      if (!VIDEO_RE.test(mediaEntry) || seen.has(mediaEntry)) continue;
      seen.add(mediaEntry);
      const e = zip.getEntry(mediaEntry);
      if (!e) continue;
      const name = `s${i + 1}-${posix.basename(mediaEntry)}`;
      writeFileSync(join(dir, name), e.getData());
      videos.push({ slide: i + 1, name });
    }
  });

  writeFileSync(manifest, JSON.stringify(videos));
  return { dir, videos };
}
