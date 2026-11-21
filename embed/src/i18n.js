/**
 * The panel's own text, for use outside a host that provides a translator.
 *
 * In the DSH plugin the host owns the dictionaries: the same JSON files are
 * registered under a locale namespace and `t` arrives as an argument. A page
 * that just includes the script has no such host, so it needs a tiny translator
 * of its own -- and it must resolve `{name}` placeholders the same way the host
 * does, or the two would show different text for the same view.
 */

/** Replace `{key}` placeholders with the matching value. */
export function interpolate(template, params) {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Build a translator over one dictionary.
 *
 * @param dictionary - flat `key: text` map in the active language.
 * @param fallback - the English map, consulted when a key is missing. A partial
 *   translation should show English rather than a raw key.
 * @returns a `t` function matching the host's: `t(key, params)`.
 */
export function createTranslator(dictionary, fallback) {
  return (key, params) => {
    const template = dictionary[key] ?? fallback?.[key] ?? key;
    return interpolate(template, params);
  };
}

/**
 * Dictionaries bundled with the build, once a host attaches them.
 *
 * Held at module level rather than threaded through every call, because it is a
 * property of the build, not of one panel: a page that includes the script has
 * both languages available and should get them by default, whether it creates the
 * panel with `mount()` or through the element. A host with its own translator
 * passes `t` and this is never consulted.
 */
let bundledLocales;

/** Attach the bundled dictionaries for every panel created afterwards. */
export function setBundledLocales(locales) {
  bundledLocales = locales;
  return locales;
}

/** The dictionaries in force, or `undefined` when none were attached. */
export function getBundledLocales() {
  return bundledLocales;
}

/**
 * Choose a dictionary from a language tag.
 *
 * Only whole-language matching is attempted: the panel has no regional copy, so
 * `ru-RU`, `ru` and `RU` all mean Russian, and anything else means English. A
 * fuzzy locale negotiation here would be inventing a promise the dictionaries
 * cannot keep.
 *
 * @param locales - dictionaries keyed by language id.
 * @param tag - a BCP 47 tag, or a list of them in preference order.
 * @returns the matching dictionary, or English when nothing matches.
 */
export function pickDictionary(locales, tag) {
  const candidates = Array.isArray(tag) ? tag : [tag];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const language = candidate.toLowerCase().split(/[-_]/)[0];
    if (Object.prototype.hasOwnProperty.call(locales, language)) return locales[language];
  }
  return locales.en;
}
