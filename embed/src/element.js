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

  static get observedAttributes() {
    return ['src', 'language', 'view'];
  }

  connectedCallback() {
    if (this.panel !== null) return;
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
    if (this.panel === null || previous === next) return;
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
