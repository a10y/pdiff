// pdiff entry for the DiffsHub UI. Replaces Next.js's app/layout.tsx and
// app/[...path]/page.tsx: it renders the same providers and <ReviewUI>, with
// the diff coming from the local repo instead of GitHub.
import { createRoot } from 'react-dom/client';

import '@/components/themeController';
import { PreloadHighlighter } from '@/components/PreloadHighlighter';
import { ScrollbarGutterVariables } from '@/components/ScrollbarGutterVariables';
import { ThemeProvider } from '@/components/ThemeProvider';
import { themeController } from '@/components/themeController';
import { Toaster } from '@/components/Toaster';
import { WorkerPoolProvider } from '@/components/WorkerPoolProvider';
import { getJSON, type Info } from '@/pdiff/api';
import { loadComments } from '@/pdiff/comments';
import { PdiffReviewUI } from '@/pdiff/PdiffReviewUI';
import { installSvgColorFix, refreshSvgColors } from '@/pdiff/svgColorFix';

// The page cannot set prefers-color-scheme in Servo. Tell pdiff the resolved
// scheme, so CSS light-dark() and `system` mode follow the chosen theme.
let lastScheme: string | undefined;
function syncEmbedderTheme() {
  const scheme = themeController.getState().resolvedColorScheme;
  if (scheme != null && scheme !== lastScheme) {
    lastScheme = scheme;
    fetch(`api/theme?t=${scheme}`).catch(() => {});
  }
}

async function main() {
  installSvgColorFix();
  const [info] = await Promise.all([getJSON<Info>('api/info'), loadComments()]);
  document.title = `pdiff · ${info.repo}`;
  syncEmbedderTheme();
  themeController.subscribe(syncEmbedderTheme);
  // Colours come from CSS variables; Servo needs them written into the SVGs.
  themeController.subscribe(() => requestAnimationFrame(refreshSvgColors));

  createRoot(document.getElementById('root')!).render(
    <>
      <ScrollbarGutterVariables />
      <WorkerPoolProvider>
        <ThemeProvider attribute="class">
          <div className="flex h-dvh flex-col gap-2">
            <PdiffReviewUI initialInfo={info} />
          </div>
          <Toaster />
          <div id="dark-mode-portal-container" className="dark" data-theme="dark"></div>
          <div id="light-mode-portal-container" className="light" data-theme="light"></div>
        </ThemeProvider>
      </WorkerPoolProvider>
      <PreloadHighlighter />
    </>
  );
}

main().catch((e) => console.error(e));
