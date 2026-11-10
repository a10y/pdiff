'use client';

// pdiff: replaced. The loader reads full files from the local repo.
import { type FileDiffContentsLoader } from '@pierre/diffs';
import { useMemo } from 'react';

import { createPdiffFileLoader } from '@/pdiff/fileLoader';

interface UseGitHubDiffFileLoaderOptions {
  domain?: string;
  hasGitHubToken: boolean;
  path: string;
  token: string;
  tokenVersion: number;
}

interface UseGitHubDiffFileLoaderResult {
  getGitHubToken(): string;
  loadDiffFiles: FileDiffContentsLoader | undefined;
}

let loadCounter = 0;
// Stable, so the patch loader's effect does not run again on each render.
const noToken = () => '';

export function useGitHubDiffFileLoader({
  path,
}: UseGitHubDiffFileLoaderOptions): UseGitHubDiffFileLoaderResult {
  const loadDiffFiles = useMemo(
    () => createPdiffFileLoader(path, ++loadCounter),
    [path]
  );
  return { getGitHubToken: noToken, loadDiffFiles };
}
