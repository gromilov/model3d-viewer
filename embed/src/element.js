/**
 * The `<model3d-viewer>` element, and the one-call `mount()`.
 *
 * Both are thin: they translate an attribute or an options object into a
 * {@link ViewerPanel} and own nothing else. They live apart from the panel
 * because a host adapter is the part most likely to be replaced -- the DSH
 * sidebar tab is a third such adapter over the same class.
 */

import { ViewerPanel } from './panel.js';
import { setBundledLocales } from './i18n.js';

/**
 * Mount a panel into an element and return it.
 *
 * @param host - element to fill; it is emptied.
 * @param options - `source` is required; see {@link ViewerPanel.defaults}.
 * @returns the panel; call `dispose()` to release it.
 */
export function mount(host, options) {
  return new ViewerPanel(host, options);
}

/**
 * The same panel as a custom element.
 *
 * A page that is not built around a bundler can then write the viewer in markup
 * and still get a WebGL canvas, which is the point of shipping it this way.
 *
 * Attributes:
 *
 *   - `src` -- URL to read.
 *   - `language` -- `en`, `ru`, or any tag the bundled dictionaries know.
 *   - `view` -- `auto` (default), `model` or `sliced`.
 *   - `name` -- override the displayed file name.
 *
 * A host that needs a source the element cannot express -- bytes, a file object,
 * a custom transport -- sets `element.source` before it is connected, or listens
 * for the `model3d-ready` event and drives the panel through `element.panel`.
 */
// `HTMLElement` does not exist outside a browser, and a class declaration is
// evaluated when the module loads. The bundle is mostly engine code that a Node
// script may well import for parsing, so the element degrades to a plain class
// there rather than making the whole module unimportable.
const ElementBase = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;

export class ModelViewerElement extends ElementBase {
  /** The panel, once connected. */
  panel = null;

  /** Overrides the `src` attribute when set before connection. */
  source = undefined;

  // A custom element is `display: inline` until something says otherwise, and an
  // inline box ignores the height of the panel inside it: the element reported
  // itself 339 pixels tall inside a stage that had asked for 420, and the canvas
  // overflowed the host's box. A viewer is a block-level object -- it fills the
  // width it is given and states its own height -- so this belongs on the element
  // rather than on every host's stylesheet.
  static get observedAttributes() {
    return ['src', 'language', 'view', 'height'];
  }

  connectedCallback() {
    if (this.panel !== null) return;
    // `display: block` is not cosmetic: an inline box ignores a height, so the
    // attribute below would have no effect without it, and the panel inside an
    // inline box reports the wrong size to everything that measures it.
    this.style.display = 'block';
    this.applyHeight();
    this.panel = new ViewerPanel(this, {
      source: this.source ?? this.getAttribute('src') ?? undefined,
      language: this.getAttribute('language') ?? undefined,
      view: this.getAttribute('view') ?? 'auto',
      fileName: this.getAttribute('name') ?? undefined,
      onStatus: (status) => {
        this.dispatchEvent(new CustomEvent('model3d-status', { detail: status }));
        if (status.kind === 'ready') {
          this.dispatchEvent(new CustomEvent('model3d-ready', { detail: status }));
        }
      },
    });
  }

  /**
   * Honour the `height` attribute.
   *
   * A host embedding the viewer in a page it controls has nowhere else to say how
   * tall the block should be, and `style="height: 420px"` would put the number in
   * the host's stylesheet rather than in the markup it already writes. A bare
   * number means pixels, which is what every other length attribute on the web
   * does when it omits the unit.
   *
   * Set on the element, as a style, rather than by writing to the panel's own box:
   * the panel computes its layout from the host's height, and a host attribute that
   * merely changed the element's outer box would leave the canvas at its old size.
   */
  applyHeight() {
    const raw = this.getAttribute('height');
    if (raw === null || raw === '') {
      this.style.removeProperty('height');
      return;
    }
    const text = String(raw).trim();
    // A bare number is pixels; anything with a unit is taken as written, so
    // `100%` and `60vh` work without special cases.
    const value = /^\d+(\.\d+)?$/.test(text) ? `${text}px` : text;
    this.style.height = value;
  }

  disconnectedCallback() {
    this.panel?.dispose();
    this.panel = null;
  }

  /**
   * Re-read when `src` changes.
   *
   * Rebuilding the panel is the honest response: a new file is a new mesh, a new
   * palette and possibly a new bed, and an in-place update would have to undo
   * every one of those. The canvas is recreated with it, which a plain update
   * could not do anyway -- a canvas keeps one WebGL context for its lifetime.
   */
  attributeChangedCallback(name, previous, next) {
    if (previous === next) return;
    // The height may be set, changed or cleared before or after connection, and it
    // is a style rather than a rebuild, so it is handled before the panel guard.
    if (name === 'height') {
      this.applyHeight();
      return;
    }
    if (this.panel === null) return;
    if (name === 'src') {
      this.panel.dispose();
      this.panel = null;
      this.connectedCallback();
    }
  }
}

/**
 * Register the element, once.
 *
 * A guard rather than a bare `customElements.define`: a page may include the
 * script twice, and defining the same tag twice throws, which would break the
 * second include for no reason.
 *
 * @param tagName - tag to register; defaults to `model3d-viewer`.
 * @returns whether the element is registered under that name now.
 */
export function defineModelViewer(tagName = 'model3d-viewer') {
  if (typeof customElements === 'undefined') return false;
  if (customElements.get(tagName) !== undefined) return true;
  customElements.define(tagName, ModelViewerElement);
  return true;
}

/**
 * Attach the bundled dictionaries for every panel, element or not.
 *
 * The bundle calls this on load, so `language="ru"` works in markup and
 * `mount(..., { language: 'ru' })` works from script without a second step.
 */
export function setLocales(locales) {
  return setBundledLocales(locales);
}
