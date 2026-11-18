/**
 * Node's process warnings, as `facetdb` prints them. A `facetdb.config.ts` in a project whose
 * package.json has no `"type"` makes Node say, on stderr, that it reparsed the file as an ES module
 * (`MODULE_TYPELESS_PACKAGE_JSON`): four lines before every command, about a file FacetDB loads
 * through type stripping on purpose. Node's printer is the `warning` listener it installs at
 * startup, and it carries Node's own handling (`--disable-warning`, `--redirect-warnings`, the
 * trace flags); so the printer is kept and called for every warning but that one code, never
 * written again here. When Node installed no printer (`--no-warnings`, `NODE_NO_WARNINGS=1`),
 * nothing changes: the operator asked for silence.
 */

/** The code of the warning dropped: a config file in a package with no `"type"`. */
export const TYPELESS_PACKAGE_WARNING = "MODULE_TYPELESS_PACKAGE_JSON";

type WarningListener = (warning: Error) => void;

/** The part of `process` the filter touches; a test passes its own emitter. */
export type WarningEmitter = {
  listeners(event: "warning"): readonly WarningListener[];
  removeListener(event: "warning", listener: WarningListener): unknown;
  on(event: "warning", listener: WarningListener): unknown;
};

/**
 * Puts a filter in front of the `warning` listeners `emitter` has now (Node's printer): each is
 * called, in order, with every warning but `MODULE_TYPELESS_PACKAGE_JSON`. Returns whether there
 * was a listener to filter.
 */
export function quietTypelessPackageWarning(emitter: WarningEmitter): boolean {
  const printers = [...emitter.listeners("warning")];
  if (printers.length === 0) {
    return false;
  }
  for (const printer of printers) {
    emitter.removeListener("warning", printer);
  }
  emitter.on("warning", (warning) => {
    if ((warning as { readonly code?: unknown }).code === TYPELESS_PACKAGE_WARNING) {
      return;
    }
    for (const printer of printers) {
      printer(warning);
    }
  });
  return true;
}
