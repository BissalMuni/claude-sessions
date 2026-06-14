// 폰에서 올린 임의 파일을 세션 작업폴더(cwd)의 .uploads/ 에 저장한다.
// base64 를 모델 컨텍스트에 욱여넣지 않고, Claude 가 자기 도구(Read 등)로
// 디스크에서 읽게 한다 → 모든 형식 지원 + 컨텍스트 안전.

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { InputFile } from './types.js';

const UPLOAD_SUBDIR = '.uploads';

export interface SavedUpload {
  name: string; // 저장된 안전한 파일명
  relPath: string; // cwd 기준 상대경로 (Claude 에게 전달)
  bytes: number;
}

/** 업로드 파일들을 cwd/.uploads/ 에 저장하고 저장 정보를 돌려준다. */
export function saveUploads(cwd: string, files: InputFile[]): SavedUpload[] {
  if (files.length === 0) return [];
  const dir = join(cwd, UPLOAD_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const out: SavedUpload[] = [];
  const used = new Set<string>();
  for (const f of files) {
    const safe = uniqueName(safeName(f.name), used);
    used.add(safe);
    const buf = Buffer.from(f.data, 'base64');
    writeFileSync(join(dir, safe), buf);
    out.push({ name: safe, relPath: `./${UPLOAD_SUBDIR}/${safe}`, bytes: buf.length });
  }
  return out;
}

/** 경로 traversal 방지: 디렉터리 성분 제거 + 위험문자 정리 + 선행 점 제거 */
function safeName(name: string): string {
  const base = basename(String(name || 'file')).replace(/[\\/]/g, '_');
  const cleaned = base
    .replace(/[^\w.\-가-힣() ]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || 'file';
}

/** 같은 요청 안에서 이름 충돌 시 -1, -2 … 를 붙인다 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 1;
  while (used.has(`${stem}-${i}${ext}`)) i++;
  return `${stem}-${i}${ext}`;
}
