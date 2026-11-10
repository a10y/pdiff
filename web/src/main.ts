import {
  CodeView,
  parsePatchFiles,
  type CodeViewDiffItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
  type FileDiffLoadedFiles,
} from '@pierre/diffs';

// ---------------------------------------------------------------------------
// Types shared with the Rust server (src/server.rs)
// ---------------------------------------------------------------------------

type Mode = 'unstaged' | 'staged' | 'uncommitted' | 'base' | 'range';

interface Source {
  mode: Mode;
  base?: string;
  range?: string;
}

interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

interface Info {
  repo: string;
  branch: string;
  head: string;
  defaultBase: string | null;
  branches: string[];
  commits: Commit[];
  counts: { unstaged: number; staged: number; uncommitted: number };
  initial: Source;
}

interface DiffResponse {
  patch: string;
  oldRev: string;
  newRev: string;
  label: string;
  error?: string;
}

type Side = 'additions' | 'deletions';

/** A review comment on one or more lines. Matches `Comment` in src/review.rs. */
interface ReviewComment {
  id: string;
  file: string;
  side: Side;
  start: number;
  end: number;
  body: string;
  snippet: string[];
}

/** A comment being written or edited. `editing` is the id of the comment it replaces. */
interface Draft extends ReviewComment {
  editing?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
  return r.json();
}

function sourceQuery(s: Source): string {
  const q = new URLSearchParams({ mode: s.mode });
  if (s.base) q.set('base', s.base);
  if (s.range) q.set('range', s.range);
  return q.toString();
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), 2200);
}

/** Settings saved by the server in ~/.config/pdiff/prefs.json (see loadPrefs). */
let prefs: Record<string, unknown> = {};

async function loadPrefs() {
  try {
    prefs = await getJSON<Record<string, unknown>>('api/prefs');
  } catch {
    prefs = {};
  }
}

function store<T>(key: string, fallback: T): T {
  return key in prefs ? (prefs[key] as T) : fallback;
}

function save(key: string, v: unknown) {
  prefs[key] = v;
  fetch(`api/prefs/set?${new URLSearchParams({ [key]: JSON.stringify(v) })}`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  info: null as Info | null,
  source: { mode: 'uncommitted' } as Source,
  diffStyle: 'split' as 'split' | 'unified',
  wrap: false,
  theme: 'dark' as 'dark' | 'light',
  files: [] as FileDiffMetadata[],
  oldRev: '',
  newRev: '',
  collapsed: new Set<string>(),
  collapsedDirs: new Set<string>(),
  active: null as string | null,
  fingerprint: '',
  rangeAnchor: null as number | null,
  comments: [] as ReviewComment[],
  draft: null as Draft | null,
};

// ---------------------------------------------------------------------------
// Diff viewer
// ---------------------------------------------------------------------------

/** Load full old/new file text so "expand context" works. */
async function loadDiffFiles(fd: FileDiffMetadata): Promise<FileDiffLoadedFiles> {
  const get = async (rev: string, path: string) => {
    const r = await fetch(`api/file?${new URLSearchParams({ rev, path })}`);
    return r.ok ? r.text() : '';
  };
  const oldName = fd.prevName ?? fd.name;
  const [oldText, newText] = await Promise.all([
    fd.type === 'new' ? '' : get(state.oldRev, oldName),
    fd.type === 'deleted' ? '' : get(state.newRev, fd.name),
  ]);
  return {
    oldFile: { name: oldName, contents: oldText, cacheKey: `${state.oldRev}:${oldName}#${loadSeq}` },
    newFile: { name: fd.name, contents: newText, cacheKey: `${state.newRev}:${fd.name}#${loadSeq}` },
  };
}

function viewerOptions() {
  return {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    // 'system' follows prefers-color-scheme, which pdiff sets to match (see applyOptions).
    themeType: 'system' as const,
    diffStyle: state.diffStyle,
    overflow: state.wrap ? ('wrap' as const) : ('scroll' as const),
    stickyHeaders: true,
    lineDiffType: 'word-alt' as const,
    hunkSeparators: 'line-info' as const,
    expansionLineCount: 20,
    loadDiffFiles,
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (range: SelectedLineRange, ctx: { item: { id: string } }) => startComment(ctx.item.id, range),
    renderAnnotation: (a: { metadata: ReviewComment }) => renderComment(a.metadata),
    lineHoverHighlight: 'both' as const,
    layout: { paddingTop: 10, paddingBottom: 40, gap: 10 },
    unsafeCSS: SERVO_CSS,
  };
}

/**
 * Fixes for Servo. It does not support `overflow: scroll clip`, so the code
 * columns lose their scroll container and grow to fit the longest line.
 * `direction: rtl` (used to cut long paths at the start) moves the
 * leading dot of names like ".github" to the end.
 */
const SERVO_CSS = `
[data-diff-type=split][data-overflow=scroll] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
[data-overflow=scroll] [data-code] { overflow-x: auto; overflow-y: hidden; min-width: 0; }
[data-header-content] [data-prev-name], [data-header-content] [data-title] { direction: ltr; }
`;

const viewer = new CodeView(viewerOptions());
viewer.setup($('codeview'));

function itemFor(fd: FileDiffMetadata, version = 0): CodeViewDiffItem<ReviewComment> {
  return {
    id: fd.name,
    type: 'diff',
    fileDiff: fd,
    collapsed: state.collapsed.has(fd.name),
    version,
    annotations: annotationsFor(fd.name),
  };
}

let embedderTheme = '';
/** True inside pdiff's terminal view (not a normal browser with --serve). */
const EMBEDDED = new URLSearchParams(location.search).has('embed');

function applyOptions() {
  document.documentElement.dataset.theme = state.theme;
  if (embedderTheme !== state.theme && EMBEDDED) {
    // Ask pdiff to switch prefers-color-scheme.
    embedderTheme = state.theme;
    fetch(`api/theme?t=${state.theme}`);
  }
  viewer.setOptions(viewerOptions());
  $('style-split').classList.toggle('on', state.diffStyle === 'split');
  $('style-unified').classList.toggle('on', state.diffStyle === 'unified');
  $('wrap-btn').classList.toggle('on', state.wrap);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function sourceLabel(s: Source): string {
  switch (s.mode) {
    case 'unstaged':
      return 'Unstaged changes';
    case 'staged':
      return 'Staged changes';
    case 'uncommitted':
      return 'All uncommitted changes';
    case 'base':
      return `${state.info?.branch ?? 'HEAD'} vs ${s.base ?? state.info?.defaultBase ?? '?'}`;
    case 'range':
      return s.range ?? '';
  }
}

function showEmpty(title: string, detail = '', isError = false) {
  const e = $('empty');
  e.replaceChildren(h('div', { class: 'big' }, title));
  if (detail) e.append(h('div', { class: isError ? 'err' : '' }, detail));
  e.classList.remove('hidden');
}

let loadSeq = 0;

async function loadDiff(opts: { keepScroll?: boolean } = {}) {
  const seq = ++loadSeq;
  const src = state.source;
  $('source-label').textContent = sourceLabel(src);
  const scrollTop = opts.keepScroll ? viewer.getScrollTop() : 0;

  let res: DiffResponse;
  try {
    res = await getJSON<DiffResponse>(`api/diff?${sourceQuery(src)}`);
  } catch (err) {
    if (seq !== loadSeq) return;
    showEmpty('Could not load the diff', String(err), true);
    return;
  }
  if (seq !== loadSeq) return;
  if (res.label) $('source-label').textContent = res.label;
  if (res.error) {
    state.files = [];
    viewer.setItems([]);
    renderTree();
    renderStats();
    showEmpty('git returned an error', res.error, true);
    return;
  }

  state.oldRev = res.oldRev;
  state.newRev = res.newRev;
  // Commit ranges never change, so their render cache can be kept. The index
  // and working tree do change, so give each load its own cache key.
  const live = [res.oldRev, res.newRev].some((r) => r === ':' || r === 'WORKTREE');
  const prefix = `${res.oldRev}..${res.newRev}${live ? `#${seq}` : ''}`;
  const parsed = parsePatchFiles(res.patch, { cacheKeyPrefix: prefix });
  state.files = sortLikeTree(parsed.flatMap((p) => p.files));

  const names = new Set(state.files.map((f) => f.name));
  for (const n of state.collapsed) if (!names.has(n)) state.collapsed.delete(n);

  viewer.setItems(state.files.map((f) => itemFor(f, ++itemVersion)));
  if (state.files.length === 0) {
    showEmpty('No changes', `Nothing to show for “${$('source-label').textContent}”. Press c to compare something else.`);
  } else {
    $('empty').classList.add('hidden');
  }
  if (opts.keepScroll) {
    viewer.scrollTo({ type: 'position', position: scrollTop, behavior: 'instant' } as never);
  } else {
    $('codeview').scrollTop = 0;
  }
  state.active = state.files[0]?.name ?? null;
  renderTree();
  renderStats();
  state.fingerprint = await fetchFingerprint();
}

let itemVersion = 0;

async function fetchFingerprint(): Promise<string> {
  try {
    const r = await fetch(`api/fingerprint?${sourceQuery(state.source)}`);
    return r.ok ? r.text() : '';
  } catch {
    return '';
  }
}

/** Watch the working tree and reload when it changes. */
async function poll() {
  const fp = await fetchFingerprint();
  if (fp && state.fingerprint && fp !== state.fingerprint) {
    state.fingerprint = fp;
    await refreshInfo();
    await loadDiff({ keepScroll: true });
    toast('Updated from disk');
  }
  setTimeout(poll, 1500);
}

async function refreshInfo() {
  state.info = await getJSON<Info>('api/info');
  renderHeader();
}

function setSource(s: Source) {
  state.source = s;
  const q = new URLSearchParams(location.search);
  q.delete('mode');
  q.delete('base');
  q.delete('range');
  for (const [k, v] of new URLSearchParams(sourceQuery(s))) q.set(k, v);
  history.replaceState(null, '', `?${q}`);
  closePicker();
  loadDiff();
}

// ---------------------------------------------------------------------------
// Header and stats
// ---------------------------------------------------------------------------

function renderHeader() {
  const info = state.info!;
  $('repo-name').textContent = info.repo;
  $('branch').textContent = info.branch;
  document.title = `pdiff · ${info.repo}`;
}

function fileCounts(fd: FileDiffMetadata) {
  let a = 0;
  let d = 0;
  for (const hunk of fd.hunks) {
    a += hunk.additionLines;
    d += hunk.deletionLines;
  }
  return { a, d };
}

function renderStats() {
  let a = 0;
  let d = 0;
  for (const f of state.files) {
    const c = fileCounts(f);
    a += c.a;
    d += c.d;
  }
  const total = a + d;
  const bars = h('span', { class: 'bars' });
  const greens = total ? Math.round((a / total) * 5) : 0;
  for (let i = 0; i < 5; i++) {
    bars.append(h('i', { class: total === 0 ? '' : i < greens ? 'a' : 'd' }));
  }
  const n = state.files.length;
  $('stats').replaceChildren(
    h('span', {}, `${n} file${n === 1 ? '' : 's'}`),
    h('span', { class: 'add' }, `+${a.toLocaleString()}`),
    h('span', { class: 'del' }, `−${d.toLocaleString()}`),
    bars,
  );
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileDiffMetadata[];
}

function buildTree(files: FileDiffMetadata[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.name.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  // Join chains of single-child directories: "src" > "lib" > "x" becomes "src/lib/x".
  const compact = (n: DirNode): DirNode => {
    for (const [k, d] of n.dirs) n.dirs.set(k, compact(d));
    if (n.path && n.files.length === 0 && n.dirs.size === 1) {
      const only = [...n.dirs.values()][0];
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return compact(root);
}

/** Order files as the tree shows them: folders before files, then by name. */
function sortLikeTree(files: FileDiffMetadata[]): FileDiffMetadata[] {
  const key = (name: string) => {
    const parts = name.split('/');
    // Prefix each folder with "0" and the file with "1" so folders sort first.
    return parts.map((p, i) => (i < parts.length - 1 ? `0${p}` : `1${p}`)).join('/');
  };
  return [...files].sort((a, b) => key(a.name).localeCompare(key(b.name)));
}

const STATUS: Record<string, string> = {
  new: 'A',
  deleted: 'D',
  change: 'M',
  'rename-pure': 'R',
  'rename-changed': 'R',
};

function renderTree() {
  const filter = ($('file-filter') as HTMLInputElement).value.trim().toLowerCase();
  const files = filter ? state.files.filter((f) => f.name.toLowerCase().includes(filter)) : state.files;
  const tree = $('tree');
  const out: HTMLElement[] = [];

  const walk = (node: DirNode, depth: number) => {
    const dirs = [...node.dirs.values()].sort((x, y) => x.name.localeCompare(y.name));
    for (const d of dirs) {
      const closed = state.collapsedDirs.has(d.path) && !filter;
      out.push(
        h(
          'div',
          {
            class: 'node',
            style: `padding-left:${6 + depth * 14}px`,
            onclick: () => {
              if (state.collapsedDirs.has(d.path)) state.collapsedDirs.delete(d.path);
              else state.collapsedDirs.add(d.path);
              renderTree();
            },
          },
          h('span', { class: 'twisty' }, closed ? '▸' : '▾'),
          h('span', { class: 'fname dir' }, d.name),
        ),
      );
      if (!closed) walk(d, depth + 1);
    }
    const sorted = [...node.files].sort((x, y) => x.name.localeCompare(y.name));
    for (const f of sorted) {
      const { a, d } = fileCounts(f);
      const base = f.name.split('/').pop()!;
      out.push(
        h(
          'div',
          {
            class: `node${state.active === f.name ? ' active' : ''}`,
            style: `padding-left:${6 + depth * 14}px`,
            title: f.prevName ? `${f.prevName} → ${f.name}` : f.name,
            'data-name': f.name,
            onclick: () => jumpTo(f.name),
          },
          h('span', { class: 'twisty' }),
          h('span', { class: `st ${f.type}` }, STATUS[f.type] ?? '?'),
          h('span', { class: 'fname' }, base),
          h('span', { class: 'nums' }, a ? h('span', { class: 'a' }, `+${a}`) : null, d ? h('span', { class: 'd' }, `−${d}`) : null),
        ),
      );
    }
  };
  walk(buildTree(files), 0);
  tree.replaceChildren(...out);
}

function setActive(name: string | null) {
  if (name === state.active) return;
  state.active = name;
  for (const el of $('tree').querySelectorAll('.node.active')) el.classList.remove('active');
  if (!name) return;
  const el = $('tree').querySelector(`[data-name="${CSS.escape(name)}"]`);
  if (el) {
    el.classList.add('active');
    const box = $('tree').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollIntoView({ block: 'nearest' });
  }
}

function jumpTo(name: string) {
  viewer.scrollTo({ type: 'item', id: name, align: 'start', behavior: 'instant' } as never);
  setActive(name);
}

/** Highlight the file at the top of the viewport in the tree. */
viewer.subscribeToScroll((scrollTop) => {
  let current: string | null = null;
  for (const f of state.files) {
    const top = viewer.getTopForItem(f.name);
    if (top == null) continue;
    if (top <= scrollTop + 24) current = f.name;
    else break;
  }
  setActive(current ?? state.files[0]?.name ?? null);
});

function stepFile(dir: 1 | -1) {
  if (!state.files.length) return;
  const i = state.files.findIndex((f) => f.name === state.active);
  const next = Math.max(0, Math.min(state.files.length - 1, (i < 0 ? 0 : i) + dir));
  jumpTo(state.files[next].name);
}

function toggleCollapse(name: string | null) {
  if (!name) return;
  const fd = state.files.find((f) => f.name === name);
  if (!fd) return;
  if (state.collapsed.has(name)) state.collapsed.delete(name);
  else state.collapsed.add(name);
  viewer.updateItem(itemFor(fd, ++itemVersion));
}

function toggleCollapseAll() {
  const allCollapsed = state.files.every((f) => state.collapsed.has(f.name));
  state.collapsed = allCollapsed ? new Set() : new Set(state.files.map((f) => f.name));
  viewer.setItems(state.files.map((f) => itemFor(f, ++itemVersion)));
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

/**
 * Comments show below their last line. The renderer compares annotation
 * metadata by identity, so a changed comment must be a new object.
 */
function annotationsFor(file: string): DiffLineAnnotation<ReviewComment>[] {
  const d = state.draft;
  const list = state.comments.filter((c) => c.file === file && c.id !== d?.editing);
  if (d && d.file === file) list.push(d);
  return list.map((c) => ({ side: c.side, lineNumber: c.end, metadata: c }));
}

/** Re-render one file so its annotations update. */
function refreshFile(file: string) {
  const fd = state.files.find((f) => f.name === file);
  if (fd) viewer.updateItem(itemFor(fd, ++itemVersion));
}

let commentSeq = 0;

/** Text of lines `start..end` on one side, when the diff includes them. */
function snippetFor(fd: FileDiffMetadata, side: Side, start: number, end: number): string[] {
  const lines = side === 'additions' ? fd.additionLines : fd.deletionLines;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    let i = n - 1;
    if (fd.isPartial) {
      const hunk = fd.hunks.find((h) =>
        side === 'additions'
          ? n >= h.additionStart && n < h.additionStart + h.additionCount
          : n >= h.deletionStart && n < h.deletionStart + h.deletionCount,
      );
      if (!hunk) return [];
      i = side === 'additions' ? hunk.additionLineIndex + n - hunk.additionStart : hunk.deletionLineIndex + n - hunk.deletionStart;
    }
    const line = lines[i];
    if (line == null) return [];
    out.push(line.replace(/\r?\n$/, ''));
  }
  return out;
}

/** Open a comment box for a line range of `file`. */
function startComment(file: string, range: SelectedLineRange) {
  const fd = state.files.find((f) => f.name === file);
  if (!fd) return;
  const side: Side = range.endSide ?? range.side ?? 'additions';
  // A range across both sides (split view) has two line number spaces; keep the last line only.
  const sameSide = (range.side ?? side) === side;
  const start = sameSide ? Math.min(range.start, range.end) : range.end;
  const end = sameSide ? Math.max(range.start, range.end) : range.end;
  const prev = state.draft;
  state.draft = { id: `c${Date.now().toString(36)}${commentSeq++}`, file, side, start, end, body: '', snippet: snippetFor(fd, side, start, end) };
  if (prev && prev.file !== file) refreshFile(prev.file);
  viewer.clearSelectedLines();
  refreshFile(file);
}

function editComment(c: ReviewComment) {
  const prev = state.draft;
  state.draft = { ...c, editing: c.id };
  if (prev && prev.file !== c.file) refreshFile(prev.file);
  refreshFile(c.file);
}

function cancelDraft() {
  const d = state.draft;
  if (!d) return;
  state.draft = null;
  refreshFile(d.file);
}

function submitDraft() {
  const d = state.draft;
  if (!d) return;
  state.draft = null;
  const { editing, ...c } = d;
  if (!c.body.trim()) {
    // An empty comment deletes the comment it edits.
    state.comments = state.comments.filter((x) => x.id !== editing);
  } else if (editing) {
    state.comments = state.comments.map((x) => (x.id === editing ? c : x));
  } else {
    state.comments.push(c);
  }
  refreshFile(d.file);
  commentsChanged();
}

function deleteComment(c: ReviewComment) {
  state.comments = state.comments.filter((x) => x.id !== c.id);
  refreshFile(c.file);
  commentsChanged();
}

/** Comment on the selected lines (key m). */
function commentOnSelection() {
  const sel = viewer.getSelectedLines();
  if (!sel) return toast('Select lines first: click or drag line numbers, or use the + button');
  startComment(sel.id, sel.range);
}

function lineLabel(c: ReviewComment) {
  const lines = c.start === c.end ? `Line ${c.start}` : `Lines ${c.start}–${c.end}`;
  return c.side === 'deletions' ? `${lines} (old)` : lines;
}

function renderComment(c: ReviewComment): HTMLElement {
  if (c === state.draft) return renderDraft(state.draft);
  const body = h('div', { class: 'comment-body' }, c.body);
  return h(
    'div',
    { class: 'comment', ondblclick: () => editComment(c) },
    h(
      'div',
      { class: 'comment-head' },
      h('span', { class: 'comment-lines' }, lineLabel(c)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link-btn', onclick: () => editComment(c) }, 'Edit'),
      h('button', { class: 'link-btn danger', onclick: () => deleteComment(c) }, 'Delete'),
    ),
    body,
  );
}

function renderDraft(d: Draft): HTMLElement {
  const ta = h('textarea', {
    class: 'comment-input',
    placeholder: 'Leave a comment for the agent…',
    rows: 3,
    spellcheck: 'false',
  }) as HTMLTextAreaElement;
  ta.value = d.body;
  ta.addEventListener('input', () => {
    d.body = ta.value;
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancelDraft();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitDraft();
    }
  });
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  return h(
    'div',
    { class: 'comment draft' },
    h('div', { class: 'comment-head' }, h('span', { class: 'comment-lines' }, lineLabel(d))),
    ta,
    h(
      'div',
      { class: 'comment-actions' },
      h('span', { class: 'hint' }, 'Ctrl-Enter to save · Esc to cancel'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: cancelDraft }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: submitDraft }, d.editing ? 'Save' : 'Comment'),
    ),
  );
}

/** Send the list to the server (for agents) and update the header button. */
function commentsChanged() {
  const n = state.comments.length;
  const btn = $('comments-btn');
  btn.classList.toggle('hidden', n === 0);
  $('comments-count').textContent = String(n);
  fetch('api/comments', {
    method: 'POST',
    body: JSON.stringify({ label: $('source-label').textContent ?? '', comments: state.comments }),
  });
}

async function loadComments() {
  try {
    const r = await getJSON<{ comments: ReviewComment[] }>('api/comments');
    state.comments = r.comments ?? [];
  } catch {
    state.comments = [];
  }
  commentsChanged();
}

/** Copy all comments as a Markdown prompt (key y). */
async function copyComments() {
  if (!state.comments.length) return toast('No comments yet');
  const r = await fetch('api/comments/copy');
  const n = state.comments.length;
  toast(r.ok ? `Copied ${n} comment${n === 1 ? '' : 's'}. Paste them into your agent.` : `Copy failed: ${await r.text()}`);
}

// ---------------------------------------------------------------------------
// Source picker
// ---------------------------------------------------------------------------

const MODES: { mode: Mode; key: string; name: string; desc: string }[] = [
  { mode: 'uncommitted', key: '1', name: 'All uncommitted', desc: 'HEAD → working tree' },
  { mode: 'unstaged', key: '2', name: 'Unstaged', desc: 'index → working tree' },
  { mode: 'staged', key: '3', name: 'Staged', desc: 'HEAD → index' },
];

function pickerOpen() {
  return !$('picker').classList.contains('hidden');
}

function openPicker() {
  renderPicker();
  $('picker').classList.remove('hidden');
  $('source-btn').classList.add('open');
}

function closePicker() {
  $('picker').classList.add('hidden');
  $('source-btn').classList.remove('open');
  state.rangeAnchor = null;
  (document.activeElement as HTMLElement | null)?.blur();
}

function renderPicker() {
  const info = state.info!;
  const src = state.source;

  $('mode-list').replaceChildren(
    ...MODES.map((m) =>
      h(
        'div',
        { class: `mode${src.mode === m.mode ? ' on' : ''}`, onclick: () => setSource({ mode: m.mode }) },
        h('span', { class: 'mode-key' }, m.key),
        h('div', { class: 'mode-text' }, h('div', { class: 'mode-name' }, m.name), h('div', { class: 'mode-desc' }, m.desc)),
        h('span', { class: `count${info.counts[m.mode as 'staged'] ? '' : ' zero'}` }, String(info.counts[m.mode as 'staged'])),
      ),
    ),
  );
  renderBaseList();
  renderCommits();
}

function renderBaseList() {
  const info = state.info!;
  const filter = ($('base-filter') as HTMLInputElement).value.trim().toLowerCase();
  const current = state.source.mode === 'base' ? state.source.base ?? info.defaultBase : null;
  const refs = info.branches.filter((b) => b !== info.branch && (!filter || b.toLowerCase().includes(filter)));
  if (info.defaultBase) {
    const i = refs.indexOf(info.defaultBase);
    if (i > 0) refs.unshift(...refs.splice(i, 1));
  }
  $('base-list').replaceChildren(
    ...refs.slice(0, 200).map((b) =>
      h(
        'div',
        { class: `ref${current === b ? ' on' : ''}`, onclick: () => setSource({ mode: 'base', base: b }) },
        h('span', {}, b),
        b === info.defaultBase ? h('span', { class: 'tag' }, 'default') : null,
      ),
    ),
  );
}

/** Commit list. Click = that commit; shift-click = range from the anchor. */
function renderCommits() {
  const info = state.info!;
  const commits = info.commits;
  // Show the active range, if it is one of ours: "<old>^..<new>" or "<old>..<new>".
  let start = -1;
  let end = -1;
  const m = state.source.mode === 'range' ? /^(\w+)(\^?)\.\.(\w+)$/.exec(state.source.range ?? '') : null;
  if (m) {
    const iNew = commits.findIndex((c) => c.sha.startsWith(m[3]));
    let iOld = commits.findIndex((c) => c.sha.startsWith(m[1]));
    if (iOld >= 0 && !m[2]) iOld -= 1; // "A..B" excludes A itself
    if (iNew >= 0 && iOld >= iNew) {
      end = iNew;
      start = iOld;
    }
  }
  $('commit-list').replaceChildren(
    ...commits.map((c, i) => {
      const inRange = i >= end && i <= start && end >= 0;
      const cls = ['commit'];
      if (inRange) cls.push('in-range');
      if (i === end) cls.push('end');
      if (i === start) cls.push('start');
      if (state.rangeAnchor === i) cls.push('anchor');
      return h(
        'div',
        {
          class: cls.join(' '),
          title: `${c.sha}\n${c.author}, ${c.when}`,
          onclick: (e: MouseEvent) => {
            if (e.shiftKey && state.rangeAnchor != null) {
              const newer = Math.min(i, state.rangeAnchor);
              const older = Math.max(i, state.rangeAnchor);
              setSource({ mode: 'range', range: `${commits[older].short}^..${commits[newer].short}` });
            } else if (e.shiftKey) {
              state.rangeAnchor = i;
              renderCommits();
              toast('Range start set. Shift-click another commit.');
            } else {
              setSource({ mode: 'range', range: `${c.short}^..${c.short}` });
            }
          },
        },
        h('span', { class: 'dot' }),
        h('span', { class: 'sha' }, c.short),
        h('span', { class: 'subj' }, c.subject),
        h('span', { class: 'meta' }, c.when),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function isTyping() {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function wire() {
  $('source-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    pickerOpen() ? closePicker() : openPicker();
  });
  document.addEventListener('mousedown', (e) => {
    if (!pickerOpen()) return;
    const t = e.target as Node;
    if (!$('picker').contains(t) && !$('source-btn').contains(t)) closePicker();
  });
  $('style-split').addEventListener('click', () => setStyle('split'));
  $('style-unified').addEventListener('click', () => setStyle('unified'));
  $('wrap-btn').addEventListener('click', toggleWrap);
  $('theme-btn').addEventListener('click', toggleTheme);
  $('refresh-btn').addEventListener('click', refresh);
  $('comments-btn').addEventListener('click', copyComments);
  $('file-filter').addEventListener('input', renderTree);
  $('base-filter').addEventListener('input', renderBaseList);
  const custom = $('custom-range') as HTMLInputElement;
  const go = () => {
    const v = custom.value.trim();
    if (v) setSource({ mode: 'range', range: v });
  };
  $('custom-go').addEventListener('click', go);
  custom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (pickerOpen()) return closePicker();
      if (isTyping()) return (document.activeElement as HTMLElement).blur();
    }
    if (isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (pickerOpen()) {
      const m = MODES.find((x) => x.key === k);
      if (m) return setSource({ mode: m.mode });
      if (k === 'b') return setSource({ mode: 'base', base: state.info?.defaultBase ?? undefined });
      if (k === 'c') return closePicker();
      return;
    }
    const actions: Record<string, () => void> = {
      c: openPicker,
      q: () => {
        fetch('api/quit');
      },
      s: () => setStyle(state.diffStyle === 'split' ? 'unified' : 'split'),
      w: toggleWrap,
      t: toggleTheme,
      r: refresh,
      j: () => stepFile(1),
      n: () => stepFile(1),
      k: () => stepFile(-1),
      p: () => stepFile(-1),
      x: () => toggleCollapse(state.active),
      X: toggleCollapseAll,
      e: () => save('sidebar', !document.body.classList.toggle('no-sidebar')),
      '/': () => $('file-filter').focus(),
      m: commentOnSelection,
      y: copyComments,
      '1': () => setSource({ mode: 'uncommitted' }),
      '2': () => setSource({ mode: 'unstaged' }),
      '3': () => setSource({ mode: 'staged' }),
      '4': () => setSource({ mode: 'base', base: state.info?.defaultBase ?? undefined }),
      g: () => viewer.scrollTo({ type: 'position', position: 0, behavior: 'instant' } as never),
      G: () => viewer.scrollTo({ type: 'position', position: 1e9, behavior: 'instant' } as never),
    };
    const fn = actions[k];
    if (fn) {
      e.preventDefault();
      fn();
    } else if (k === ' ' || k === 'PageDown' || k === 'd' || k === 'u' || k === 'PageUp') {
      const el = $('codeview');
      const page = el.clientHeight * (k === 'd' || k === 'u' ? 0.5 : 0.9);
      el.scrollTop += (k === 'u' || k === 'PageUp' || e.shiftKey ? -1 : 1) * page;
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 'ArrowUp') {
      $('codeview').scrollTop += k === 'ArrowDown' ? 60 : -60;
      e.preventDefault();
    }
  });
}

function setStyle(s: 'split' | 'unified') {
  state.diffStyle = s;
  save('diffStyle', s);
  applyOptions();
}
function toggleWrap() {
  state.wrap = !state.wrap;
  save('wrap', state.wrap);
  applyOptions();
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  save('theme', state.theme);
  applyOptions();
}
async function refresh() {
  await refreshInfo();
  await loadDiff({ keepScroll: true });
  toast('Reloaded');
}

async function main() {
  wire();
  await loadPrefs();
  state.diffStyle = store('diffStyle', 'split');
  state.wrap = store('wrap', false);
  state.theme = store('theme', 'dark');
  if (!store<boolean>('sidebar', true)) document.body.classList.add('no-sidebar');
  applyOptions();
  await loadComments();
  try {
    await refreshInfo();
  } catch (err) {
    showEmpty('Could not reach the pdiff server', String(err), true);
    return;
  }
  const q = new URLSearchParams(location.search);
  const mode = q.get('mode') as Mode | null;
  state.source = mode
    ? { mode, base: q.get('base') ?? undefined, range: q.get('range') ?? undefined }
    : state.info!.initial;
  await loadDiff();
  setTimeout(poll, 1500);
}

main();
