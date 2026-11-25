/**
 * DOM construction, small enough to keep the panel free of a framework.
 *
 * The panel is a control strip and a canvas. A framework's job -- diffing a
 * description against a live tree -- is not needed for that: the tree is built
 * once, and every later change updates a handful of attributes on elements whose
 * references are already held. Writing that directly is both shorter than a
 * render function that rebuilds the toolbar, and safer for the parts that must
 * not be rebuilt: a slider being dragged, or a canvas whose WebGL context dies
 * with its element.
 */

/**
 * The interface's design tokens.
 *
 * A restrained cyberpunk -- one accent, thin rules, monospaced numerals. The
 * restraint is the point: a preview is a tool, and the model is the only thing
 * allowed to be loud, so the chrome stays a dark surface, hairline borders and a
 * single cyan that appears on interactive state only. A tight scale of sizes and
 * radii, so nothing has to be invented per component.
 */
export const theme = {
  accent: '#118980',
  accentSoft: 'rgba(17, 137, 128, 0.16)',
  accentLine: 'rgba(17, 137, 128, 0.45)',
  surface: 'rgba(24, 25, 27, 0.78)',
  // A neutral graphite rather than a blue-black: the scene behind the print is a
  // work surface, and a tinted one fights the filament colours for attention.
  surfaceSolid: '#1c1d20',
  hairline: 'rgba(255, 255, 255, 0.10)',
  hairlineStrong: 'rgba(255, 255, 255, 0.18)',
  text: '#d6d8db',
  textDim: 'rgba(214, 216, 219, 0.52)',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
};

/**
 * The toolbar's icons, drawn as inline SVG.
 *
 * Every button used to be a word, which cost horizontal room in a narrow panel
 * and read as a paragraph rather than as tools. A stroke drawing at the same
 * weight as the borders carries the same meaning in a fraction of the width, and
 * the label survives as the tooltip and the accessible name.
 *
 * One path set, drawn at 16 units and scaled by the caller: strokes inherit the
 * button's colour through `currentColor`, so a pressed button's icon lights up
 * with the same accent as the toolbar's state.
 */
export const ICONS = {
  // A circular arrow: back to the default view. The corner marks it once had
  // were indistinguishable from the "fit" icon at this size.
  reset: 'M13 8a5 5 0 1 1-1.5-3.6 M13 2v3h-3',
  // A cube in isometric: the model itself.
  model: 'M8 2l5.5 3.2v6.6L8 15l-5.5-3.2V5.2L8 2 M8 2v6.5 M8 8.5L2.5 5.2 M8 8.5l5.5-3.3 M8 8.5V15',
  // A sun: the material's studio light.
  lighting: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5 M8 1v1.6 M8 13.4V15 M1 8h1.6 M13.4 8H15 M3.1 3.1l1.1 1.1 M11.8 11.8l1.1 1.1 M12.9 3.1l-1.1 1.1 M4.2 11.8l-1.1 1.1',
  // A flat grid in perspective: the build plate.
  bed: 'M1.5 10.5l2-4h9l2 4v3h-13v-3 M1.5 10.5h13',
  // A camera: render the scene to an image.
  snapshot: 'M2 5.5h2.6L6 3.5h4l1.4 2H14v8H2v-8 M8 12a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 1 0 0 5.2',
  // A small triangle stack: plain shading.
  plain: 'M8 2l6 11H2L8 2 M8 6.5l3 6.5H5l3-6.5',
  // A four-pointed star: light given off, which is what tracing adds. Drawn after
  // trying ray-plus-surface shapes, which all read as either scissors or a pile
  // of unrelated strokes at 16px -- this one survives the size.
  trace: 'M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5L8 2',
  // The same star, smaller, beside a downward arrow: that frame, written to a file.
  saveTraced: 'M6.6 2.4l1.15 3.45L11.2 7l-3.45 1.15L6.6 11.6L5.45 8.15L2 7l3.45-1.15L6.6 2.4 M12.4 9.4v4.2 M10.6 11.8l1.8 1.8 1.8-1.8',
  // A play triangle, and the pause that replaces it while the print is running.
  // Filled rather than stroked at this size -- a stroked triangle reads as an
  // outline of a shape instead of a transport control.
  play: 'M5 3l7 5-7 5z',
  pause: 'M5 3h2.5v10H5z M8.5 3H11v10H8.5z',
  // A turntable: an open arc with an arrowhead and a body sitting inside it, so
  // it reads as "go round the object" rather than as the reset arrow it is
  // otherwise identical to.
  motion: 'M12.6 8a4.6 4.6 0 1 1-1.4-3.3 M12.6 2.2v3h-3 M8 6.4l2 1.6-2 1.6z',
  // A plus, for recording one more view.
  plus: 'M8 3.5v9 M3.5 8h9',
  // A cross in a small frame: delete this view.
  trash: 'M3 4.5h10 M6.2 4.5V3h3.6v1.5 M4.4 4.5l.6 8h6l.6-8 M6.6 7v3.4 M9.4 7v3.4',
  // A cross: dismissing a window. Two strokes rather than a glyph, so it stays
  // crisp at 10 pixels inside a colour window's head.
  close: 'M4 4l8 8 M12 4l-8 8',
  // A pipette: sampling a colour off the screen. The body is a slanted barrel
  // with a drop at the tip -- drawn after a droplet alone, which read as weather.
  eyedropper: 'M10.2 3.4l2.4 2.4 M11.4 2.2a1.7 1.7 0 0 1 2.4 2.4l-1.3 1.3-2.4-2.4 1.3-1.3 M10.1 5.9l-5.4 5.4-.7 2.6 2.6-.7 5.4-5.4',
};

/**
 * Icons that are filled rather than stroked.
 *
 * OrcaSlicer's layers glyph is a solid isometric stack -- a rhombus for the top
 * plate and two chevrons for the ones beneath -- and drawn as an outline it reads
 * as a wireframe box instead. Kept in a second table so the stroked icons stay a
 * plain map, and so an entry here can never be accidentally rendered hollow.
 */
export const SOLID_ICONS = {
  // Proportions measured from the reference: a 28-pixel rhombus over two 11-pixel
  // bands, with gaps about a third of a band's thickness.
  layers: 'M8 1.2 L14.4 4.4 L8 7.6 L1.6 4.4 Z '
    + 'M1.6 6.6 L8 9.8 L14.4 6.6 L14.4 8.6 L8 11.8 L1.6 8.6 Z '
    + 'M1.6 9.6 L8 12.8 L14.4 9.6 L14.4 11.6 L8 14.8 L1.6 11.6 Z',
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** One icon, sized to the interface and coloured by its parent through `currentColor`. */
export function icon(name, size = 16) {
  const solid = SOLID_ICONS[name];
  const path = solid ?? ICONS[name];
  if (path === undefined) return null;
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  // A solid glyph is filled and has no stroke; a stroked one is the reverse. Both
  // take their colour from the parent, so a filled icon behaves like the rest.
  svg.setAttribute('fill', solid === undefined ? 'none' : 'currentColor');
  svg.setAttribute('stroke', solid === undefined ? 'currentColor' : 'none');
  svg.setAttribute('stroke-width', '1.25');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.display = 'block';
  // A single path is enough for every glyph here; the cube and the sun are one
  // `d` with subpaths, which keeps the icon table a plain map of strings.
  const shape = document.createElementNS(SVG_NAMESPACE, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

/**
 * Create one element.
 *
 * `attributes` covers the cases that come up in this panel: `style` as an
 * object, event handlers by their `on...` name, `dataset` for `data-*`, and
 * everything else as an attribute. It is deliberately not a general-purpose
 * abstraction -- properties like `value` are set by the caller, because a
 * slider's `value` and its `value` attribute mean different things.
 *
 * @param tag - element name.
 * @param attributes - see above.
 * @param children - nodes, strings, or nested arrays of them; `null` is skipped
 *   so a conditional child reads as `condition ? node : null`.
 */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);

  // A default parameter only covers `undefined`, and `el('span', null, …)` is the
  // natural way to say "no attributes" -- it read as working until it threw
  // "Cannot convert undefined or null to object" from this line. Tolerated here
  // rather than corrected at each of the call sites.
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue;
    if (key === 'style') {
      Object.assign(node.style, value);
    } else if (key === 'dataset') {
      for (const [name, entry] of Object.entries(value)) {
        if (entry !== undefined) node.dataset[name] = String(entry);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      // `onClick` -> `click`, `onPointerDown` -> `pointerdown`.
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else if (value === false) {
      // A false state is an absent attribute, not the string "false".
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/** Append children, flattening arrays and skipping empty ones. */
export function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
    } else if (typeof child === 'string' || typeof child === 'number') {
      node.append(document.createTextNode(String(child)));
    } else {
      node.append(child);
    }
  }
  return node;
}

/**
 * Position a popover against the control that opened it.
 *
 * Shared by the colour window and the motion window, because the rule is the
 * same and a second copy of it would drift: align with the anchor, pull the box
 * back inside the host's bounds on whichever side it overflows, open upwards when
 * there is no room below, and cap the height to the host so a short sidebar
 * scrolls the popover rather than hiding its buttons.
 *
 * Both measurements are taken while the node is visible: a hidden element reports
 * a zero-sized box, and a popover placed from that lands in the corner.
 *
 * @param node - the popover, already shown and already in the document.
 * @param anchor - the control it belongs to; the host's corner when omitted.
 * @param gap - space between the anchor and the popover.
 * @param margin - space kept from the host's edges.
 */
export function placePopover(node, anchor, gap = 6, margin = 8) {
  const host = node.parentElement;
  if (host === null) return;
  const hostBox = host.getBoundingClientRect();
  const box = node.getBoundingClientRect();

  let left = margin;
  let top = margin;
  if (anchor !== undefined && anchor !== null) {
    const a = anchor.getBoundingClientRect();
    left = a.left - hostBox.left;
    left = Math.min(left, hostBox.width - box.width - margin);
    left = Math.max(margin, left);
    const below = a.bottom - hostBox.top + gap;
    const above = a.top - hostBox.top - box.height - gap;
    if (below + box.height <= hostBox.height - margin) top = below;
    else if (above >= margin) top = above;
    else top = Math.max(margin, Math.min(below, hostBox.height - box.height - margin));
  }
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
  node.style.maxHeight = `${Math.round(hostBox.height - margin * 2)}px`;
}

/** Remove every child, keeping the element itself (and its listeners). */
export function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
  return node;
}

/** Set text only when it changed, so a repaint does not reset a selection. */
export function setText(node, text) {
  const next = String(text);
  if (node.textContent !== next) node.textContent = next;
}

/** Coalesce repeated state changes into one repaint on the next frame. */
export function frameScheduler(callback) {
  let handle = 0;
  return () => {
    if (handle !== 0) return;
    const request = globalThis.requestAnimationFrame ?? ((fn) => globalThis.setTimeout(fn, 16));
    handle = request(() => {
      handle = 0;
      callback();
    });
  };
}
