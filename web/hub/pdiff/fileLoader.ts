// pdiff: loads full old/new file contents from the local repo, so DiffsHub
// can expand collapsed context. Replaces lib/githubDiffFileLoader.ts.
import type { FileDiffContentsLoader, FileDiffLoadedFiles } from '@pierre/diffs';

async function fetchText(sourceQuery: string, side: 'old' | 'new', path: string): Promise<string> {
  const q = new URLSearchParams(sourceQuery);
  q.set('side', side);
  q.set('path', path);
  const r = await fetch(`api/source-file?${q}`);
  return r.ok ? r.text() : '';
}

/** `sourceQuery` is the pdiff source (mode/base/range) as a query string. */
export function createPdiffFileLoader(sourceQuery: string, loadId: number): FileDiffContentsLoader {
  const cache = new Map<string, Promise<FileDiffLoadedFiles>>();
  return (fd) => {
    const oldName = fd.prevName ?? fd.name;
    const key = `${fd.type}\0${oldName}\0${fd.name}`;
    let p = cache.get(key);
    if (p == null) {
      p = Promise.all([
        fd.type === 'new' ? '' : fetchText(sourceQuery, 'old', oldName),
        fd.type === 'deleted' ? '' : fetchText(sourceQuery, 'new', fd.name),
      ]).then(([oldText, newText]) => ({
        oldFile: { name: oldName, contents: oldText, cacheKey: `old:${oldName}#${loadId}` },
        newFile: { name: fd.name, contents: newText, cacheKey: `new:${fd.name}#${loadId}` },
      }));
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
}
