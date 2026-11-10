// pdiff review comments. DiffsHub keeps comments only in the viewer's items,
// so they would be lost on each reload. This store is the source of truth: it
// survives reloads and source changes, and it sends the full list to the
// server after each change (the server builds the agent prompt from it).

import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';

import { classifyCommentLineType } from '@/lib/classifyCommentLineType';
import type { CommentMetadata, DiffsHubSavedCommentEvent } from '@/lib/types';

export const AUTHOR = 'You';

/** A comment on one or more lines. Matches `Comment` in src/review.rs. */
export interface ReviewComment {
  id: string;
  file: string;
  side: AnnotationSide;
  start: number;
  end: number;
  body: string;
  snippet: string[];
}

let comments: ReviewComment[] = [];
let label = '';
const listeners = new Set<() => void>();

export function getComments(): readonly ReviewComment[] {
  return comments;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  for (const fn of listeners) fn();
  fetch('api/comments', {
    method: 'POST',
    body: JSON.stringify({ label, comments }),
  }).catch(() => {});
}

/** Comments are kept by the server, so a reload of the page keeps them. */
export async function loadComments(): Promise<void> {
  try {
    const r = await fetch('api/comments');
    const body = (await r.json()) as { comments?: ReviewComment[] };
    comments = body.comments ?? [];
  } catch {
    comments = [];
  }
  for (const fn of listeners) fn();
}

/** What the diff compares; goes into the agent prompt. */
export function setLabel(l: string): void {
  if (l === label) return;
  label = l;
  if (comments.length > 0) changed();
}

export function saveComment(c: ReviewComment): void {
  const i = comments.findIndex((x) => x.id === c.id);
  comments = i < 0 ? [...comments, c] : comments.map((x) => (x.id === c.id ? c : x));
  changed();
}

export function deleteComment(id: string): void {
  const next = comments.filter((x) => x.id !== id);
  if (next.length === comments.length) return;
  comments = next;
  changed();
}

/** Text of lines `start..end` on one side, when the diff includes them. */
export function snippetFor(fd: FileDiffMetadata, side: AnnotationSide, start: number, end: number): string[] {
  const lines = side === 'additions' ? fd.additionLines : fd.deletionLines;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    let i = n - 1;
    if (fd.isPartial) {
      const hunk = fd.hunks.find((h) =>
        side === 'additions'
          ? n >= h.additionStart && n < h.additionStart + h.additionCount
          : n >= h.deletionStart && n < h.deletionStart + h.deletionCount
      );
      if (!hunk) return [];
      i =
        side === 'additions'
          ? hunk.additionLineIndex + n - hunk.additionStart
          : hunk.deletionLineIndex + n - hunk.deletionStart;
    }
    const line = lines[i];
    if (line == null) return [];
    out.push(line.replace(/\r?\n$/, ''));
  }
  return out;
}

/** A store comment from a DiffsHub "saved" event. */
export function fromSavedEvent(e: DiffsHubSavedCommentEvent, fd: FileDiffMetadata): ReviewComment {
  const side = e.side;
  const r = e.range;
  // A range across both sides (split view) has two line number spaces; keep
  // the last line only.
  const sameSide = (r.side ?? side) === side;
  const start = sameSide ? Math.min(r.start, r.end) : r.end;
  const end = sameSide ? Math.max(r.start, r.end) : r.end;
  return { id: e.key, file: fd.name, side, start, end, body: e.message, snippet: snippetFor(fd, side, start, end) };
}

function rangeOf(c: ReviewComment): SelectedLineRange {
  return { start: c.start, end: c.end, side: c.side, endSide: c.side };
}

/** The viewer annotation for a stored comment. */
export function toAnnotation(c: ReviewComment): DiffLineAnnotation<CommentMetadata> {
  return {
    side: c.side,
    lineNumber: c.end,
    metadata: { kind: 'saved', key: c.id, author: AUTHOR, message: c.body, range: rangeOf(c) },
  };
}

/** The sidebar entry for a stored comment shown in item `itemId`. */
export function toSidebarEvent(c: ReviewComment, itemId: string, fd: FileDiffMetadata): DiffsHubSavedCommentEvent {
  return {
    author: AUTHOR,
    itemId,
    key: c.id,
    lineNumber: c.end,
    lineType: classifyCommentLineType(fd, c.side, c.end),
    message: c.body,
    range: rangeOf(c),
    side: c.side,
  };
}
