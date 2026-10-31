import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionVisibleTo, type Account } from './auth.js';
import { offendingToolPath } from './toolGuard.js';

const acc = (root: string | null): Account => ({ username: 'u', token: 'u:p', root, label: 'u', id: 'x' });

describe('sessionVisibleTo', () => {
  it('무제한 계정은 전부 본다', () => {
    expect(sessionVisibleTo({ cwd: 'C:\\a', root: null }, acc(null))).toBe(true);
  });
  it('같은 root 세션은 보인다(협업)', () => {
    expect(sessionVisibleTo({ cwd: 'C:\\work\\shared\\p', root: 'C:\\work\\shared' }, acc('C:\\work\\shared'))).toBe(true);
  });
  it('무제한(root=null) 세션은 cwd 가 안이어도 숨긴다', () => {
    expect(sessionVisibleTo({ cwd: 'C:\\work\\shared', root: null }, acc('C:\\work\\shared'))).toBe(false);
  });
  it('더 넓은 root 세션은 숨긴다', () => {
    expect(sessionVisibleTo({ cwd: 'C:\\a\\b\\c', root: 'C:\\a' }, acc('C:\\a\\b'))).toBe(false);
  });
});

describe('offendingToolPath allowlist', () => {
  const cwd = 'C:\\work\\shared\\p';
  const root = 'C:\\work\\shared';
  it('이 세션 프로젝트의 temp/claude 슬러그 폴더는 허용', () => {
    const p = join(tmpdir(), 'claude', 'C--work-shared-p', 'sess', 'tasks', 'x.output');
    expect(offendingToolPath('Read', { file_path: p }, root, cwd)).toBeNull();
  });
  it('다른 프로젝트의 temp/claude 폴더는 차단', () => {
    const p = join(tmpdir(), 'claude', 'C--Users-owner-secret', 'sess', 'x.output');
    expect(offendingToolPath('Read', { file_path: p }, root, cwd)).toBe(p);
  });
});
