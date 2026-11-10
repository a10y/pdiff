// Servo draws each inline <svg> on its own, from its attributes only:
// - it ignores CSS (inline `style` and classes) and draws `currentColor` as
//   black, so icons with fill="currentcolor" come out black;
// - <use href="#id"> cannot reach a <symbol> in another <svg> (the file
//   tree's sprite sheet), so those icons are empty.
// This module copies each used <symbol> into the <svg> that uses it, and
// writes computed colours into `fill`/`stroke` attributes. It runs again when
// the DOM, a class, or the theme changes. Hover colours do not update (only a
// change to the element or its classes triggers a pass).

const SVG_NS = 'http://www.w3.org/2000/svg';
const watched = new Set<Document | ShadowRoot>();
const dirty = new Set<ParentNode>();
// Root <svg> elements changed in this pass. Servo draws an <svg> again only
// when the root itself changes, not when a child changes, so each one gets a
// new `data-pdiff-v` at the end of the pass.
const changedRoots = new Set<Element>();
let version = 0;

function rootSvg(el: Element): Element | null {
  let root: Element | null = null;
  for (let e: Element | null = el; e != null; e = e.parentElement) {
    if (e.localName === 'svg') root = e;
  }
  return root;
}
let scheduled = false;

// Elements to fix: users of currentColor (or ones this module changed), sprite
// references, and root <svg> elements (their fill can come from CSS only).
const TARGETS =
  'svg, use, [fill="currentcolor" i], [stroke="currentcolor" i], [data-pdiff-fill], [data-pdiff-stroke]';
// Elements here that have a shadow root (the code view and the file tree).
const SHADOW_HOSTS = 'diffs-container, file-tree-container';

function setColorAttr(el: Element, attr: 'fill' | 'stroke', color: string): void {
  if (color && el.getAttribute(attr) !== color) {
    el.setAttribute(attr, color);
    const root = rootSvg(el);
    if (root != null) changedRoots.add(root);
  }
}

/** Replace fill/stroke="currentcolor" with the computed colour. */
function fixCurrentColor(el: Element): void {
  for (const attr of ['fill', 'stroke'] as const) {
    const marker = `data-pdiff-${attr}`;
    if (!el.hasAttribute(marker)) {
      const cur = el.getAttribute(attr);
      if (cur == null || cur.toLowerCase() !== 'currentcolor') continue;
      el.setAttribute(marker, 'currentcolor');
    }
    if (el.getAttribute(marker) === 'currentcolor') setColorAttr(el, attr, getComputedStyle(el).color);
  }
}

/** A root <svg> without a fill attribute gets its computed (CSS) fill. */
function fixRootFill(svg: Element): void {
  if (svg.parentElement?.closest('svg') != null) return; // not a root
  const marker = svg.getAttribute('data-pdiff-fill');
  if (svg.hasAttribute('fill') && marker !== 'css') return;
  const cs = getComputedStyle(svg);
  let fill = cs.fill;
  if (!fill || fill === 'none' || /^currentcolor$/i.test(fill)) fill = fill === 'none' ? 'none' : cs.color;
  if (marker == null) svg.setAttribute('data-pdiff-fill', 'css');
  setColorAttr(svg, 'fill', fill);
}

/** Copy the <symbol> that `use` points to into a nested <svg> next to it. */
function inlineUse(use: Element): void {
  const href = use.getAttribute('href') ?? use.getAttribute('xlink:href');
  const next = use.nextElementSibling;
  const copied = next?.hasAttribute('data-pdiff-use') ? next : null;
  if (href == null || !href.startsWith('#')) {
    copied?.remove();
    return;
  }
  if (copied?.getAttribute('data-pdiff-use') === href) return;
  const root = use.getRootNode() as Document | ShadowRoot;
  const id = href.slice(1);
  const symbol = root.querySelector(`[id="${CSS.escape(id)}"]`);
  if (symbol == null) return;
  const copy = document.createElementNS(SVG_NS, 'svg');
  for (const a of symbol.attributes) {
    if (a.name !== 'id') copy.setAttribute(a.name, a.value);
  }
  copy.setAttribute('data-pdiff-use', href);
  copy.setAttribute('width', '100%');
  copy.setAttribute('height', '100%');
  for (const child of symbol.childNodes) copy.appendChild(child.cloneNode(true));
  copied?.remove();
  use.after(copy);
  // The copied paths may use currentColor too.
  for (const el of copy.querySelectorAll('[fill], [stroke]')) fixCurrentColor(el);
  const svg = rootSvg(use);
  if (svg != null) changedRoots.add(svg);
}

function fixElement(el: Element): void {
  const tag = el.localName;
  if (tag === 'use') inlineUse(el);
  else if (tag === 'svg') fixRootFill(el);
  fixCurrentColor(el);
}

function scan(root: ParentNode): void {
  if (root instanceof Element) {
    if (root.matches(TARGETS)) fixElement(root);
    if (root.shadowRoot != null) watch(root.shadowRoot);
  }
  for (const el of root.querySelectorAll(TARGETS)) {
    // Skip the sprite sheet's own definitions.
    if (el.closest('symbol, defs') == null) fixElement(el);
  }
  for (const el of root.querySelectorAll(SHADOW_HOSTS)) {
    if (el.shadowRoot != null) watch(el.shadowRoot);
  }
}

function flush(): void {
  scheduled = false;
  const roots = [...dirty];
  dirty.clear();
  for (const r of roots) {
    if ((r as Node).isConnected !== false) scan(r);
  }
  version++;
  for (const root of changedRoots) root.setAttribute('data-pdiff-v', String(version));
  changedRoots.clear();
}

function markDirty(root: ParentNode): void {
  dirty.add(root);
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}

function watch(root: Document | ShadowRoot): void {
  if (watched.has(root)) return;
  watched.add(root);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n instanceof Element && !n.hasAttribute('data-pdiff-use')) markDirty(n);
        }
      } else if (r.target instanceof Element) {
        // A class or style change can change the colour of everything below
        // it; an href change points a <use> at another symbol.
        markDirty(r.target);
      }
    }
  }).observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'href'],
  });
  markDirty(root);
}

/** Fix every root again, for a change no mutation shows (a theme change
 * that only changes CSS variables). */
export function refreshSvgColors(): void {
  for (const root of watched) {
    if (root instanceof ShadowRoot && !root.host.isConnected) watched.delete(root);
    else markDirty(root);
  }
}

/** Start fixing SVG icons in the document and all shadow roots. */
export function installSvgColorFix(): void {
  watch(document);
}
