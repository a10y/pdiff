// Types and calls for the pdiff server (src/server.rs, src/git.rs).

export type Mode = 'unstaged' | 'staged' | 'uncommitted' | 'base' | 'range';

export interface Source {
  mode: Mode;
  base?: string;
  range?: string;
}

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

export interface Info {
  repo: string;
  branch: string;
  head: string;
  defaultBase: string | null;
  branches: string[];
  commits: Commit[];
  counts: { unstaged: number; staged: number; uncommitted: number };
  initial: Source;
}

export interface SourceInfo {
  label: string;
  error?: string;
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export function sourceQuery(s: Source): string {
  const q = new URLSearchParams({ mode: s.mode });
  if (s.base) q.set('base', s.base);
  if (s.range) q.set('range', s.range);
  return q.toString();
}

export function sameSource(a: Source, b: Source): boolean {
  return sourceQuery(a) === sourceQuery(b);
}

export async function fetchFingerprint(src: Source): Promise<string> {
  try {
    const r = await fetch(`api/fingerprint?${sourceQuery(src)}`);
    return r.ok ? await r.text() : '';
  } catch {
    return '';
  }
}

export function quit(): void {
  fetch('api/quit').catch(() => {});
}
