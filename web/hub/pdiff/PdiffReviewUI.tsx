// pdiff's copy of components/ReviewUI.tsx. It keeps DiffsHub's layout
// (header, file tree sidebar, viewer) and adds what pdiff needs: a source
// picker, comments that persist and copy as an agent prompt, reload when the
// repo changes, key bindings, and settings saved by the server.

import type { CodeViewItem, DiffIndicators, FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import type { FileTreeRowDecoration, FileTreeRowDecorationContext } from '@pierre/trees';
import { type ColorMode } from '@pierre/theming';
import { useThemeController } from '@pierre/theming/react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { fetchFingerprint, getJSON, type Info, type Source, sameSource, type SourceInfo, sourceQuery } from './api';
import * as store from './comments';
import { setPref, pref } from './prefs';
import { SourcePicker } from './SourcePicker';
import { usePdiffKeys } from './usePdiffKeys';
import { CHROME_ICON_BUTTON_CLASS } from '@/components/chromeButtonStyles';
import { DiffsHubHeader } from '@/components/DiffsHubHeader';
import { DiffsHubSidebar } from '@/components/DiffsHubSidebar';
import { DiffsHubStatusPanel } from '@/components/DiffsHubStatusPanel';
import { DiffsHubViewer } from '@/components/DiffsHubViewer';
import { docsThemeCatalog, themeController } from '@/components/themeController';
import { ThemeSourceProvider } from '@/components/ThemeSourceProvider';
import { useGitHubDiffFileLoader } from '@/components/useGitHubDiffFileLoader';
import { useMediaQuery } from '@/components/useMediaQuery';
import { useOnValueChange } from '@/components/useOnValueChange';
import { usePatchLoader } from '@/components/usePatchLoader';
import { cn } from '@/lib/cn';
import { isSavedAnnotation } from '@/lib/isSavedAnnotation';
import type { DarkThemeName, LightThemeName } from '@/lib/themeNames';
import type {
  CommentMetadata,
  DiffsHubDeletedCommentEvent,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentEvent,
  DiffsHubSavedCommentItem,
} from '@/lib/types';
import { upsertSavedCommentSidebarEntry } from '@/lib/upsertSavedCommentSidebarEntry';

const MOBILE_MEDIA_QUERY = '(max-width: 767px)';
const ADD_COLOR = 'light-dark(#16a34a, #34d399)';
const DEL_COLOR = 'light-dark(#dc2626, #fb7185)';
const POLL_MS = 1500;

/** A setting saved in the prefs file. */
function usePref<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => pref(key, fallback));
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        setPref(key, next);
        return next;
      }),
    [key]
  );
  return [value, set];
}

interface PdiffReviewUIProps {
  initialInfo: Info;
}

export function PdiffReviewUI({ initialInfo }: PdiffReviewUIProps) {
  return (
    <ThemeSourceProvider controller={themeController}>
      <Inner initialInfo={initialInfo} />
    </ThemeSourceProvider>
  );
}

/** The diff items the viewer has, by file name, in diff order. */
interface LoadedFiles {
  byName: Map<string, { itemId: string; fileDiff: FileDiffMetadata }>;
  order: string[];
}

function Inner({ initialInfo }: PdiffReviewUIProps) {
  const [info, setInfo] = useState<Info>(initialInfo);
  const [source, setSourceState] = useState<Source>(initialInfo.initial);
  const [label, setLabel] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  // Display settings. The keys match the old UI, so existing prefs carry over.
  const [diffStyle, setDiffStyle] = usePref<'split' | 'unified'>('diffStyle', 'split');
  const [wrap, setWrap] = usePref<boolean>('wrap', false);
  const overflow = wrap ? 'wrap' : 'scroll';
  const setOverflow = useCallback(
    (v: 'wrap' | 'scroll' | ((p: 'wrap' | 'scroll') => 'wrap' | 'scroll')) =>
      setWrap((prev) => (typeof v === 'function' ? v(prev ? 'wrap' : 'scroll') : v) === 'wrap'),
    [setWrap]
  );
  const [showBackgrounds, setShowBackgrounds] = usePref('backgrounds', true);
  const [diffIndicators, setDiffIndicators] = usePref<DiffIndicators>('indicators', 'bars');
  const [lineNumbers, setLineNumbers] = usePref('lineNumbers', true);
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>('expanded');
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false);

  const path = sourceQuery(source);
  const { loadDiffFiles } = useGitHubDiffFileLoader({ path, hasGitHubToken: false, token: '', tokenVersion: 0 });

  const themeState = useThemeController(themeController);
  const colorMode: ColorMode = themeState.mode;
  const lightThemeName = themeState.lightThemeName ?? docsThemeCatalog.defaultLightThemeName;
  const darkThemeName = themeState.darkThemeName ?? docsThemeCatalog.defaultDarkThemeName;
  const setColorMode = useCallback((mode: ColorMode) => themeController.setColorMode(mode), []);
  const setLightThemeName = useCallback(
    (name: LightThemeName) => themeController.setThemeNameForScheme('light', name),
    []
  );
  const setDarkThemeName = useCallback(
    (name: DarkThemeName) => themeController.setThemeNameForScheme('dark', name),
    []
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CodeViewHandle<CommentMetadata, undefined> | null>(null);
  const createDraftRef = useRef<((range: import('@pierre/diffs').SelectedLineRange, itemId: string) => void) | null>(
    null
  );
  const loadedRef = useRef<LoadedFiles>({ byName: new Map(), order: [] });
  // Scroll position to restore after a reload of the same source.
  const pendingScrollRef = useRef<number | null>(null);

  const handlePatchLoadStart = useCallback(() => {
    setFileTreeOverlayOpen(false);
    loadedRef.current = { byName: new Map(), order: [] };
  }, []);

  // Attach saved comments to each new item before the viewer gets it.
  const decorateItem = useCallback((item: CodeViewItem<CommentMetadata>) => {
    if (item.type !== 'diff') return;
    const name = item.fileDiff.name;
    const loaded = loadedRef.current;
    if (!loaded.byName.has(name)) loaded.order.push(name);
    loaded.byName.set(name, { itemId: item.id, fileDiff: item.fileDiff });
    const saved = store.getComments().filter((c) => c.file === name);
    if (saved.length === 0) return;
    const others = (item.annotations ?? []).filter((a) => !isSavedAnnotation(a));
    item.annotations = [...others, ...saved.map(store.toAnnotation)];
  }, []);

  const {
    applyCollapseModeToLoaded,
    commentFileByItemId,
    commentSections,
    diffStats,
    errorMessage,
    initialItems,
    loadState,
    onLineLinkChange,
    onViewerReady,
    retryLoad,
    setCommentSections,
    treeSource,
    viewerKey,
  } = usePatchLoader({
    collapseMode,
    decorateItem,
    onLoadStart: handlePatchLoadStart,
    path,
    viewerRef,
  });

  // --- Source, label, and reloads -----------------------------------------

  useEffect(() => {
    let live = true;
    getJSON<SourceInfo>(`api/source-info?${path}`)
      .then((s) => {
        if (!live) return;
        setLabel(s.label);
        store.setLabel(s.label);
        document.title = `pdiff · ${info.repo} · ${s.label}`;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path, info.repo]);

  const setSource = useCallback((s: Source) => {
    setPickerOpen(false);
    setSourceState((prev) => (sameSource(prev, s) ? prev : s));
  }, []);

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await getJSON<Info>('api/info'));
    } catch {
      // Keep the old info.
    }
  }, []);

  /** Load the same source again and keep the scroll position. */
  const reload = useCallback(() => {
    const top = viewerRef.current?.getInstance()?.getScrollTop();
    pendingScrollRef.current = top ?? null;
    void refreshInfo();
    retryLoad();
  }, [refreshInfo, retryLoad]);

  useEffect(() => {
    if (loadState !== 'ready' || pendingScrollRef.current == null) return;
    const position = pendingScrollRef.current;
    pendingScrollRef.current = null;
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: 'position', position, behavior: 'instant' } as never);
    });
  }, [loadState, viewerKey]);

  // Watch the repo and reload when the diff may have changed.
  useEffect(() => {
    let live = true;
    let last = '';
    let timer = 0;
    const tick = async () => {
      const fp = await fetchFingerprint(source);
      if (!live) return;
      if (fp && last && fp !== last) {
        reload();
        toast('Updated from disk');
      }
      if (fp) last = fp;
      timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, reload]);

  // Per-file "+N −M" in the tree, like pdiff's first UI. The tree calls this
  // when it draws a row; it reads the items loaded so far.
  const renderRowDecoration = useCallback((ctx: FileTreeRowDecorationContext): FileTreeRowDecoration | null => {
    if (ctx.item.kind !== 'file') return null;
    const f = loadedRef.current.byName.get(ctx.item.path);
    if (f == null) return null;
    let add = 0;
    let del = 0;
    for (const h of f.fileDiff.hunks) {
      add += h.additionLines;
      del += h.deletionLines;
    }
    const parts = [];
    if (add > 0) parts.push({ text: `+${add}`, color: ADD_COLOR });
    if (del > 0) parts.push({ text: `${add > 0 ? '\u00a0' : ''}−${del}`, color: DEL_COLOR });
    if (parts.length === 0) return null;
    return { text: parts.map((p) => p.text).join(''), parts, title: `${add} added, ${del} deleted` };
  }, []);

  // --- Comments --------------------------------------------------------------

  const comments = useSyncExternalStore(store.subscribe, store.getComments);

  // The sidebar list: saved comments on files in this diff, in diff order.
  useEffect(() => {
    if (commentFileByItemId == null) return;
    let sections: DiffsHubSavedCommentItem[] = [];
    for (const c of comments) {
      const f = loadedRef.current.byName.get(c.file);
      if (f == null) continue;
      sections = upsertSavedCommentSidebarEntry(sections, commentFileByItemId, store.toSidebarEvent(c, f.itemId, f.fileDiff));
    }
    setCommentSections(sections);
  }, [comments, commentFileByItemId, setCommentSections]);

  const handleCommentSaved = useCallback((e: DiffsHubSavedCommentEvent) => {
    const item = viewerRef.current?.getItem(e.itemId);
    if (item == null || item.type !== 'diff') return;
    store.saveComment(store.fromSavedEvent(e, item.fileDiff));
  }, []);

  const handleCommentDeleted = useCallback((e: DiffsHubDeletedCommentEvent) => {
    store.deleteComment(e.key);
  }, []);

  const copyComments = useCallback(async () => {
    const n = store.getComments().length;
    if (n === 0) {
      toast('No comments yet. Click a line number, or select lines and press m.');
      return;
    }
    const r = await fetch('api/comments/copy');
    if (r.ok) toast.success(`Copied ${n} comment${n === 1 ? '' : 's'}. Paste them into your agent.`);
    else toast.error(`Copy failed: ${await r.text()}`);
  }, []);

  const commentOnSelection = useCallback(() => {
    const sel = viewerRef.current?.getSelectedLines();
    if (sel == null) {
      toast('Select lines first: click or drag line numbers.');
      return;
    }
    createDraftRef.current?.(sel.range, sel.id);
  }, []);

  // --- Layout ------------------------------------------------------------------

  const isMobileViewport = useMediaQuery(MOBILE_MEDIA_QUERY, undefined);
  useOnValueChange(
    isMobileViewport,
    (isMobile) => {
      if (isMobile === false) setFileTreeOverlayOpen(false);
    },
    undefined
  );
  // A narrow terminal has no room for split view.
  const effectiveDiffStyle = isMobileViewport === true ? 'unified' : diffStyle;

  const scrollToItem = useCallback((itemId: string) => {
    const viewer = viewerRef.current;
    if (viewer == null) return;
    const item = viewer.getItem(itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = typeof item.version === 'number' ? item.version + 1 : 1;
      viewer.updateItem(item);
    }
    viewer.scrollTo({ type: 'item', id: itemId, align: 'start', behavior: 'instant' } as never);
  }, []);

  const handleSelectTreeItem = useCallback(
    (itemId: string) => {
      setFileTreeOverlayOpen(false);
      scrollToItem(itemId);
    },
    [scrollToItem]
  );

  const toggleCollapseMode = useCallback(() => {
    const next = collapseMode === 'expanded' ? 'collapsed' : 'expanded';
    setCollapseMode(next);
    applyCollapseModeToLoaded(next);
  }, [applyCollapseModeToLoaded, collapseMode]);

  const handleSelectComment = useCallback((comment: DiffsHubSavedCommentEntry) => {
    setFileTreeOverlayOpen(false);
    viewerRef.current?.setSelectedLines({ id: comment.itemId, range: comment.range });
    viewerRef.current?.scrollTo({
      type: 'line',
      id: comment.itemId,
      lineNumber: comment.range.end,
      side: comment.range.endSide ?? comment.range.side,
      align: 'center',
      behavior: 'instant',
    } as never);
  }, []);

  usePdiffKeys({
    viewerRef,
    scrollRef,
    loadedRef,
    defaultBase: info.defaultBase,
    disabled: pickerOpen,
    openPicker: () => setPickerOpen(true),
    setSource,
    toggleDiffStyle: () => setDiffStyle((s) => (s === 'split' ? 'unified' : 'split')),
    toggleWrap: () => setWrap((w) => !w),
    toggleTheme: () =>
      setColorMode(themeController.getState().resolvedColorScheme === 'dark' ? 'light' : 'dark'),
    reload: () => {
      reload();
      toast('Reloaded');
    },
    toggleCollapseAll: toggleCollapseMode,
    scrollToItem,
    commentOnSelection,
    copyComments,
  });

  const viewerAvailable = loadState === 'ready' || (loadState === 'streaming' && initialItems.length > 0);
  const nComments = comments.length;

  return (
    <ReviewGrid>
      <DiffsHubHeader
        className="[grid-area:header]"
        leading={
          <>
            <span className="hidden shrink-0 text-[13px] font-medium md:inline">
              {info.repo} <span className="text-muted-foreground">/</span> {info.branch}
            </span>
            <SourcePicker
              info={info}
              source={source}
              label={label}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onSelect={setSource}
            />
          </>
        }
        trailing={
          nComments > 0 ? (
            <button
              type="button"
              title="Copy all comments as a prompt for your agent (y)"
              onClick={() => void copyComments()}
              className={cn(
                CHROME_ICON_BUTTON_CLASS,
                'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-blue-500 px-2.5 text-[12px] font-medium text-white hover:bg-blue-600'
              )}
            >
              <span className="rounded bg-white/20 px-1 font-mono text-[11px]">{nComments}</span>
              Copy for agent
            </button>
          ) : null
        }
        collapseMode={collapseMode}
        colorMode={colorMode}
        darkThemeName={darkThemeName}
        diffIndicators={diffIndicators}
        diffStyle={effectiveDiffStyle}
        initialUrl={label}
        lightThemeName={lightThemeName}
        lineNumbers={lineNumbers}
        overflow={overflow}
        fileTreeOverlayOpen={fileTreeOverlayOpen}
        fileTreeAvailable={treeSource != null}
        githubTokenActive={false}
        onClearGitHubToken={noop}
        onSaveGitHubToken={noop}
        onToggleCollapseMode={toggleCollapseMode}
        onToggleFileTreeOverlay={() => setFileTreeOverlayOpen((o) => !o)}
        setColorMode={setColorMode}
        setDarkThemeName={setDarkThemeName}
        setDiffIndicators={setDiffIndicators as never}
        setDiffStyle={setDiffStyle as never}
        setLightThemeName={setLightThemeName}
        setLineNumbers={setLineNumbers as never}
        setOverflow={setOverflow as never}
        setShowBackgrounds={setShowBackgrounds as never}
        showBackgrounds={showBackgrounds}
      />
      {viewerAvailable && treeSource != null ? (
        <>
          <DiffsHubSidebar
            className="[grid-area:viewer] md:[grid-area:tree]"
            commentSections={commentSections}
            diffStats={diffStats}
            mobileOverlayOpen={fileTreeOverlayOpen}
            onMobileClose={() => setFileTreeOverlayOpen(false)}
            onSelectComment={handleSelectComment}
            scrollRef={scrollRef}
            source={treeSource}
            streaming={loadState === 'streaming'}
            onSelectItem={handleSelectTreeItem}
            renderRowDecoration={renderRowDecoration}
          />
          <DiffsHubViewer
            key={viewerKey}
            className="[grid-area:viewer]"
            diffStyle={effectiveDiffStyle}
            overflow={overflow}
            showBackgrounds={showBackgrounds}
            diffIndicators={diffIndicators}
            lineNumbers={lineNumbers}
            scrollRef={scrollRef}
            themeType={colorMode}
            viewerRef={viewerRef}
            initialItems={initialItems}
            loadDiffFiles={loadDiffFiles}
            onCommentDeleted={handleCommentDeleted}
            onCommentSaved={handleCommentSaved}
            onLineLinkChange={onLineLinkChange}
            onViewerReady={onViewerReady}
            createDraftRef={createDraftRef}
          />
        </>
      ) : (
        <DiffsHubStatusPanel errorMessage={errorMessage} onRetry={retryLoad} state={loadState} />
      )}
    </ReviewGrid>
  );
}

function noop() {}

function ReviewGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer'] md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']">
      {children}
    </div>
  );
}
