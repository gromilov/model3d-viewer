/**
 * Getting bytes to the parser.
 *
 * The parsers want a `Uint8Array` and a file name; how those arrive differs by
 * host. A web page has a URL, a file picker hands over a `File`, a host
 * integration may have read the bytes already, and a host with its own transport
 * has none of those. Rather than make the panel know about all four, a source is
 * normalised once here and the panel only ever sees a function that resolves to
 * `{ name, bytes }`.
 */

/** Read a URL into bytes, reporting a useful message on a bad response. */
async function fetchBytes(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Normalise any supported source into a loader.
 *
 * The forms accepted:
 *
 *   - a string or `URL` -- fetched, with `requestInit` passed through;
 *   - a `File` or `Blob` -- read directly, named from the file when it has one;
 *   - an `ArrayBuffer`, typed array or `Uint8Array` -- already in memory;
 *   - an object `{ name, url }`, `{ name, bytes }`, `{ name, blob }` -- for a
 *     source that needs its own display name, which a bare URL lacks;
 *   - an object `{ name, parsed }` -- a host that has already run the parser.
 *     The DSH tab does this: its transport hands back bytes and the host parses
 *     them on the way in, so re-parsing here would inflate a 3 MF twice;
 *   - a function -- a host that reads through its own transport returns bytes
 *     from it. It may return any of the forms above, or resolve to them.
 *
 * @param source - any accepted form.
 * @param options - `requestInit` for the fetch path, `signal` to abort it.
 * @returns `async () => ({ name, bytes })`, memoised so a re-render does not
 *   fetch twice.
 */
export function createLoader(source, options = {}) {
  if (typeof source === 'function') {
    // A host transport. Whatever it returns is normalised by the branches below,
    // so a host may return a URL, a Blob or bytes without knowing that.
    let inner;
    return () => {
      inner ??= (async () => {
        const resolved = await source(options.signal);
        if (resolved === undefined || resolved === null) {
          throw new Error('The source returned nothing to show');
        }
        return createLoader(resolved, options)();
      })();
      return inner;
    };
  }

  return async () => {
    if (typeof source === 'string' || (typeof URL !== 'undefined' && source instanceof URL)) {
      const url = String(source);
      const name = url.split(/[?#]/)[0].split('/').pop() || 'model';
      return { name, bytes: await fetchBytes(url, { signal: options.signal, ...options.requestInit }) };
    }

    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      // A `File` is a `Blob` with a name; a plain `Blob` gets a neutral one, and
      // the parser falls back to sniffing the bytes for the format.
      const name = typeof source.name === 'string' && source.name !== '' ? source.name : 'model';
      return { name, bytes: new Uint8Array(await source.arrayBuffer()) };
    }

    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      const bytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      return { name: 'model', bytes };
    }

    if (typeof source === 'object' && source !== null) {
      const name = typeof source.name === 'string' ? source.name : 'model';
      // Already parsed by the host: pass the model straight through, tagged so
      // the panel knows not to parse it again.
      if (source.parsed !== undefined) {
        return { name, parsed: source.parsed };
      }
      if (source.bytes !== undefined) {
        const bytes = source.bytes instanceof ArrayBuffer
          ? new Uint8Array(source.bytes)
          : new Uint8Array(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
        return { name, bytes };
      }
      if (source.blob !== undefined) {
        return { name, bytes: new Uint8Array(await source.blob.arrayBuffer()) };
      }
      if (source.url !== undefined) {
        return { name, bytes: await fetchBytes(String(source.url), { signal: options.signal, ...options.requestInit }) };
      }
    }

    throw new Error('Unsupported source: expected a URL, a File, bytes or a loader function');
  };
}

/**
 * Whether a path or name looks like something this viewer can open.
 *
 * The panel uses a `.gcode` file's own name only for display; the format is
 * decided by the parser from the bytes, because a 3MF may carry a sliced plate
 * and a `.gcode` is read as text.
 */
export const MODEL_EXTENSIONS = /\.(stl|3mf|gcode)$/i;

/** Whether a name is a model the viewer claims. */
export function isModelName(name) {
  return typeof name === 'string' && MODEL_EXTENSIONS.test(name);
}
