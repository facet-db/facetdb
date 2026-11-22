import { focusBrackets, StatusWord } from "@facetdb/ui";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import type { InstalledPlugin, InstalledPlugins } from "../../api/index.ts";
import { PluginSettings } from "./PluginSettings.tsx";
import { settingsOf } from "./settings.ts";
import { notMadeForFix, notMadeForWords, providesWords } from "./words.ts";

/**
 * The installed plugins: each on one line, its name, what it provides, a badge only when its core
 * range no longer holds, and its version ("built in" for the webhook); its settings behind the
 * line, a disclosure closed by default that the line itself opens (a native summary: Enter and
 * Space, the focus as corner brackets). A plugin with nothing to show behind it is a line that
 * opens nothing. Where settings change, and why, is said once above.
 */

/** One line: the mockup's five columns on a wide screen; on a phone what it provides goes under. */
const LINE =
  "grid grid-cols-[minmax(0,1fr)_auto_auto_12px] items-baseline gap-x-5 gap-y-1 py-3.5 min-[900px]:grid-cols-[120px_minmax(0,1fr)_auto_64px_12px]";

function Cells({
  plugin,
  facetdb,
  none,
}: {
  readonly plugin: InstalledPlugin;
  readonly facetdb: string;
  /** It has nothing behind its line. */
  readonly none: boolean;
}) {
  // The spaces between the cells are for a screen reader and a copy: the grid's gap draws them.
  return (
    <>
      <span className="min-w-0 font-bold wrap-anywhere">{plugin.name}</span>{" "}
      <span className="order-1 col-span-full min-w-0 text-text-2 min-[900px]:order-none min-[900px]:col-span-1">
        {providesWords(plugin.provides)}
      </span>{" "}
      <span>
        {plugin.core.holds ? (
          none ? (
            <span className="text-[12.5px] text-text-3">No settings</span>
          ) : null
        ) : (
          <StatusWord status="error" label={notMadeForWords(facetdb)} size="small" />
        )}
      </span>{" "}
      <span className="justify-self-end">
        {plugin.builtIn ? (
          <span className="text-[12.5px] text-text-3">built in</span>
        ) : (
          <span className="font-mono text-[12.5px]">{plugin.version}</span>
        )}
      </span>
    </>
  );
}

function PluginLine({
  plugin,
  facetdb,
}: {
  readonly plugin: InstalledPlugin;
  readonly facetdb: string;
}) {
  const none = settingsOf(plugin).length === 0;
  if (none && plugin.core.holds) {
    return (
      <div className={LINE}>
        <Cells plugin={plugin} facetdb={facetdb} none />
        <span />
      </div>
    );
  }
  return (
    <details className="group">
      <summary
        className={`${focusBrackets} ${LINE} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        <Cells plugin={plugin} facetdb={facetdb} none={none} />
        <ChevronDown
          size={12}
          strokeWidth={1.6}
          aria-hidden
          className="self-center text-text-3 group-open:rotate-180"
        />
      </summary>
      <div className="grid gap-3.5 pt-0.5 pb-5.5 min-[900px]:pl-[140px]">
        {plugin.core.holds ? null : (
          <div className="grid justify-items-start gap-1.5 border-l-2 border-no pl-3">
            <p className="m-0 max-w-[68ch]">
              Made for FacetDB <code>{plugin.core.range}</code>
              {notMadeForFix(facetdb)}
            </p>
          </div>
        )}
        {none ? null : <PluginSettings plugin={plugin} />}
      </div>
    </details>
  );
}

export function InstalledList({ installed }: { readonly installed: InstalledPlugins }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-lg font-bold tracking-tight">
        Installed
      </h2>
      <p className="mt-1.5 mb-4 max-w-[64ch] text-text-2">
        Settings are changed in facetdb.config.ts, since they can decide where a token or your data
        goes. A plugin can mark some editable here.
      </p>
      <ul className="m-0 list-none border-y border-hairline p-0">
        {installed.plugins.map((plugin) => (
          <li key={plugin.key} className="border-t border-hairline first:border-t-0">
            <PluginLine plugin={plugin} facetdb={installed.facetdb} />
          </li>
        ))}
      </ul>
    </section>
  );
}
