import { randomUUID } from 'node:crypto';

/** 짧은 식별자 (세션/요청/스트림 아이템용) */
export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
