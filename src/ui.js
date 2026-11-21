/**
 * The DSH sidebar tab, as an adapter over the embeddable panel.
 *
 * All the viewer's behaviour now lives in `embed/`: the engine, the toolbar, the
 * layer slider, the navigation cube. This file is the only part that knows about
 * DSH, and it knows three things -- how to find the tab's file, how to read its
 * bytes, and where to put a `<div>`. That is the whole adapter.
 *
 * The split matters beyond tidiness: the same viewer now runs on a plain page and
 * can be tested in a browser, which the sidebar tab never could be.
 */

import { ViewerPanel, formatSize } from '../embed/src/panel.js';

const FILE_PREFIX = 'dsh-resource://file/';

/**
 * Split a file resource address into its session and path.
 * @param address - a `dsh-resource://file/session/<id>/<path>` address.
 * @returns the parts, or `undefined` for any other shape.
 */
export function parseFileAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined;
  const end = address.search(/[?#]/);
  const [scope, ...rest] = address.slice(FILE_PREFIX.length, end === -1 ? undefined : end).split('/');
  if (scope !== 'session') return undefined;
  const [sessionId, ...segments] = rest;
  if (sessionId === undefined || sessionId === '' || segments.length === 0) return undefined;
  try {
    return { sessionId: decodeURIComponent(sessionId), path: segments.map(decodeURIComponent).join('/') };
  } catch {
    return undefined;
  }
}

/**
 * Build the tab's components bound to one React copy.
 *
 * React appears in exactly one place: a component whose body mounts the panel into
 * a `<div>`. Everything below that is framework-free, so the component has no
 * state to keep in sync with the panel -- the panel owns it all, and reports back
 * through `onStatus`.
 *
 * @param React - the browser module table's React.
 * @returns the two components the sidebar seats need.
 */
export function createModelUI(React) {
  const h = React.createElement;

  /**
   * The tab body.
   *
   * Unlike the old component this one has no state at all: the panel is created
   * once per mounted div and disposed with it, and it drives itself. React is used
   * for its lifetime management, not for rendering.
   */
  function ModelViewer(props) {
    const { useTabInfo, t, readModel, locales } = props;
    const { tab } = useTabInfo();
    const address = tab.contentId;
    const hostRef = React.useRef(null);

    React.useEffect(() => {
      // React attaches the ref before effects run, so this is populated here. The
      // guard is for the case where the div was never mounted at all.
      const host = hostRef.current;
      if (host === null || host === undefined) return undefined;
      const file = parseFileAddress(address);
      if (file === undefined) return undefined;

      const controller = new AbortController();
      const panel = new ViewerPanel(host, {
        // The host already knows how to read a session file; the loader accepts
        // that as a function and takes the bytes it returns, so nothing here has
        // to know about `remote.workspaceFiles`.
        source: () => readModel(file, controller.signal).then((parsed) => {
          // The parse has already happened inside `readModel`, so hand the panel
          // the result rather than the bytes: re-parsing here would read and
          // inflate the file twice.
          return { parsed };
        }),
        signal: controller.signal,
        t,
        locales,
        fileName: file.path.split('/').pop() ?? file.path,
        // The source is a reader function, which carries no identity of its own, so
        // the file's own address is passed as the settings key. Without this the
        // panel would derive nothing, disable remembering, and quietly forget every
        // change the moment the tab closed.
        storageKey: `${file.sessionId}/${file.path}`,
      });

      return () => {
        controller.abort();
        panel.dispose();
      };
    }, [address, readModel, t, locales]);

    return h('div', {
      ref: hostRef,
      'data-model3d-host': true,
      style: { display: 'block', height: '100%', minHeight: '0', overflow: 'hidden' },
    });
  }

  /** The tab title: the file's basename, so a strip of tabs stays readable. */
  function ModelTitle(props) {
    const { useTabInfo } = props;
    const { tab } = useTabInfo();
    const file = parseFileAddress(tab.contentId);
    const name = file === undefined ? tab.contentId : (file.path.split('/').pop() ?? tab.contentId);
    return h('span', {
      style: {
        display: 'inline-block',
        maxWidth: '220px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        verticalAlign: 'bottom',
      },
      title: name,
    }, name);
  }

  return { ModelViewer, ModelTitle, formatSize };
}
