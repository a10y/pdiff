// pdiff key bindings (the same keys as the old UI, see README / web/src/main.ts).

import type { SelectedLineRange } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef } from 'react';

import { quit, type Source } from './api';
import type { CommentMetadata } from '@/lib/types';

interface LoadedFiles {
  byName: Map<string, { itemId: string }>;
  order: string[];
}

interface KeyActions {
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  loadedRef: RefObject<LoadedFiles>;
  defaultBase: string | null;
  /** True while the source picker is open (it handles its own keys). */
  disabled: boolean;
  openPicker(): void;
  setSource(s: Source): void;
  toggleDiffStyle(): void;
  toggleWrap(): void;
  toggleTheme(): void;
  reload(): void;
  toggleCollapseAll(): void;
  scrollToItem(itemId: string): void;
  commentOnSelection(): void;
  copyComments(): void;
}

// Re-export for callers that type the draft callback.
export type CreateDraft = (range: SelectedLineRange, itemId: string) => void;

function isTyping(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** Index in `order` of the file at the top of the viewport. */
function currentFileIndex(a: KeyActions): number {
  const inst = a.viewerRef.current?.getInstance();
  const { order, byName } = a.loadedRef.current;
  if (inst == null || order.length === 0) return -1;
  const top = inst.getScrollTop();
  let current = 0;
  for (let i = 0; i < order.length; i++) {
    const id = byName.get(order[i])?.itemId;
    const itemTop = id == null ? undefined : inst.getTopForItem(id);
    if (itemTop == null) continue;
    if (itemTop <= top + 24) current = i;
    else break;
  }
  return current;
}

export function usePdiffKeys(actions: KeyActions): void {
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      if (e.key === 'Escape' && isTyping()) {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      if (a.disabled || isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;

      const step = (dir: 1 | -1) => {
        const { order, byName } = a.loadedRef.current;
        if (order.length === 0) return;
        const i = currentFileIndex(a);
        const next = Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + dir));
        const id = byName.get(order[next])?.itemId;
        if (id != null) a.scrollToItem(id);
      };
      const toggleCurrent = () => {
        const { order, byName } = a.loadedRef.current;
        const i = currentFileIndex(a);
        const id = i < 0 ? undefined : byName.get(order[i])?.itemId;
        const viewer = a.viewerRef.current;
        const item = id == null ? undefined : viewer?.getItem(id);
        if (viewer == null || item == null) return;
        item.collapsed = item.collapsed !== true;
        item.version = typeof item.version === 'number' ? item.version + 1 : 1;
        viewer.updateItem(item);
      };
      const scrollBy = (dy: number) => {
        const el = a.scrollRef.current;
        if (el != null) el.scrollTop += dy;
      };
      const pos = (position: number) =>
        a.viewerRef.current?.scrollTo({ type: 'position', position, behavior: 'instant' } as never);

      const k = e.key;
      const map: Record<string, () => void> = {
        c: a.openPicker,
        q: quit,
        s: a.toggleDiffStyle,
        w: a.toggleWrap,
        t: a.toggleTheme,
        r: a.reload,
        j: () => step(1),
        n: () => step(1),
        k: () => step(-1),
        p: () => step(-1),
        x: toggleCurrent,
        X: a.toggleCollapseAll,
        m: a.commentOnSelection,
        y: a.copyComments,
        '1': () => a.setSource({ mode: 'uncommitted' }),
        '2': () => a.setSource({ mode: 'unstaged' }),
        '3': () => a.setSource({ mode: 'staged' }),
        '4': () => a.setSource({ mode: 'base', base: a.defaultBase ?? undefined }),
        g: () => pos(0),
        G: () => pos(1e9),
      };
      const fn = map[k];
      if (fn) {
        e.preventDefault();
        fn();
        return;
      }
      const page = a.scrollRef.current?.clientHeight ?? 600;
      if (k === ' ' || k === 'PageDown' || k === 'PageUp' || k === 'd' || k === 'u') {
        const amount = page * (k === 'd' || k === 'u' ? 0.5 : 0.9);
        scrollBy((k === 'u' || k === 'PageUp' || e.shiftKey ? -1 : 1) * amount);
        e.preventDefault();
      } else if (k === 'ArrowDown' || k === 'ArrowUp') {
        scrollBy(k === 'ArrowDown' ? 60 : -60);
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
