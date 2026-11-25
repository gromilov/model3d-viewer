/**
 * Remembering a file's view between visits.
 *
 * The viewer has a dozen settings that are a judgement about *this* print rather
 * than about the tool: a black lid looks right matte, a bright label looks right
 * glossy, this plate reads better on a dark backdrop and that one on a light. A
 * preview that forgets all of it the moment the tab closes makes the user re-make
 * the same decisions every time, which is the sort of friction that stops people
 * adjusting anything at all.
 *
 * So settings are stored per file, in the browser. Three things this module is
 * careful about, because each one is a way such a feature becomes a nuisance:
 *
 *   - **A bad store must never break the viewer.** `localStorage` throws in
 *     private browsing, when the quota is full, and when a host has disabled it.
 *     Every access is guarded and a failure degrades to "nothing remembered".
 *   - **Old data must not be trusted.** A stored blob may predate a change to the
 *     settings' shape, or be a file the user edited by hand. It is versioned and
 *     every field is validated on the way in; anything unrecognised is ignored
 *     rather than applied.
 *   - **Writing must not happen per frame.** Orbiting the camera changes state on
 *     every pointer move, and `localStorage` writes are synchronous and serialise
 *     in the main thread. Saving is debounced and flushed on the way out.
 */

/**
 * The version of the stored shape.
 *
 * Read alongside the data rather than inferred: a blob whose version is not this
 * one is discarded wholesale. Trying to migrate a half-unknown object is how a
 * viewer ends up opening on a broken camera.
 */
export const STORE_VERSION = 1;

/**
 * How many recorded views a tour may keep.
 *
 * A tour is a handful of angles someone picked by hand; past a dozen it is a
 * slideshow nobody watches, and the list would push the popover's own controls
 * off a short sidebar. The cap is enforced on the way in as well as on the way
 * out, so a hand-edited blob cannot make the panel slow to open.
 */
export const MAX_TOUR_VIEWS = 12;

/** The prefix on every key, so a host page's own storage cannot collide with it. */
export const KEY_PREFIX = 'model3d:file:';

/**
 * How long a tour takes, in milliseconds, when nothing is stored.
 *
 * Four seconds for however many views: a three-view turntable is a slow turn, a
 * ten-view one is brisk. Scaled by the count instead would make a long tour
 * unwatchable, and the panel lets the number be typed anyway.
 */
export const DEFAULT_TOUR_DURATION = 4000;

/**
 * A store that keeps nothing.
 *
 * The fallback when the browser offers no usable `localStorage`. Returning a real
 * object rather than `undefined` means the panel has no second code path: it
 * always has a store, and that store may simply be empty.
 */
export function createMemoryStore() {
  const map = new Map();
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => { map.set(key, value); return true; },
    remove: (key) => { map.delete(key); },
    keys: () => [...map.keys()],
    persistent: false,
  };
}

/**
 * A store over `localStorage`, with every access guarded.
 *
 * @param storage - a `Storage`-like object; defaults to the browser's.
 * @param prefix - key prefix; the panel's default is fine for a whole page.
 * @returns a store; `persistent` says whether writes will outlive the page.
 */
export function createLocalStore(storage, prefix = KEY_PREFIX) {
  const backend = storage ?? safeLocalStorage();
  if (backend === null) return createMemoryStore();

  return {
    read(key) {
      try {
        return backend.getItem(prefix + key);
      } catch {
        // A store that throws on read is not worth distinguishing from an empty
        // one: the caller's next move is the same either way.
        return null;
      }
    },
    write(key, value) {
      try {
        backend.setItem(prefix + key, value);
        return true;
      } catch {
        // Quota exceeded, or storage disabled. Not an error worth surfacing: the
        // viewer works identically, it just will not be remembered.
        return false;
      }
    },
    remove(key) {
      try {
        backend.removeItem(prefix + key);
      } catch {
        // Nothing to do; the key may simply stay.
      }
    },
    keys() {
      const out = [];
      try {
        for (let index = 0; index < backend.length; index += 1) {
          const key = backend.key(index);
          if (typeof key === 'string' && key.startsWith(prefix)) out.push(key.slice(prefix.length));
        }
      } catch {
        return out;
      }
      return out;
    },
    persistent: true,
  };
}

/**
 * The browser's `localStorage`, or `null` where no storage is usable.
 *
 * Merely *reading* the property can throw when a browser has storage disabled for
 * the origin, which is why this is a function with a guard rather than a const.
 */
function safeLocalStorage() {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return null;
    // A probe write: some browsers expose the object but refuse every write, and
    // discovering that on the user's first orbit would be the wrong time.
    const probe = `${KEY_PREFIX}probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Derive a stable key for a source.
 *
 * The settings belong to the *file*, so the key must name the same file the same
 * way on every visit. Which string does that depends on where the source came
 * from, and getting it wrong is not a visible bug -- it just quietly never
 * remembers anything, or worse, shares one file's settings with another's:
 *
 *   - a URL is its own identity, path included, because two prints in different
 *     folders are different prints even when their basenames match;
 *   - a `File` has no path, so its name, size and modification time are used
 *     together: the name alone collides across folders, and the timestamp alone
 *     changes whenever a slicer re-exports an identical file;
 *   - bytes passed straight in have no identity at all, so the host's own key is
 *     the only thing that can be trusted.
 *
 * @param source - the panel's `source` option.
 * @param explicit - a key from the host, which always wins.
 * @returns the key, or `undefined` when the source cannot be told apart reliably.
 */
export function keyOf(source, explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (typeof source === 'string' && source !== '') return `url:${source}`;
  if (typeof URL !== 'undefined' && source instanceof URL) return `url:${source.href}`;
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const name = typeof source.name === 'string' ? source.name : '';
    // A `File` carries a timestamp; a plain `Blob` does not, and then the name and
    // size are all there is -- weaker, but still much better than a shared key.
    const stamp = typeof source.lastModified === 'number' ? source.lastModified : 0;
    if (name === '' && stamp === 0) return undefined;
    return `file:${name}:${source.size}:${stamp}`;
  }
  if (typeof source === 'object' && source !== null) {
    if (typeof source.name === 'string' && source.name !== '') {
      const bytes = source.bytes ?? source.blob;
      const size = bytes === undefined ? 0 : (bytes.size ?? bytes.byteLength ?? 0);
      return `named:${source.name}:${size}`;
    }
    if (typeof source.url === 'string') return `url:${source.url}`;
  }
  return undefined;
}

/* ---------------------------------------------------------------- shaping -- */

/** Whether a value is a finite number inside a range. */
function clampNumber(value, minimum, maximum, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

/** Whether a value looks like a `#rrggbb` colour. */
function isHex(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Validate a stored snapshot.
 *
 * Every field is checked against what the viewer can actually accept, and anything
 * that fails is dropped rather than repaired into something plausible. A stored
 * colour is either a colour or it is not there; guessing at a truncated hex string
 * would apply a shade the user never chose.
 *
 * Unknown keys are discarded by construction: the result is built field by field,
 * so a blob written by a newer version cannot smuggle a setting in.
 *
 * @param raw - the parsed blob.
 * @returns a snapshot containing only the fields that survived, or `null`.
 */
export function validateSnapshot(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (raw.version !== STORE_VERSION) return null;

  const out = { version: STORE_VERSION };

  if (raw.view === 'model' || raw.view === 'sliced') out.view = raw.view;
  if (typeof raw.plainLighting === 'boolean') out.plainLighting = raw.plainLighting;
  if (typeof raw.bedVisible === 'boolean') out.bedVisible = raw.bedVisible;
  if (raw.background === null || isHex(raw.background)) out.background = raw.background;
  if (isHex(raw.colour)) out.colour = raw.colour;

  if (typeof raw.layerRange === 'object' && raw.layerRange !== null
    && Number.isInteger(raw.layerRange[0]) && Number.isInteger(raw.layerRange[1])) {
    out.layerRange = [raw.layerRange[0], raw.layerRange[1]];
  }
  if (typeof raw.dimBelow === 'boolean') out.dimBelow = raw.dimBelow;

  if (typeof raw.camera === 'object' && raw.camera !== null) {
    const yaw = raw.camera.yaw;
    const pitch = raw.camera.pitch;
    // The camera's pitch is clamped shy of the poles by the viewer; a stored value
    // beyond that would be silently clamped on the way in anyway, so it is
    // accepted here and left to the viewer.
    if (Number.isFinite(yaw) && Number.isFinite(pitch)) {
      const camera = { yaw, pitch };
      // Zoom and pan are validated on their own, and each is optional. A blob
      // written before they were stored has neither, and must still open on the
      // angle it does have -- dropping the whole camera because a field it never
      // had is missing would throw away good data. That is also why the version
      // is not bumped: the shape only grew, and the old files stay readable.
      if (Number.isFinite(raw.camera.zoom) && raw.camera.zoom > 0) {
        camera.zoom = raw.camera.zoom;
      }
      const pan = raw.camera.pan;
      if (Array.isArray(pan) && pan.length === 3 && pan.every((value) => Number.isFinite(value))) {
        camera.pan = [pan[0], pan[1], pan[2]];
      }
      out.camera = camera;
    }
  }

  if (Array.isArray(raw.surfaces)) {
    const surfaces = [];
    for (const entry of raw.surfaces.slice(0, 8)) {
      if (typeof entry !== 'object' || entry === null) {
        surfaces.push({ matte: 0.5, metalness: 0, transparency: 0 });
        continue;
      }
      surfaces.push({
        matte: clampNumber(entry.matte, 0.04, 1, 0.5),
        metalness: clampNumber(entry.metalness, 0, 1, 0),
        transparency: clampNumber(entry.transparency, 0, 1, 0),
      });
    }
    out.surfaces = surfaces;
  }

  if (typeof raw.lightLevel === 'number') out.lightLevel = clampNumber(raw.lightLevel, 0.2, 2, 1);

  // The tour: a list of recorded cameras and how long to fly through them. Stored
  // per file because it is a judgement about *this* print -- which corners are
  // worth showing is different for a carabiner and a phone stand -- and because a
  // tour that survived a change of file would fly to angles that mean nothing on
  // the next one.
  if (Array.isArray(raw.tour)) {
    const tour = [];
    for (const entry of raw.tour.slice(0, MAX_TOUR_VIEWS)) {
      if (typeof entry !== 'object' || entry === null) continue;
      if (!Number.isFinite(entry.yaw) || !Number.isFinite(entry.pitch)) continue;
      const view = { yaw: entry.yaw, pitch: entry.pitch };
      if (Number.isFinite(entry.zoom) && entry.zoom > 0) view.zoom = entry.zoom;
      if (Array.isArray(entry.pan) && entry.pan.length === 3
        && entry.pan.every((value) => Number.isFinite(value))) {
        view.pan = [entry.pan[0], entry.pan[1], entry.pan[2]];
      }
      tour.push(view);
    }
    if (tour.length > 0) out.tour = tour;
  }
  if (typeof raw.tourDuration === 'number') {
    out.tourDuration = clampNumber(raw.tourDuration, 800, 60000, 4000);
  }
  if (typeof raw.spinSpeed === 'number') {
    out.spinSpeed = clampNumber(raw.spinSpeed, 0.05, 3, 0.4);
  }

  if (typeof raw.paletteOverrides === 'object' && raw.paletteOverrides !== null) {
    const overrides = {};
    for (const [slot, hex] of Object.entries(raw.paletteOverrides)) {
      const index = Number(slot);
      // The slot is a palette index, and a palette has at most eight entries.
      if (!Number.isInteger(index) || index < 0 || index > 7) continue;
      if (!isHex(hex)) continue;
      overrides[index] = hex;
    }
    out.paletteOverrides = overrides;
  }

  return out;
}

/** Serialise a snapshot, dropping `undefined` so the stored text stays small. */
export function serialise(snapshot) {
  return JSON.stringify({ ...snapshot, version: STORE_VERSION }, (key, value) => (
    value === undefined ? undefined : value
  ));
}

/**
 * Parse and validate one stored blob.
 *
 * @param text - the raw string from storage.
 * @returns the snapshot, or `null` for absent, malformed or outdated data.
 */
export function parseSnapshot(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return validateSnapshot(JSON.parse(text));
  } catch {
    // Hand-edited or truncated JSON. Treat it as absent; the defaults are a
    // perfectly good state to open in.
    return null;
  }
}

/**
 * Coalesce repeated calls into one, on a timer.
 *
 * Orbiting fires a change per pointer move, and a write per move would serialise
 * JSON hundreds of times a second against a synchronous API. Waiting for the
 * gesture to settle is both cheaper and more accurate: only the final camera angle
 * is worth keeping.
 *
 * @param fn - the function to call.
 * @param delay - quiet period, in milliseconds.
 * @returns `{ call, flush, cancel }`; `flush` runs a pending call immediately,
 *   which the panel uses when it is being torn down.
 */
export function debounce(fn, delay = 400) {
  let handle = 0;
  let pending = false;

  const call = () => {
    pending = true;
    if (handle !== 0) return;
    handle = globalThis.setTimeout(() => {
      handle = 0;
      if (!pending) return;
      pending = false;
      fn();
    }, delay);
  };

  const flush = () => {
    if (handle !== 0) {
      globalThis.clearTimeout(handle);
      handle = 0;
    }
    if (!pending) return;
    pending = false;
    fn();
  };

  const cancel = () => {
    if (handle !== 0) {
      globalThis.clearTimeout(handle);
      handle = 0;
    }
    pending = false;
  };

  return { call, flush, cancel };
}
