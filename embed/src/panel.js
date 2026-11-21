/**
 * The viewer panel: the interface around one WebGL canvas, with no framework.
 *
 * The panel is a plain class over DOM nodes. It was a React component, and the
 * engine under it never needed React at all -- the canvas, the parser and the
 * shaders were always framework-free. Splitting them means the same interface can
 * be a DSH sidebar tab, an element on a page, or a widget inside someone else's
 * app, and only the outermost adapter changes.
 *
 * The division of labour:
 *
 *   - the engine (`viewer.js`, `parsers.js`, …) owns the GPU and knows nothing
 *     about buttons;
 *   - this panel owns the toolbar, the sliders, the layer track and the cube; it
 *     holds every piece of interface state and drives the engine through its
 *     methods;
 *   - a host adapter (the DSH plugin, the custom element, `mount()`) owns the
 *     read and decides where the panel's box goes.
 *
 * State lives on the instance rather than in a render function, and a change
 * updates the specific node that depends on it. That is deliberate: rebuilding
 * the toolbar would destroy the node a slider is currently dragging, and
 * replacing the canvas would destroy its WebGL context -- a canvas hands out one
 * context for its lifetime, and a replaced one is a new element.
 */

import { append, clear, el, icon, setText, theme } from './dom.js';
import { createTranslator, getBundledLocales, pickDictionary } from './i18n.js';
import { createLoader } from './loader.js';
import { parseModel } from './parsers.js';
import { createViewer } from './viewer.js';
import { buildBvh } from './bvh.js';
import { createTracer, createStillRender } from './tracer.js';
import { createCube } from './cube.js';
import { injectStyles } from './styles.js';
import {
  STORE_VERSION,
  createLocalStore,
  createMemoryStore,
  debounce,
  keyOf,
  parseSnapshot,
  serialise,
  validateSnapshot,
} from './persist.js';

/**
 * Format one dimension triple for the stats line.
 *
 * Millimetres to one decimal below a hundred and none above it: a print is
 * measured to a tenth of a millimetre, but a long axis does not need the digit
 * and the line has to stay short in a narrow panel.
 */
export function formatSize(size) {
  const round = (value) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1));
  return `${round(size[0])} × ${round(size[1])} × ${round(size[2])} mm`;
}

/** A `#rrggbb` string as three unit floats; black for anything unparseable. */
function hexTriple(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (match === null) return [0, 0, 0];
  return [
    parseInt(match[1].slice(0, 2), 16) / 255,
    parseInt(match[1].slice(2, 4), 16) / 255,
    parseInt(match[1].slice(4, 6), 16) / 255,
  ];
}

/** The backgrounds a slicer's preview offers, plus "no colour" for the default. */
export const BACKGROUNDS = [
  { value: null, labelKey: 'controls.backgroundAuto' },
  { value: '#1e2228', labelKey: 'controls.backgroundDark' },
  { value: '#2b3138', labelKey: 'controls.backgroundSlate' },
  { value: '#4a5159', labelKey: 'controls.backgroundGrey' },
  { value: '#dfe3e8', labelKey: 'controls.backgroundLight' },
  { value: '#ffffff', labelKey: 'controls.backgroundWhite' },
];

/** The surface a filament starts with, matching the engine's own default. */
const DEFAULT_SURFACE = { matte: 0.5, metalness: 0, transparency: 0 };

/**
 * The panel.
 *
 * Construct with a host element and a configuration; it builds its DOM
 * immediately and starts reading the source. Everything after that is methods or
 * events -- there is no re-render, so a host never has to know when to call one.
 */
export class ViewerPanel {
  /**
   * @param host - element the panel fills. It is emptied first.
   * @param options - see {@link ViewerPanel.defaults}.
   */
  constructor(host, options = {}) {
    if (host === undefined || host === null) {
      throw new Error('ViewerPanel needs a host element');
    }
    this.host = host;
    this.options = { ...ViewerPanel.defaults, ...options };
    this.disposed = false;

    // Dictionaries: the host may pass a translator outright, or a language tag to
    // pick one of the bundled sets, or nothing at all (English). The bundled sets
    // are the build's own default, so a page that includes the script gets both
    // languages without wiring anything.
    const dictionaries = this.options.locales ?? getBundledLocales() ?? {};
    this.dictionary = pickDictionary(
      Object.keys(dictionaries).length > 0 ? dictionaries : { en: {} },
      this.options.language,
    );
    this.t = typeof this.options.t === 'function'
      ? this.options.t
      : createTranslator(this.dictionary, dictionaries.en);

    // State. Grouped so it can be read, compared and reset in one place.
    this.state = {
      /** 'loading' | 'ready' | 'failed' */
      kind: 'loading',
      message: '',
      mesh: null,
      sliced: null,
      view: 'model',
      layers: null,
      oneLayer: false,
      /** Where the cut was when the one-layer switch was last on. */
      lastCut: 0,
      bed: { available: false, visible: false },
      background: null,
      plainLighting: true,
      paletteOverrides: {},
      surfaces: [],
      activeSlot: 0,
      lightLevel: 1,
      renderer: null,
      /** Whether the traced view is showing, and how far it has got. */
      tracing: false,
      traceSamples: 0,
      /** A message when tracing cannot run at all. */
      traceError: null,
    };

    this.viewer = null;
    this.cube = null;
    this.unwatchOrbit = null;
    /** Aborts the read when the panel goes away. */
    this.readController = null;

    /** The acceleration structure the traced view is built from, kept for exports. */
    this.bvh = null;
    /** The live tracer, and the canvas overlay it presents through. */
    this.traceCanvas = null;
    /** The export in flight: its own handle, timer and canvas, none of them shared. */
    this.stillRender = null;
    this.traceExportHandle = undefined;
    /** The one pending wakeup for the next trace pass: a frame, and its watchdog. */
    this.traceFrameHandle = undefined;
    this.traceTimer = undefined;

    // Settings storage. A panel with `remember: false` still gets a store to talk
    // to, so every save path below is unconditional and there is no second shape of
    // panel to reason about.
    this.settings = this.openSettings();

    this.build();
    this.load();
  }

  /**
   * How many passes to trace before stopping.
   *
   * A soft shadow needs on the order of sixty samples to lose its grain, and the
   * accumulation is cheap enough that going further mostly reduces noise rather
   * than revealing anything. The number is a constant so the image settles in
   * about a second rather than running until someone looks away.
   */
  static maxTraceSamples = 96;

  /**
   * How long to wait for a frame before assuming none is coming, in milliseconds.
   *
   * Only a backstop, for a page that presents nothing: a background tab, a headless
   * run. On a page that does present, the frame callback fires in about sixteen
   * milliseconds and always wins.
   *
   * It does not have to be longer than a pass. The race between this and the frame
   * callback is harmless now that the pass itself refuses to run twice -- an earlier
   * version had no such guard, so a slow pass let the timer fire, and the frame
   * callback it had beaten ran afterwards as a second pass chain. Making this number
   * larger would have hidden that rather than fixed it, and would have made a
   * non-presenting page ten times slower per sample.
   */
  static traceWatchdog = 100;

  /**
   * Width of an exported traced image.
   *
   * 1024 rather than 2048 because the tracer holds six render targets and needs a
   * second full set for the export: at 2048 that is about 150 MB per set, and the
   * two together exceeded what the context would allocate, which made the export
   * quietly produce a blank file. At 1024 the set is 38 MB and both fit, and the
   * denoiser means 1024 looks better than an unfiltered 2048 would.
   */
  static traceExportWidth = 1024;

  /**
   * Samples for an exported image.
   *
   * Higher than the interactive budget: nobody is watching a file converge, and
   * the denoiser has more to work with. 160 is where the remaining grain is below
   * what a PNG at this size shows.
   */
  static traceExportSamples = 160;

  /**
   * Samples traced per slice of an export.
   *
   * Four keeps a slice's own cost under about half a second at 1024 px on this
   * machine, and the synchronisation at the end of it is what makes that a real
   * bound rather than a hope. Larger slices make each stall longer without making
   * the run shorter -- the work is the same and it is now actually waited for.
   */
  static traceExportSlice = 4;

  /**
   * Gap between export slices, in milliseconds.
   *
   * A timer rather than an animation frame: a background tab presents no frames, and
   * an export that stalled because nobody was looking at it would never finish. Zero
   * because the slice itself already yields -- the timer exists to get back into the
   * event loop, not to pause in it.
   */
  static traceExportInterval = 0;

  /** Configuration defaults, overridable per instance. */
  static defaults = {
    /** Source: URL, File, bytes, or a host loader function. */
    source: undefined,
    /** Extra `RequestInit` for the fetch path. */
    requestInit: undefined,
    /** Announce the file's basename in the toolbar. */
    showName: false,
    /** 'auto' | 'model' | 'sliced' -- which view to open when it exists. */
    view: 'auto',
    /** AbortSignal owned by the host. */
    signal: undefined,
    /** Host translator `(key, params) => string`. */
    t: undefined,
    /** Language tag for the bundled dictionaries. */
    language: undefined,
    /** Bundled dictionaries, keyed by language id. */
    locales: undefined,
    /** Optional callback when the panel wants to be told something. */
    onStatus: undefined,
    /**
     * Remember this file's view between visits.
     *
     * `true` uses the browser's `localStorage`; a store object from
     * `createLocalStore`/`createMemoryStore` lets a host choose the place; `false`
     * turns it off. Off is a reasonable choice for a page showing a sample model,
     * where remembering is noise rather than help.
     */
    remember: true,
    /** Explicit key for the settings; derived from `source` when absent. */
    storageKey: undefined,
  };

  /* -------------------------------------------------------------- settings -- */

  /**
   * Open the store this panel will remember into.
   *
   * `remember` accepts three things, because three are genuinely useful: `true`
   * for the browser's own storage, `false` for a panel that should always open
   * fresh, and a store object for a host that wants to choose the place -- a
   * shared prefix per user, an in-memory store for a preview, or its own backend.
   *
   * @returns `{ store, key, enabled }`; `key` is `undefined` when the source has
   *   no stable identity, which disables remembering rather than guessing at one.
   */
  openSettings() {
    const { remember, storageKey, source } = this.options;
    if (remember === false || remember === undefined || remember === null) {
      return { store: createMemoryStore(), key: undefined, enabled: false };
    }
    // A provided store is duck-typed rather than checked by class: a host may pass
    // anything that reads and writes strings.
    const store = typeof remember === 'object' && remember !== null && typeof remember.read === 'function'
      ? remember
      : createLocalStore();

    const key = keyOf(source, storageKey);
    if (key === undefined) {
      // No identity to hang settings on. Remembering under a shared key would
      // apply one file's material to another's, which is worse than forgetting.
      return { store, key: undefined, enabled: false };
    }
    return { store, key, enabled: true };
  }

  /** The stored snapshot for this file, or `null`. */
  readSettings() {
    const { store, key, enabled } = this.settings;
    if (!enabled) return null;
    return parseSnapshot(store.read(key));
  }

  /**
   * The settings as they are now.
   *
   * `colour` is the first filament's colour rather than the whole palette: the
   * overrides already carry a recolour, and duplicating them here would let the two
   * disagree about which one wins.
   */
  snapshot() {
    const { state, viewer } = this;
    return {
      version: STORE_VERSION,
      view: state.view,
      plainLighting: state.plainLighting,
      bedVisible: state.bed.visible,
      background: state.background,
      colour: state.surfaces[0] === undefined ? undefined : state.surfaces[0].colour,
      layerRange: state.layers === null ? undefined : state.layers.range,
      dimBelow: state.layers === null ? undefined : state.layers.dim,
      camera: viewer === null ? undefined : viewer.orientation(),
      surfaces: state.surfaces.length === 0 ? undefined : state.surfaces,
      lightLevel: state.lightLevel,
      paletteOverrides: Object.keys(state.paletteOverrides).length === 0
        ? undefined
        : state.paletteOverrides,
    };
  }

  /**
   * Queue a save.
   *
   * Debounced, because a camera drag changes the orbit on every pointer move and
   * `localStorage` writes are synchronous. `flush` runs on teardown so the last
   * position is not lost to a pending timer.
   */
  queueSave() {
    this.saveSoon ??= debounce(() => this.writeSettings(), 400);
    this.saveSoon.call();
  }

  /** Run a pending save now, if there is one. */
  flushSave() {
    this.saveSoon?.flush();
  }

  /** Write the current settings immediately. */
  writeSettings() {
    const { store, key, enabled } = this.settings;
    if (!enabled) return;
    store.write(key, serialise(this.snapshot()));
  }

  /**
   * Apply a stored snapshot.
   *
   * Called once the file is ready and the viewer exists, because most of it is
   * expressed through the viewer. Order matters: the view decides which mesh and
   * how many layers there are, so it is applied first and the layer range after.
   */
  applySettings() {
    const saved = this.readSettings();
    if (saved === null) {
      // Nothing stored is the normal first run, and it still has to leave the
      // controls showing the scene's actual values. Returning early skipped the
      // sync at the end, so the sliders kept whatever the constructor put in them
      // -- an empty value label beside a thumb at the minimum.
      this.syncSurfaceControls();
      return;
    }

    if (saved.plainLighting !== undefined) {
      this.state.plainLighting = saved.plainLighting;
      this.viewer?.setPlainLighting(saved.plainLighting);
    }
    if (saved.background !== undefined) {
      this.state.background = saved.background;
      this.viewer?.setBackground(saved.background);
      this.backgroundPicker.setValue(saved.background);
    }
    if (saved.surfaces !== undefined) {
      saved.surfaces.forEach((surface, slot) => {
        this.state.surfaces[slot] = surface;
        this.viewer?.setSurface(slot, surface);
      });
    }
    if (saved.lightLevel !== undefined) {
      this.state.lightLevel = saved.lightLevel;
      this.viewer?.setLightLevel(saved.lightLevel);
    }
    if (saved.paletteOverrides !== undefined) {
      this.state.paletteOverrides = { ...saved.paletteOverrides };
      this.applyPalette();
    }
    if (saved.bedVisible !== undefined) {
      const info = this.viewer?.bedInfo();
      if (info?.available === true) {
        this.viewer.setBedVisible(saved.bedVisible);
        this.state.bed = this.viewer.bedInfo();
      }
    }
    if (saved.camera !== undefined) {
      this.viewer?.setOrbit(saved.camera.yaw, saved.camera.pitch);
    }
    // The layer range is applied after the view, since a different mesh has a
    // different number of layers and the stored range may no longer fit.
    if (saved.layerRange !== undefined && this.state.layers !== null) {
      const [from, to] = saved.layerRange;
      const last = this.state.layers.count - 1;
      if (from <= last && to <= last) {
        this.viewer?.setLayerRange(from, to, { dim: saved.dimBelow === true });
        const info = this.viewer.layerInfo();
        this.state.layers = { count: info.count, range: info.range, dim: info.dim };
      }
    }

    this.syncToolbar();
    this.syncPalette();
    this.syncBed();
    this.syncBedButton();
    this.syncLayerSlider();
    this.syncSurfaceControls();
  }

  /* ------------------------------------------------------------ DOM build -- */

  /** Build the panel's tree once. Every later change mutates it in place. */
  build() {
    const { t } = this;
    const owner = this.host.ownerDocument ?? document;
    this.document = owner;
    // The sheet is shared by every panel in the document and injected once, so
    // opening and closing tabs does not grow the document without bound.
    injectStyles(owner);

    this.root = el('section', {
      'data-model3d-viewer': true,
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' },
    });

    // --- toolbar ---------------------------------------------------------
    this.resetButton = this.button({ icon: 'reset', label: t('controls.reset'), onClick: () => this.reset() });
    this.segmented = el('span', { class: 'm3d-seg', role: 'group', 'aria-label': t('controls.model') });
    this.segmented.hidden = true;
    this.segmentedButtons = {
      model: this.button({ icon: 'model', label: t('controls.model'), onClick: () => this.setView('model'), segment: true }),
      sliced: this.button({ icon: 'sliced', label: t('controls.sliced'), onClick: () => this.setView('sliced'), segment: true }),
    };
    this.segmented.append(this.segmentedButtons.model, this.segmentedButtons.sliced);

    this.lightingButton = this.button({
      icon: 'lighting',
      label: t('controls.lighting'),
      toggle: true,
      onClick: () => this.togglePlainLighting(),
    });
    this.bedButton = this.button({
      icon: 'bed',
      label: t('controls.bed'),
      toggle: true,
      onClick: () => this.toggleBed(),
    });
    this.bedButton.hidden = true;
    this.snapshotButton = this.button({ icon: 'snapshot', label: t('controls.snapshot'), onClick: () => this.saveImage() });
    // Tracing replaces the interactive view rather than sitting beside it: the two
    // are the same scene, and showing both would halve the space for each. The
    // button toggles, and the overlay can be dismissed with it.
    this.traceButton = this.button({
      icon: 'trace',
      label: t('controls.trace'),
      toggle: true,
      onClick: () => this.toggleTrace(),
    });
    // Saving a traced image is a different act from saving the rasterised one: the
    // first is a converged render at export size, the second is the interactive
    // frame. Both stay, and only the relevant one is shown.
    this.saveTracedButton = this.button({
      icon: 'saveTraced',
      label: t('controls.saveTraced'),
      onClick: () => this.saveTracedImage(),
    });
    this.saveTracedButton.hidden = true;

    this.backgroundPicker = new BackgroundPickerControl({ t, onChange: (value) => this.setBackground(value) });
    this.paletteControl = new PaletteControl({
      t,
      onChange: (slot, hex) => this.setFilament(slot, hex),
      onSelect: (slot) => this.selectSlot(slot),
    });

    this.statsNode = el('span', { class: 'm3d-stats' });

    this.toolbar = el('div', { class: 'm3d-toolbar' }, [
      this.resetButton,
      this.segmented,
      this.lightingButton,
      this.bedButton,
      this.snapshotButton,
      this.traceButton,
      this.saveTracedButton,
      this.backgroundPicker.node,
      this.paletteControl.node,
      this.statsNode,
    ]);

    // --- surface row (material mode only) --------------------------------
    this.matteSlider = new SliderControl({
      t,
      labelKey: 'controls.matte',
      min: 0.04,
      max: 1,
      step: 0.02,
      onChange: (value) => this.setSurface(this.state.activeSlot, { matte: value }),
    });
    this.metalnessSlider = new SliderControl({
      t,
      labelKey: 'controls.metalness',
      min: 0,
      max: 1,
      step: 0.02,
      onChange: (value) => this.setSurface(this.state.activeSlot, { metalness: value }),
    });
    this.transparencySlider = new SliderControl({
      t,
      labelKey: 'controls.transparency',
      min: 0,
      max: 1,
      step: 0.02,
      onChange: (value) => this.setSurface(this.state.activeSlot, { transparency: value }),
    });
    // The studio's own level, separate from any filament: how bright the light
    // is, not how a material answers it.
    this.lightSlider = new SliderControl({
      t,
      labelKey: 'controls.lightLevel',
      min: 0.2,
      max: 2,
      step: 0.05,
      onChange: (value) => this.setLightLevel(value),
    });
    this.surfaceRow = el('div', { class: 'm3d-surface-row' }, [
      this.matteSlider.node,
      this.metalnessSlider.node,
      this.transparencySlider.node,
      this.lightSlider.node,
    ]);
    this.surfaceRow.hidden = true;

    // --- stage -----------------------------------------------------------
    this.stage = el('div', { class: 'm3d-stage' });
    this.status = el('p', { class: 'm3d-status', role: 'alert' });
    this.stage.append(this.status);

    this.canvas = null;
    this.layerSlider = null;
    this.navCube = null;

    append(this.root, [this.toolbar, this.surfaceRow, this.stage]);
    clear(this.host);
    this.host.append(this.root);

    this.syncToolbar();
    this.showStatus(t('status.loading'));
  }

  /** Create one toolbar button. */
  button({ icon: name, label, onClick, toggle = false, segment = false }) {
    const node = el('button', {
      type: 'button',
      class: segment ? 'm3d-btn' : 'm3d-btn',
      title: label,
      'aria-label': label,
      onClick,
    }, icon(name));
    if (toggle) node.setAttribute('aria-pressed', 'false');
    if (segment) node.setAttribute('aria-pressed', 'false');
    return node;
  }

  /* ---------------------------------------------------------------- read -- */

  /**
   * Read, parse and show the source.
   *
   * The read is aborted when the panel is disposed, so a tab closed mid-load does
   * not resolve into a viewer whose canvas has already gone.
   */
  async load() {
    const controller = new AbortController();
    this.readController = controller;
    const loader = createLoader(this.options.source, {
      requestInit: this.options.requestInit,
      signal: controller.signal,
    });
    this.setLoading(true);
    try {
      const { name, bytes, parsed: prebuilt } = await loader();
      if (this.disposed) return;
      // A host may have parsed the file already; parsing again would inflate a
      // 3 MF a second time for no gain.
      const raw = prebuilt ?? parseModel(name, bytes);
      // The parser has two success shapes and they must be reconciled here.
      // An STL or a 3MF yields `{ mesh, sliced? }`; a bare G-code file yields the
      // drawing itself, because a sliced plate is not a triangle mesh and has no
      // unwrapped model to go with it. Reading `.mesh` off that is `undefined`,
      // which is what once made opening a `.gcode` fail with "cannot read
      // triangles of undefined".
      const parsed = raw.mesh === undefined && raw.sliced === undefined
        ? { mesh: raw, sliced: undefined }
        : raw;
      if (this.disposed) return;
      this.setState({ kind: 'ready', mesh: parsed.mesh, sliced: parsed.sliced ?? null, message: '' });
      this.instantiateViewer();
      // Prefer the sliced view when the file carries one: that is the view the
      // file was saved to show, and the model is one click away.
      const wanted = this.options.view;
      // A 3 MF may carry both a model and a sliced plate, so the two are separate
      // views. A bare G-code has only strokes, and they *are* the sliced view: a
      // "model" view of it would be the same drawing without its layer slider.
      const inherentlySliced = parsed.sliced === undefined && parsed.mesh?.kind === 'segments';
      const startOn = wanted === 'sliced' ? 'sliced'
        : wanted === 'model' ? 'model'
          : (parsed.sliced !== undefined || inherentlySliced ? 'sliced' : 'model');
      this.applyView(startOn);
      // The stored view is applied after the default one, because it may point at
      // a different view of the same file -- and because the defaults are what a
      // file with nothing stored should open on.
      this.applySettings();
      this.options.onStatus?.({ kind: 'ready', name, mesh: parsed.mesh, sliced: parsed.sliced });
    } catch (error) {
      if (this.disposed || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ kind: 'failed', message });
      this.showStatus(`${this.t('status.failed')} — ${message}`);
      this.options.onStatus?.({ kind: 'failed', message });
    } finally {
      if (this.readController === controller) this.readController = null;
      // Loading is over on every path. Nothing ever cleared this flag, so the
      // reset button -- which is disabled while loading -- stayed disabled for the
      // whole life of the panel, on a file that had loaded perfectly.
      this.setLoading(false);
    }
  }

  /** Build the viewer and its canvas once the bytes are known to be good. */
  instantiateViewer() {
    this.clearStage();
    const canvas = el('canvas', { class: 'm3d-canvas', 'data-model3d-canvas': true });
    this.stage.append(canvas);
    this.canvas = canvas;

    try {
      this.viewer = createViewer(canvas);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ kind: 'failed', message });
      this.showStatus(`${this.t('status.failed')} — ${message}`);
      return;
    }
    // The viewer starts on the studio material; the interface starts on plain
    // shading, so the two are reconciled here rather than at first click.
    this.viewer.setPlainLighting(this.state.plainLighting);
    this.state.renderer = this.viewer.renderer();
    // Watch the camera rather than saving from `setOrbit`: a drag never calls
    // `setOrbit`, and the drag is the case worth remembering. Debounced, so a
    // gesture costs one write instead of one per pointer move.
    this.unwatchCamera = this.viewer.watchOrbit(() => this.queueSave());

  }

  /** Remove the canvas, the overlays and the viewer. */
  clearStage() {
    // Stops the pass loop and abandons any export in flight with it.
    this.stopTrace();
    this.bvh = null;
    if (this.tracer !== null && this.tracer !== undefined) {
      this.tracer.dispose();
      this.tracer = null;
    }
    if (this.traceCanvas !== null && this.traceCanvas !== undefined) {
      this.traceCanvas.remove();
      this.traceCanvas = null;
    }
    if (this.layerSlider !== null) {
      this.layerSlider.dispose();
      this.layerSlider = null;
    }
    if (this.navCube !== null) {
      this.navCube.dispose();
      this.navCube = null;
    }
    this.unwatchOrbit?.();
    this.unwatchOrbit = null;
    this.unwatchCamera?.();
    this.unwatchCamera = null;
    if (this.viewer !== null) {
      this.viewer.dispose();
      this.viewer = null;
    }
    this.canvas = null;
    clear(this.stage);
  }

  /* --------------------------------------------------------------- state -- */

  /** Merge a patch into the state and repaint what depends on it. */
  setState(patch) {
    Object.assign(this.state, patch);
    this.syncToolbar();
  }

  setLoading(loading) {
    this.loading = loading;
    this.syncToolbar();
  }

  /* ---------------------------------------------------------------- view -- */

  /** Switch between the model and the sliced plate. */
  setView(view) {
    if (view === this.state.view) return;
    this.applyView(view);
  }

  /**
   * Apply a view, rebuilding the mesh binding when the plate changes.
   *
   * Both views share one viewer and one canvas: a canvas has a single WebGL
   * context, so the two are the same drawing surface with a different mesh, not
   * two surfaces toggled.
   */
  applyView(view) {
    const { state, viewer } = this;
    if (state.kind !== 'ready') return;
    const mesh = view === 'sliced' ? state.sliced ?? state.mesh : state.mesh;
    if (mesh === null || mesh === undefined) return;
    Object.assign(state, { view });

    viewer?.setMesh(mesh);
    const info = viewer?.layerInfo() ?? { count: 0, range: [0, 0], dim: false };
    state.layers = info.count > 0 ? { count: info.count, range: info.range, dim: info.dim } : null;
    state.oneLayer = false;
    state.lastCut = 0;
    state.bed = viewer?.bedInfo() ?? { available: false, visible: false };
    state.paletteOverrides = {};
    // The viewer owns the material of each filament; the panel's copy is what the
    // sliders edit and what gets stored. Without this the panel kept an empty array
    // and the sliders fell back to defaults that matched nothing on screen -- so
    // dragging one jumped the material to the slider's position instead of starting
    // from what was already there.
    const owned = viewer?.surfaceInfo();
    if (owned !== undefined) {
      state.surfaces = owned.surfaces;
      state.lightLevel = owned.lightLevel;
    }

    this.syncToolbar();
    this.syncPalette();
    this.syncBed();
    this.syncBedButton();
    this.syncLayerSlider();
    this.syncSurfaceControls();
    this.queueSave();
  }

  /* -------------------------------------------------------------- tracing -- */

  /**
   * Turn the traced view on or off.
   *
   * Tracing is offered as a mode rather than a button that writes a file: the
   * interesting part is watching the image settle, and comparing it against the
   * live view. A file is one more click from here.
   */
  toggleTrace() {
    if (this.state.tracing) {
      this.stopTrace();
      return;
    }
    this.startTrace();
  }

  /**
   * Begin tracing the current view.
   *
   * The camera is frozen at the moment of the click, which is what makes the
   * accumulation converge: a moving camera would smear successive samples across
   * different frames. The overlay says so by taking over the canvas.
   */
  startTrace() {
    const { viewer } = this;
    if (viewer === null || this.canvas === null) return;
    const scene = viewer.sceneState();
    if (scene.mesh === null || scene.mesh === undefined) return;

    // The tree is built from the same normalised geometry the rasteriser draws, so
    // the traced frame lines up with the view that was on screen.
    let bvh;
    try {
      // The builder prefers a scale stated on the mesh over the one it derives, so
      // the viewer's own normalisation is handed to it rather than recomputed: the
      // traced frame must line up with the rasterised one exactly, and two
      // implementations of the same rule are two chances to disagree.
      bvh = buildBvh({ ...scene.mesh, scale: scene.meshScale });
    } catch (error) {
      this.state.traceError = error instanceof Error ? error.message : String(error);
      this.syncToolbar();
      return;
    }

    if (bvh.primCount === 0 || bvh.nodeCount === 0) {
      // Not representable as a tree, and an empty one would make the traversal
      // loop on a root that points at itself. Nothing to trace is a message, not a
      // degenerate render.
      this.state.traceError = this.t('status.noTriangles');
      this.syncToolbar();
      return;
    }

    if (this.tracer === null || this.tracer === undefined) {
      this.traceCanvas = el('canvas', { class: 'm3d-canvas', 'data-model3d-traced': true });
      this.stage.append(this.traceCanvas);
      this.tracer = createTracer(this.traceCanvas);
      if (this.tracer === null) {
        this.state.traceError = this.t('status.traceUnavailable');
        this.traceCanvas.remove();
        this.traceCanvas = null;
        this.syncToolbar();
        return;
      }
    }

    const width = Math.max(64, this.canvas.clientWidth || 640);
    const height = Math.max(64, this.canvas.clientHeight || 480);
    this.traceCanvas.width = width;
    this.traceCanvas.height = height;
    if (!this.tracer.ensureTargets(width, height)) {
      this.state.traceError = this.t('status.traceUnavailable');
      this.syncToolbar();
      return;
    }
    this.tracer.setScene(bvh);
    this.bvh = bvh;
    // A tracer outlives the view it was made for: switching layers or coming back to
    // tracing reuses the same one, and its accumulation was built from the old camera.
    // Adding new samples on top of it would divide a buffer by a count it was not
    // drawn with, so the buffer is cleared along with the counter.
    this.tracer.restart();

    this.traceFrame = {
      eye: scene.eye,
      target: scene.target,
      up: scene.up,
      tanHalfFov: scene.tanHalfFov,
      palette: scene.palette,
      surfaces: scene.surfaces,
      paletteCount: scene.paletteCount,
      lightLevel: scene.lightLevel,
      plainLighting: scene.plainLighting,
      lightRadius: 0.08,
      // Two bounces: the primary surface, and what it reflects. A reflection whose
      // own surface is unlit reads as a cut-out; with a shadow ray from the bounce
      // point it reads as another part of the same print.
      maxBounces: 2,
    };
    this.traceCanvas.hidden = false;
    this.state.tracing = true;
    this.state.traceSamples = 0;
    this.state.traceError = null;
    this.syncToolbar();
    this.scheduleTrace();
  }

  /**
   * Trace another pass on a later turn of the event loop.
   *
   * One pass per wakeup keeps the page responsive: a pass on a large plate takes
   * long enough that a loop of them would block the compositor and the image would
   * appear all at once instead of settling.
   *
   * Exactly one wakeup is outstanding at a time, and whichever of the two arrives
   * first cancels the other. That is not tidiness -- the previous version armed a
   * frame callback *and* a watchdog timer and let both stand, so on a plate whose
   * pass outran the watchdog the timer fired first and the abandoned frame callback
   * went on to trace a second chain beside it. Two chains became four, four became
   * eight, and the sample counter climbed past its budget while the tab froze. The
   * heavier the file, the faster it multiplied, which is why the order file hit it
   * and the small fixtures did not.
   */
  scheduleTrace() {
    if (!this.state.tracing) return;
    this.stopTraceHandle();

    let done = false;
    // The guard is what makes the race harmless: whichever of the two arrives first
    // claims the pass and cancels the other, and the loser returns without doing
    // anything. Without it a slow pass let the timer fire while the frame callback
    // was still pending, and that callback then ran as a *second* pass chain -- so
    // each pass doubled the number of chains and the counter ran past its budget.
    const pass = () => {
      if (done) return;
      done = true;
      this.stopTraceHandle();
      if (!this.state.tracing || this.tracer === null) return;
      this.tracer.traceSample(this.traceFrame);
      this.state.traceSamples = this.tracer.sampleCount();
      // A traced frame covers the rasterised one completely, so its background has
      // to be the scene's own: painting a fixed graphite behind a transparent
      // scene made the backdrop change the moment tracing started, which read as
      // the model sitting on a lighter box.
      this.tracer.present({
        background: this.state.background === null ? [0, 0, 0] : hexTriple(this.state.background),
        opaque: this.state.background !== null,
        denoise: 1,
        // The filter's geometry guide is traced from the camera; without it the
        // guide is empty and the filter averages a blank buffer over the image.
        camera: this.traceFrame,
      });
      this.syncStats();
      if (this.state.traceSamples < ViewerPanel.maxTraceSamples) this.scheduleTrace();
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.traceFrameHandle = globalThis.requestAnimationFrame(pass);
      // The watchdog covers the case where no frame is ever presented -- a background
      // tab, a headless run -- where a pure frame loop stops after a few samples and
      // looks frozen. Long enough that a normal pass wins on a normal machine.
      this.traceTimer = globalThis.setTimeout(pass, ViewerPanel.traceWatchdog);
    } else {
      this.traceTimer = globalThis.setTimeout(pass, 16);
    }
  }

  /** Cancel every pending wakeup, leaving the traced view in place. */
  stopTraceHandle() {
    if (this.traceFrameHandle !== undefined) {
      (globalThis.cancelAnimationFrame ?? globalThis.clearTimeout)(this.traceFrameHandle);
      this.traceFrameHandle = undefined;
    }
    if (this.traceTimer !== undefined) {
      globalThis.clearTimeout(this.traceTimer);
      this.traceTimer = undefined;
    }
    this.traceHandle = 0;
  }

  /** Stop tracing and go back to the live view. */
  stopTrace() {
    this.stopTraceHandle();
    // An export in flight holds its own canvas and its own context; leaving it
    // running would keep tracing into a view that is gone.
    this.cancelTraceExport();
    this.state.tracing = false;
    this.state.traceSamples = 0;
    if (this.traceCanvas !== null && this.traceCanvas !== undefined) this.traceCanvas.hidden = true;
    this.syncToolbar();
  }

  /**
   * Render the traced view to a PNG file and download it.
   *
   * Deliberately not a screenshot of the canvas: the screen may be mid-converge,
   * smaller than a print wants, and carrying whatever resolution the panel happens
   * to have. This traces the same camera at the export size for the full sample
   * budget, denoises, and writes that -- so the file is the converged image rather
   * than an early frame of it.
   *
   * The samples go in a few at a time, one slice per turn of the event loop.
   * Measured on this machine, the whole run is about six and a half seconds; done in
   * one loop it froze the tab for all of them, and the progress line the status bar
   * shows could never have painted.
   *
   * Slicing alone was not enough. A WebGL call only queues work, so forty slices
   * returned in no time at all and the entire cost landed on the final read-back as
   * one stall of four and a half seconds -- measured, not guessed. Each slice now
   * ends with a synchronisation, which brings the longest stall down to under 0.4 s
   * in the loop and under 0.65 s for the final denoise and encode.
   */
  saveTracedImage() {
    const { viewer, tracer } = this;
    if (viewer === null || tracer === null || !this.state.tracing) return;
    if (this.state.exportingTrace) return;
    if (this.bvh === undefined || this.bvh === null) return;

    const width = ViewerPanel.traceExportWidth;
    const target = ViewerPanel.traceExportSamples;
    const background = this.state.background === null
      ? hexTriple(theme.surfaceSolid)
      : hexTriple(this.state.background);
    // The aspect of the view being exported, so the file frames what is on screen.
    const aspect = this.canvas !== null && this.canvas.clientWidth > 0
      ? this.canvas.clientHeight / this.canvas.clientWidth
      : 0.75;

    // Its own offscreen tracer, not the one driving the screen: resizing the live
    // targets destroys their accumulated buffer, and a buffer cannot be restored
    // from its sample count -- so reusing the live tracer left the interactive view
    // dividing an empty accumulation, which is how this once produced a blank PNG.
    const still = createStillRender({
      bvh: this.bvh,
      width,
      camera: { ...this.traceFrame, aspect },
      background,
      opaque: true,
      denoise: 1,
    });
    if (still === null) {
      // Nothing to show for a failure that leaves the interface unchanged, but
      // saying so beats a button that silently does nothing.
      this.state.traceError = this.t('status.traceUnavailable');
      this.syncStats();
      return;
    }
    this.stillRender = still;
    this.state.exportingTrace = true;
    this.state.traceExported = 0;
    this.state.traceExportTotal = target;
    this.syncToolbar();
    this.syncStats();
    this.stepTraceExport(still, target);
  }

  /**
   * Trace one slice of the export, then either schedule the next or finish.
   *
   * The handle is threaded through rather than read from `this` so a cancelled
   * export cannot be resumed by a frame that was already queued: the handle it
   * carries is closed, and `step` on a closed handle is a no-op.
   */
  stepTraceExport(still, target) {
    if (still.closed) return;
    const done = still.sampleCount();
    if (done >= target) {
      this.finishTraceExport(still);
      return;
    }
    // A slice, not a single sample: each sample is a full-screen fragment pass over
    // the whole BVH, and the per-turn cost of a timer is what a one-sample slice
    // would spend on scheduling rather than on tracing.
    still.step(ViewerPanel.traceExportSlice);
    this.state.traceExported = still.sampleCount();
    this.syncStats();
    this.traceExportHandle = globalThis.setTimeout(
      () => this.stepTraceExport(still, target),
      ViewerPanel.traceExportInterval,
    );
  }

  /** Present the finished export, hand over the file and clean up. */
  finishTraceExport(still) {
    this.traceExportHandle = undefined;
    const url = still.finish();
    this.stillRender = null;
    this.state.exportingTrace = false;
    this.syncToolbar();
    this.syncStats();
    if (url === null) return;
    const stem = (this.options.fileName ?? 'model').split('/').pop().replace(/\.[^.]+$/, '') || 'model';
    const link = this.document.createElement('a');
    link.href = url;
    link.download = `${stem}-traced.png`;
    link.click();
  }

  /** Abandon an export in flight, releasing its canvas and its GPU memory. */
  cancelTraceExport() {
    if (this.traceExportHandle !== undefined) {
      globalThis.clearTimeout(this.traceExportHandle);
      this.traceExportHandle = undefined;
    }
    this.stillRender?.cancel();
    this.stillRender = null;
    this.state.exportingTrace = false;
    this.state.traceExported = 0;
  }

  /* -------------------------------------------------------------- layers -- */

  /** Apply a layer range from the slider. */
  setLayers(from, to, dim) {
    const { viewer, state } = this;
    if (viewer === null || state.layers === null) return;
    // With the one-layer switch on there is only the upper value: the lower one
    // follows it, which is what makes the whole plate collapse to one layer.
    if (state.oneLayer) viewer.setLayerRange(to, to, { dim });
    else viewer.setLayerRange(from, to, { dim });
    const info = viewer.layerInfo();
    if (info.count > 0) state.layers = { count: info.count, range: info.range, dim: info.dim };
    this.syncLayerSlider();
    this.queueSave();
  }

  /**
   * Turn the one-layer switch on or off.
   *
   * This follows OrcaSlicer's `switch_one_layer_mode`: turning it on collapses the
   * band to the layer it was already cut at, remembering that layer; turning it
   * off restores the whole plate. What it deliberately does not do is leave the
   * plate cut at one layer, which would make the switch look like it had done
   * nothing.
   */
  toggleOneLayer() {
    const { viewer, state } = this;
    if (viewer === null || state.layers === null) return;
    const info = viewer.layerInfo();
    if (info.count === 0) return;

    if (state.oneLayer) {
      viewer.setLayerRange(0, info.count - 1, { dim: info.dim });
      state.oneLayer = false;
      state.lastCut = info.range[1];
    } else {
      // The precedence is OrcaSlicer's, and it is order-sensitive:
      //   - a layer the user picked is the one they are looking at, so keep it;
      //   - a plate still showing everything means no layer was picked, so go
      //     back to the one the switch was last on;
      //   - the first time, start in the middle, where there is something to see.
      const untouched = info.range[1] >= info.count - 1;
      const remembered = state.lastCut > 0 && state.lastCut < info.count
        ? state.lastCut
        : Math.floor((info.count - 1) / 2);
      const target = untouched ? remembered : info.range[1];
      viewer.setLayerRange(target, target, { dim: info.dim });
      state.oneLayer = true;
    }
    state.layers = { count: info.count, range: viewer.layerInfo().range, dim: info.dim };
    this.syncLayerSlider();
    this.queueSave();
  }

  /* ----------------------------------------------------------------- bed -- */

  /** Show or hide the printer's bed, and the navigation cube with it. */
  toggleBed() {
    const { viewer, state } = this;
    if (viewer === null) return;
    const info = viewer.bedInfo();
    if (!info.available) return;
    viewer.setBedVisible(!info.visible);
    state.bed = viewer.bedInfo();
    this.syncBedButton();
    this.syncBed();
    this.queueSave();
  }

  /* ------------------------------------------------------------- surface -- */

  /** Change one filament's surface parameters. */
  setSurface(slot, patch) {
    const { viewer, state } = this;
    const current = state.surfaces[slot] ?? DEFAULT_SURFACE;
    const next = { ...current, ...patch };
    state.surfaces[slot] = next;
    viewer?.setSurface(slot, next);
    this.syncSurfaceControls();
    this.queueSave();
  }

  /** Change the studio's overall level. */
  setLightLevel(level) {
    this.state.lightLevel = level;
    this.viewer?.setLightLevel(level);
    this.syncSurfaceControls();
    this.queueSave();
  }

  /** Choose which filament the surface sliders are editing. */
  selectSlot(slot) {
    this.state.activeSlot = slot;
    this.syncPalette();
    this.syncSurfaceControls();
  }

  /** Recolour one filament slot. */
  setFilament(slot, hex) {
    const { state } = this;
    state.paletteOverrides = { ...state.paletteOverrides, [slot]: hex };
    this.syncPalette();
    this.applyPalette();
    this.queueSave();
  }

  /** The palette in force: the file's own colours with overrides applied. */
  palette() {
    const { state } = this;
    const base = state.sliced?.palette ?? state.mesh?.palette;
    if (base === undefined) return undefined;
    return base.map((hex, index) => state.paletteOverrides[index] ?? hex);
  }

  /** Push the current palette to the engine. */
  applyPalette() {
    const palette = this.palette();
    if (palette !== undefined) this.viewer?.setPalette(palette);
  }

  /* ------------------------------------------------------------ lighting -- */

  /** Switch between the studio material and a plain shaded view. */
  togglePlainLighting() {
    this.state.plainLighting = !this.state.plainLighting;
    this.viewer?.setPlainLighting(this.state.plainLighting);
    this.syncToolbar();
    this.queueSave();
  }

  /* -------------------------------------------------------------- scenes -- */

  /** Apply a background colour to the scene. */
  setBackground(colour) {
    this.state.background = colour;
    this.viewer?.setBackground(colour);
    this.backgroundPicker.setValue(colour);
    this.queueSave();
  }

  /** Point the camera at an orbit, as picked on the navigation cube. */
  setOrbit(yaw, pitch) {
    this.viewer?.setOrbit(yaw, pitch);
  }

  /**
   * Reset the camera, and forget this file's stored settings.
   *
   * Clearing the store is what makes the button do what it looks like it does. A
   * reset that only moved the camera back would re-apply the old camera on the
   * next visit, so the one control for "undo my changes" would silently not undo
   * the ones that persist.
   */
  reset() {
    this.viewer?.reset();
    this.settings.store.remove(this.settings.key);
    this.saveSoon?.cancel();
  }

  /**
   * Render the scene to a PNG and hand it to the browser as a download.
   *
   * The file name comes from the source, so a saved image is named after what it
   * shows rather than "download.png".
   */
  saveImage() {
    const { viewer } = this;
    if (viewer === null) return;
    // An opaque backdrop for the image: a transparent PNG is rarely what a
    // product shot wants, and the scene's own colour is already chosen.
    const background = this.state.background ?? theme.surfaceSolid;
    const url = viewer.renderToImage({ width: 2048, background });
    if (url === null) return;
    const name = this.options.fileName ?? 'model';
    const base = name.split('/').pop() ?? 'model';
    const stem = base.replace(/\.[^.]+$/, '') || 'model';
    const link = this.document.createElement('a');
    link.href = url;
    link.download = `${stem}.png`;
    link.click();
  }

  /* ------------------------------------------------------------- syncing -- */

  /** The status paragraph, or nothing while the canvas is up. */
  showStatus(text) {
    setText(this.status, text);
    this.status.hidden = false;
  }

  hideStatus() {
    this.status.hidden = true;
    setText(this.status, '');
  }

  /** Reflect every flag the toolbar shows. */
  syncToolbar() {
    const { state } = this;
    const ready = state.kind === 'ready';
    // The model/sliced switch exists only when the file carries both views.
    this.segmented.hidden = !(ready && state.sliced !== null);
    this.segmentedButtons.model.classList.toggle('is-active', state.view === 'model');
    this.segmentedButtons.sliced.classList.toggle('is-active', state.view === 'sliced');
    this.segmentedButtons.model.setAttribute('aria-pressed', String(state.view === 'model'));
    this.segmentedButtons.sliced.setAttribute('aria-pressed', String(state.view === 'sliced'));

    this.lightingButton.classList.toggle('is-pressed', state.plainLighting);
    this.lightingButton.setAttribute('aria-pressed', String(state.plainLighting));

    this.resetButton.disabled = !ready || this.loading === true;
    this.snapshotButton.disabled = !ready;
    this.traceButton.disabled = !ready;
    this.traceButton.classList.toggle('is-pressed', state.tracing);
    this.traceButton.setAttribute('aria-pressed', String(state.tracing));
    this.traceButton.title = state.tracing ? this.t('controls.traceStop') : this.t('controls.trace');
    this.saveTracedButton.hidden = !state.tracing;
    this.saveTracedButton.disabled = !state.tracing || state.exportingTrace === true;

    // The surface row is only shown in material mode: plain shading has no
    // highlight to tune and no reflection to weaken.
    this.surfaceRow.hidden = state.plainLighting || !ready;

    // Without material sliders there is nothing to select a filament for, so the
    // swatches stay a legend in plain mode.
    this.paletteControl.setSelectable(!state.plainLighting && ready);

    this.syncStats();
  }

  /** The stats line: triangles, size, and a software-renderer warning. */
  syncStats() {
    const { state } = this;
    if (state.kind !== 'ready' || state.mesh === null) {
      setText(this.statsNode, '');
      return;
    }
    const size = formatSize(state.mesh.size);
    // A sliced plate is strokes, not triangles. The count is the expansion of each
    // stroke into its twelve facets, which is a real number but the wrong noun:
    // showing "1 848 408 треугольников" over layer paths invites the reader to
    // wonder what they are looking at.
    const sliced = state.mesh.kind === 'segments';
    const count = sliced ? (state.mesh.instances?.length ?? 0) / (state.mesh.stride ?? 12) : state.mesh.triangles;
    let text = this.t(sliced ? 'controls.statsSliced' : 'controls.stats', {
      triangles: Math.round(count).toLocaleString(),
      size,
    });
    // The renderer is named only when it is worth saying: a software fallback is
    // the difference between usable and not, and naming the GPU is noise when
    // everything is working.
    if (state.traceError !== null) {
      text = state.traceError;
    } else if (state.exportingTrace === true) {
      text = this.t('status.traceExporting', {
        done: String(state.traceExported ?? 0),
        total: String(state.traceExportTotal ?? 0),
      });
    } else if (state.tracing) {
      // The count is the useful number: it says how much further the image will
      // settle, and it is the only feedback that the pass loop is alive.
      text = this.t('status.tracing', { samples: String(state.traceSamples) });
    }
    if (state.renderer?.software === true && !state.tracing) text += ` · ${this.t('status.softwareRenderer')}`;
    if (this.options.showName === true && this.options.fileName !== undefined) {
      text = `${this.options.fileName} · ${text}`;
    }
    setText(this.statsNode, text);
  }

  /** Rebuild the palette swatches for the current file. */
  /**
   * Push the palette to both places that need it: the viewer, which colours the
   * geometry, and the swatch row, which shows it.
   *
   * The viewer was only ever given a palette by `applyPalette`, and that is called
   * when a colour is edited. Opening a file never went through it, so a 3 MF
   * opened on its model view drew with an empty palette: the strokes of the sliced
   * view index into it and came out black, and the model, whose colours are baked
   * per triangle, looked flat and wrong. Switching to the sliced view and back
   * happened to fix it, because that path does reach `setPalette` -- which is
   * exactly the "it is fine until I toggle" shape of the report.
   */
  syncPalette() {
    const palette = this.palette();
    if (palette !== undefined) this.viewer?.setPalette(palette);
    this.paletteControl.setPalette(
      palette,
      this.state.plainLighting ? undefined : this.state.activeSlot,
    );
  }

  /** Reflect the bed button's availability. */
  syncBedButton() {
    const { bed } = this.state;
    this.bedButton.hidden = !bed.available;
    this.bedButton.classList.toggle('is-pressed', bed.visible);
    this.bedButton.setAttribute('aria-pressed', String(bed.visible));
  }

  /** Mount or remove the navigation cube; it rides with the bed. */
  syncBed() {
    const { bed } = this.state;
    const wanted = bed.visible;
    if (!wanted) {
      this.navCube?.dispose();
      this.navCube = null;
      return;
    }
    if (this.navCube !== null) return;
    this.navCube = new NavCubeControl({
      t: this.t,
      document: this.document,
      stage: this.stage,
      viewer: this.viewer,
      onPick: (view) => this.setOrbit(view.yaw, view.pitch),
    });
  }

  /** Mount or remove the layer slider for the current plate. */
  syncLayerSlider() {
    const { state } = this;
    const wanted = state.kind === 'ready' && state.view === 'sliced' && state.layers !== null;
    if (!wanted) {
      this.layerSlider?.dispose();
      this.layerSlider = null;
      return;
    }
    if (this.layerSlider === null) {
      this.layerSlider = new LayerSliderControl({
        t: this.t,
        document: this.document,
        stage: this.stage,
        onChange: (from, to, dim) => this.setLayers(from, to, dim),
        onToggleOneLayer: () => this.toggleOneLayer(),
      });
    }
    this.layerSlider.update(state.layers, state.oneLayer);
  }

  /** Reflect the surface sliders for the active filament. */
  syncSurfaceControls() {
    const { state } = this;
    const surface = state.surfaces[state.activeSlot] ?? DEFAULT_SURFACE;
    this.matteSlider.setValue(surface.matte);
    this.metalnessSlider.setValue(surface.metalness);
    this.transparencySlider.setValue(surface.transparency);
    this.lightSlider.setValue(state.lightLevel);
  }

  /* ------------------------------------------------------------- teardown -- */

  /** Release everything: the read, the GPU, the listeners, the DOM. */
  dispose() {
    if (this.disposed) return;
    // The last change may still be sitting in the debouncer; writing it here is
    // the difference between "the tab remembered where I left it" and "it forgot
    // the last thing I did".
    this.flushSave();
    this.disposed = true;
    this.readController?.abort();
    this.readController = null;
    this.clearStage();
    clear(this.host);
  }
}

/* ================================================================ controls */


/** One labelled slider for a surface property. */
class SliderControl {
  constructor({ t, labelKey, min, max, step, onChange }) {
    this.t = t;
    this.labelKey = labelKey;
    const label = t(labelKey);
    this.valueNode = el('span', { class: 'm3d-slider-value' });
    this.input = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      'aria-label': label,
      onInput: (event) => {
        const value = Number(event.target.value);
        this.valueNode.textContent = String(Math.round(value * 100));
        onChange(value);
      },
    });
    this.input.value = String(min);
    this.node = el('label', { class: 'm3d-slider', title: label }, [
      el('span', { class: 'm3d-slider-label' }, label),
      this.input,
      this.valueNode,
    ]);
  }

  /** Set the slider's position without firing its change handler. */
  setValue(value) {
    // A slider being dragged must not have its value overwritten by the state it
    // is producing: the two would fight and the thumb would stutter. The input's
    // own value is authoritative while it has focus.
    if (this.input === this.input.ownerDocument.activeElement && this.input.matches(':active')) return;
    this.input.value = String(value);
    this.valueNode.textContent = String(Math.round(value * 100));
  }
}

/** The scene's background colour, as a drop-down with a swatch. */
class BackgroundPickerControl {
  constructor({ t, onChange }) {
    this.t = t;
    this.swatch = el('span', { class: 'm3d-bg-swatch is-auto', 'data-background-swatch': true });
    this.select = el('select', {
      'aria-label': t('controls.background'),
      onChange: (event) => onChange(event.target.value === 'auto' ? null : event.target.value),
    }, BACKGROUNDS.map((option) => el('option', {
      value: option.value ?? 'auto',
    }, t(option.labelKey))));
    this.node = el('span', {
      class: 'm3d-bg',
      'data-model3d-background': true,
      title: t('controls.background'),
    }, [this.swatch, this.select]);
    this.setValue(null);
  }

  setValue(value) {
    const current = BACKGROUNDS.find((option) => option.value === value) ?? BACKGROUNDS[0];
    this.select.value = current.value ?? 'auto';
    this.node.title = `${this.t('controls.background')}: ${this.t(current.labelKey)}`;
    this.swatch.classList.toggle('is-auto', current.value === null);
    this.swatch.style.background = current.value === null ? '' : current.value;
  }
}

/**
 * The filament swatches.
 *
 * A 3MF project numbers its filaments from one; the swatch order is that same
 * order, so the strip reads as the print's own colour list. Each swatch both
 * names a filament and opens the picker for it: clicking selects which filament
 * the surface sliders edit, and the colour input on top changes that filament's
 * colour. A second row of swatches for the same purpose was a copy of this one.
 */
class PaletteControl {
  constructor({ t, onChange, onSelect }) {
    this.t = t;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.palette = undefined;
    this.activeSlot = undefined;
    this.selectable = false;
    this.node = el('span', { class: 'm3d-palette', 'data-model3d-palette': true, 'aria-label': t('controls.palette'), title: t('controls.palette') });
  }

  setSelectable(selectable) {
    if (this.selectable === selectable) return;
    this.selectable = selectable;
    this.render();
  }

  setPalette(palette, activeSlot) {
    const changed = this.palette?.join('|') !== palette?.join('|') || this.activeSlot !== activeSlot;
    this.palette = palette;
    this.activeSlot = activeSlot;
    if (changed) this.render();
  }

  /** Rebuild the swatches. Only called when the colours themselves change. */
  render() {
    clear(this.node);
    if (this.palette === undefined || this.palette.length === 0) {
      this.node.hidden = true;
      return;
    }
    this.node.hidden = false;
    this.palette.forEach((hex, index) => {
      const active = index === this.activeSlot;
      const swatch = el('span', {
        class: `m3d-swatch${active ? ' is-active' : ''}${this.selectable ? ' is-selectable' : ''}`,
        title: this.selectable
          ? `${this.t('controls.surfaceFor')} · ${hex}`
          : hex,
        style: { background: hex },
        'aria-label': `${this.t('controls.surfaceFor')} ${index + 1}`,
        onClick: this.selectable ? () => this.onSelect(index) : undefined,
      }, this.onChange === undefined || !this.selectable ? null : el('input', {
        type: 'color',
        'aria-label': `${this.t('controls.surfaceFor')} ${index + 1}`,
        onInput: (event) => this.onChange(index, event.target.value),
        // The input sits on top of the swatch and takes the click, so the
        // selection is made from the event's bubble rather than by the swatch
        // never receiving it.
        onClick: () => this.onSelect(index),
      }));
      const input = swatch.querySelector('input');
      if (input !== null) input.value = hex;
      this.node.append(swatch);
    });
  }
}

/* ============================================================== overlays */

/**
 * The navigation cube, on a canvas of its own.
 *
 * OrcaSlicer keeps its cube in a separate widget canvas and so does g54.app;
 * sharing the plate's canvas would mean sharing its viewport, its depth range and
 * its clear, and a reference object needs none of those shared. The cube module
 * owns a context here and is driven by the plate's orbit.
 */
class NavCubeControl {
  constructor({ t, document, stage, viewer, onPick }) {
    this.container = el('div', {
      class: 'm3d-navcube',
      'data-model3d-navcube': true,
      'aria-label': t('controls.orientation'),
    });
    const canvas = document.createElement('canvas');
    this.container.append(canvas);
    stage.append(this.container);

    this.cube = createCube(
      canvas,
      // A preset picked on a face: the plate's camera jumps there.
      (view) => onPick(view),
      // A drag on the cube turns the camera; the plate follows the orbit.
      (next) => viewer?.setOrbit(next.yaw, next.pitch),
    );
    // The cube follows the plate's camera directly, not through the panel's
    // state: routing every pointer move through a state update would repaint on
    // each frame of a drag, which is what made it feel heavy.
    if (viewer !== null && viewer !== undefined) {
      this.cube.setOrbit(viewer.orientation());
      this.unwatch = viewer.watchOrbit((next) => this.cube.setOrbit(next));
    }
  }

  dispose() {
    this.unwatch?.();
    this.unwatch = null;
    this.cube.dispose();
    this.container.remove();
  }
}

/**
 * The layer slider: a vertical track beside the plate, with the one-layer switch
 * underneath it.
 *
 * Dragging a handle picks the layer the plate is cut at; the two handles widen
 * that into a band, so a run of layers can be shown on its own. The button below
 * the track is OrcaSlicer's `one_layer_button`: it collapses the band to a single
 * layer and remembers where it was, so turning it off restores the whole plate
 * rather than leaving the cut behind.
 *
 * The button sits under the track because that is where OrcaSlicer puts it -- in a
 * window pinned to the slider's bottom-right corner -- and because the slider is
 * read top-down: the track says which layer, the button says how many.
 */
class LayerSliderControl {
  constructor({ t, document, stage, onChange, onToggleOneLayer }) {
    this.t = t;
    this.onChange = onChange;
    this.document = document;
    this.count = 0;
    this.range = [0, 0];
    this.dim = false;
    this.oneLayer = false;
    // Which handle is being dragged: 'bottom', 'top', or null. Held here rather
    // than read from the event, because the pointer leaves the handle almost
    // immediately during a drag.
    this.dragging = null;

    this.valueNode = el('div', { class: 'm3d-layer-value' });
    this.band = el('div', { class: 'm3d-layer-band' });
    this.topHandle = this.makeHandle('top');
    this.bottomHandle = this.makeHandle('bottom');
    this.track = el('div', {
      class: 'm3d-layer-track',
      onClick: (event) => this.onTrackClick(event),
      onContextMenu: (event) => {
        event.preventDefault();
        // A right-click flips the "dim what is below" mode, which is the one
        // setting the slider has that a click cannot express.
        this.onChange(this.range[0], this.range[1], !this.dim);
      },
      onWheel: (event) => this.onWheel(event),
    }, [this.band, this.bottomHandle, this.topHandle]);

    this.oneLayerButton = el('button', {
      type: 'button',
      class: 'm3d-one-layer',
      'data-model3d-one-layer': true,
      'aria-pressed': 'false',
      title: t('controls.oneLayer'),
      onClick: () => onToggleOneLayer(),
    }, oneLayerIcon());

    this.container = el('div', { class: 'm3d-layers', 'data-model3d-layers': true }, [
      this.valueNode,
      this.track,
      this.oneLayerButton,
    ]);
    stage.append(this.container);

    this.track.addEventListener('pointermove', this.onPointerMove);
    this.track.addEventListener('lostpointercapture', this.onLostCapture);
    globalThis.addEventListener('pointerup', this.onPointerUp);
    globalThis.addEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * One draggable handle.
   *
   * Each handle moves only its own bound, and each is clamped against the other so
   * the band can never invert. The upper value travels with the lower one only
   * while the switch has the plate cut to a single layer.
   */
  makeHandle(kind) {
    const node = el('div', {
      class: `m3d-layer-handle is-${kind}`,
      role: 'slider',
      tabIndex: 0,
      'aria-label': kind === 'top' ? this.t('controls.layerTop') : this.t('controls.layerBottom'),
      onPointerDown: (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.dragging = kind;
        node.setPointerCapture?.(event.pointerId);
      },
      onKeyDown: (event) => this.onHandleKey(kind, event),
    });
    return node;
  }

  /** Map a pointer's Y inside the track to a layer index. */
  layerAt(event) {
    const box = this.track.getBoundingClientRect();
    const ratio = (event.clientY - box.top) / Math.max(1, box.height);
    return Math.round((1 - Math.min(1, Math.max(0, ratio))) * (this.count - 1));
  }

  /** Report a new range, honouring the one-layer collapse. */
  commit(low, high, mode = this.dim) {
    if (this.oneLayer) this.onChange(high, high, mode);
    else this.onChange(low, high, mode);
  }

  onPointerMove = (event) => {
    if (this.dragging === null) return;
    const layer = this.layerAt(event);
    if (this.dragging === 'bottom') {
      const low = Math.min(this.range[1], layer);
      this.commit(this.oneLayer ? this.range[1] : low, this.range[1]);
    } else {
      const high = Math.max(this.range[0], layer);
      this.commit(this.oneLayer ? high : this.range[0], high);
    }
  };

  onPointerUp = () => {
    this.dragging = null;
  };

  onLostCapture = () => {
    this.dragging = null;
  };

  onTrackClick(event) {
    // A click on the groove moves the *upper* layer and leaves the lower one
    // where it is, so a band under construction survives a click. The lower bound
    // is the user's own decision and only dragging moves it; collapsing both here
    // would silently undo it.
    const layer = this.layerAt(event);
    if (this.oneLayer) this.commit(layer, layer);
    else this.commit(this.range[0], this.range[0] > layer ? this.range[0] : layer);
  }

  onWheel(event) {
    // In one-layer mode the wheel walks the cut up and down the plate, which is
    // how OrcaSlicer's slider behaves with the switch on.
    if (!this.oneLayer) return;
    event.preventDefault();
    const step = event.deltaY > 0 ? -1 : 1;
    const next = Math.max(0, Math.min(this.count - 1, this.range[1] + step));
    this.commit(next, next);
  }

  onHandleKey(kind, event) {
    const step = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const layer = kind === 'top' ? this.range[1] : this.range[0];
    const next = layer + step;
    if (kind === 'bottom') {
      const low = Math.max(0, Math.min(this.range[1], next));
      this.commit(this.oneLayer ? this.range[1] : low, this.range[1]);
    } else {
      const high = Math.max(this.range[0], Math.min(this.count - 1, next));
      this.commit(this.oneLayer ? high : this.range[0], high);
    }
  }

  /** Reflect a new range and the switch's state. */
  update(layers, oneLayer) {
    this.count = layers.count;
    this.range = layers.range;
    this.dim = layers.dim;
    this.oneLayer = oneLayer;

    const percent = (layer) => (this.count <= 1 ? 100 : (layer / (this.count - 1)) * 100);
    // In one-layer mode both handles share the upper value, so the band is a
    // line rather than an interval.
    const low = percent(oneLayer ? this.range[1] : this.range[0]);
    const high = percent(this.range[1]);

    this.container.classList.toggle('is-one', oneLayer);
    this.valueNode.textContent = `${this.range[1] + 1}/${this.count}`;
    this.container.title = oneLayer
      ? this.t('controls.oneLayerOn', { layer: this.range[1] + 1, total: this.count })
      : this.t('controls.layers', { layer: this.range[1] + 1, total: this.count });

    this.band.style.bottom = `${low}%`;
    this.band.style.height = `${Math.max(oneLayer ? 0.5 : 0, high - low)}%`;
    this.bottomHandle.style.bottom = `${low}%`;
    this.topHandle.style.bottom = `${high}%`;

    for (const [kind, handle, layer] of [['top', this.topHandle, this.range[1]], ['bottom', this.bottomHandle, this.range[0]]]) {
      handle.setAttribute('aria-valuemin', '1');
      handle.setAttribute('aria-valuemax', String(this.count));
      handle.setAttribute('aria-valuenow', String((oneLayer && kind === 'bottom' ? this.range[1] : layer) + 1));
    }

    this.oneLayerButton.classList.toggle('is-pressed', oneLayer);
    this.oneLayerButton.setAttribute('aria-pressed', String(oneLayer));
  }

  dispose() {
    this.track.removeEventListener('pointermove', this.onPointerMove);
    this.track.removeEventListener('lostpointercapture', this.onLostCapture);
    globalThis.removeEventListener('pointerup', this.onPointerUp);
    globalThis.removeEventListener('pointercancel', this.onPointerUp);
    this.container.remove();
  }
}

/** The one-layer switch's glyph: three stacked plates, the middle one lit. */
function oneLayerIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('fill', 'none');
  group.setAttribute('stroke', 'currentColor');
  group.setAttribute('stroke-width', '1.4');
  group.setAttribute('stroke-linecap', 'round');
  for (const [d, opacity] of [['M3 4.5h10', '0.35'], ['M3 8h10', '1'], ['M3 11.5h10', '0.35']]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('opacity', opacity);
    group.append(path);
  }
  svg.append(group);
  return svg;
}
