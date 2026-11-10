// pdiff: choose what to compare. Ported from the old UI (web/src/main.ts).
// Keys while open: 1-3 working-tree modes, b default base, Esc or c to close.

import { IconChevronSm } from '@pierre/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { Info, Mode, Source } from './api';
import { CHROME_ICON_BUTTON_CLASS } from '@/components/chromeButtonStyles';
import { cn } from '@/lib/cn';

export const MODES: { mode: Mode; key: string; name: string; desc: string }[] = [
  { mode: 'uncommitted', key: '1', name: 'All uncommitted', desc: 'HEAD → working tree' },
  { mode: 'unstaged', key: '2', name: 'Unstaged', desc: 'index → working tree' },
  { mode: 'staged', key: '3', name: 'Staged', desc: 'HEAD → index' },
];

interface SourcePickerProps {
  info: Info | null;
  source: Source;
  label: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(source: Source): void;
}

const TITLE = 'px-3 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const ROW =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--diffshub-popover-hover-bg,var(--color-accent))]';
const INPUT =
  'w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-blue-500';

export function SourcePicker({ info, source, label, open, onOpenChange, onSelect }: SourcePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [baseFilter, setBaseFilter] = useState('');
  const [custom, setCustom] = useState('');
  const [anchor, setAnchor] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onOpenChange(false);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const m = MODES.find((x) => x.key === e.key);
      let next: Source | null = null;
      if (m) next = { mode: m.mode };
      else if (e.key === 'b' && info?.defaultBase) next = { mode: 'base', base: info.defaultBase };
      else if (e.key === 'c') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onOpenChange(false);
        return;
      }
      if (next) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onSelect(next);
      }
    };
    document.addEventListener('mousedown', onDown);
    // Capture, so these keys do not reach the global key bindings.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, info, onOpenChange, onSelect]);

  const bases = useMemo(() => {
    if (info == null) return [];
    const f = baseFilter.trim().toLowerCase();
    const refs = info.branches.filter((b) => b !== info.branch && (!f || b.toLowerCase().includes(f)));
    if (info.defaultBase) {
      const i = refs.indexOf(info.defaultBase);
      if (i > 0) refs.unshift(...refs.splice(i, 1));
    }
    return refs.slice(0, 200);
  }, [info, baseFilter]);

  // The active commit range, if it is one this picker made: "<old>^..<new>" or "<old>..<new>".
  const [rangeStart, rangeEnd] = useMemo(() => {
    const commits = info?.commits ?? [];
    const m = source.mode === 'range' ? /^(\w+)(\^?)\.\.(\w+)$/.exec(source.range ?? '') : null;
    if (!m) return [-1, -1];
    const iNew = commits.findIndex((c) => c.sha.startsWith(m[3]));
    let iOld = commits.findIndex((c) => c.sha.startsWith(m[1]));
    if (iOld >= 0 && !m[2]) iOld -= 1; // "A..B" excludes A itself
    return iNew >= 0 && iOld >= iNew ? [iOld, iNew] : [-1, -1];
  }, [info, source]);

  const currentBase = source.mode === 'base' ? (source.base ?? info?.defaultBase) : null;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        title="Choose what to compare (c)"
        onClick={() => onOpenChange(!open)}
        className={cn(
          CHROME_ICON_BUTTON_CLASS,
          'flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px]',
          open && 'bg-[var(--diffshub-popover-hover-bg,var(--color-accent))]'
        )}
      >
        <span className="text-muted-foreground">Comparing</span>
        <span className="min-w-0 truncate font-medium">{label || '…'}</span>
        <IconChevronSm className="size-3 shrink-0" />
      </button>
      {open && info != null && (
        <div className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 flex max-h-[min(560px,80vh)] w-[min(820px,calc(100vw-24px))] overflow-hidden rounded-lg border border-border shadow-lg">
          <div className="flex w-[300px] shrink-0 flex-col border-r border-border">
            <div className={TITLE}>Working tree</div>
            <div className="px-1.5">
              {MODES.map((m) => {
                const n = info.counts[m.mode as 'staged' | 'unstaged' | 'uncommitted'];
                return (
                  <button
                    key={m.mode}
                    type="button"
                    className={cn(ROW, source.mode === m.mode && 'bg-blue-500/15')}
                    onClick={() => onSelect({ mode: m.mode })}
                  >
                    <kbd className="w-4 text-center font-mono text-[11px] text-muted-foreground">{m.key}</kbd>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{m.name}</span>
                      <span className="text-[11px] text-muted-foreground">{m.desc}</span>
                    </span>
                    <span className={cn('font-mono text-[11px]', n === 0 && 'text-muted-foreground/60')}>{n}</span>
                  </button>
                );
              })}
            </div>
            <div className={TITLE}>Compare branch against</div>
            <div className="px-3 pb-1.5">
              <input
                className={INPUT}
                placeholder="Filter branches…"
                spellCheck={false}
                value={baseFilter}
                onChange={(e) => setBaseFilter(e.currentTarget.value)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {bases.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={cn(ROW, 'font-mono text-[12px]', currentBase === b && 'bg-blue-500/15')}
                  onClick={() => onSelect({ mode: 'base', base: b })}
                >
                  <span className="min-w-0 flex-1 truncate">{b}</span>
                  {b === info.defaultBase && (
                    <span className="rounded border border-border px-1 font-sans text-[10px] text-muted-foreground">
                      default
                    </span>
                  )}
                </button>
              ))}
              {bases.length === 0 && <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No other branches</div>}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className={cn(TITLE, 'flex items-baseline gap-2')}>
              Commits
              <span className="font-normal normal-case tracking-normal">click: one commit · shift-click: range</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
              {info.commits.map((c, i) => {
                const inRange = rangeEnd >= 0 && i >= rangeEnd && i <= rangeStart;
                return (
                  <button
                    key={c.sha}
                    type="button"
                    title={`${c.sha}\n${c.author}, ${c.when}`}
                    className={cn(ROW, inRange && 'bg-blue-500/15', anchor === i && 'ring-1 ring-blue-500')}
                    onClick={(e) => {
                      if (e.shiftKey && anchor != null) {
                        const newer = Math.min(i, anchor);
                        const older = Math.max(i, anchor);
                        onSelect({ mode: 'range', range: `${info.commits[older].short}^..${info.commits[newer].short}` });
                      } else if (e.shiftKey) {
                        setAnchor(i);
                        toast('Range start set. Shift-click another commit.');
                      } else {
                        onSelect({ mode: 'range', range: `${c.short}^..${c.short}` });
                      }
                    }}
                  >
                    <span className="font-mono text-[11.5px] text-blue-500">{c.short}</span>
                    <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{c.when}</span>
                  </button>
                );
              })}
            </div>
            <div className={TITLE}>Any revision range</div>
            <form
              className="flex gap-2 px-3 pb-3"
              onSubmit={(e) => {
                e.preventDefault();
                const v = custom.trim();
                if (v) onSelect({ mode: 'range', range: v });
              }}
            >
              <input
                className={cn(INPUT, 'font-mono')}
                placeholder="main~3..HEAD   or   v1.2.0...my-branch"
                spellCheck={false}
                value={custom}
                onChange={(e) => setCustom(e.currentTarget.value)}
              />
              <button type="submit" className="rounded-md bg-blue-500 px-3 text-[13px] text-white hover:bg-blue-600">
                Show
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
