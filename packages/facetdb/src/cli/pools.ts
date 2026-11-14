import type { SqlClient, SqlConnect } from "@facetdb/postgres";

/**
 * Postgres pools shared by URL, for the composition root. A command opens a pool by asking for a
 * size (`{ max }`, the worker's store pool); while it is open, every other connection to the same
 * URL borrows it instead of opening its own: the store, the outbox, and the Postgres engine's
 * connector of a table source on the store's own database (Supabase's session pooler serves about
 * 15 connections per user and database, and two pools of ten plus LISTEN would pass it). Since the
 * engine opens its connectors with the driver it was built with, the sharing lives here, below
 * every engine, instead of in the worker. A pool closes when the last holder lets go; a connection
 * asked for without a size, with no pool open for its URL, is its own.
 */

type Shared = { readonly client: SqlClient; holders: number };

/** `connect` with pools shared by URL; the composition root and the tests wire the same. */
export function sharePools(connect: SqlConnect): SqlConnect {
  const pools = new Map<string, Shared>();

  function borrow(url: string, shared: Shared): SqlClient {
    shared.holders += 1;
    let released = false;
    return {
      ...shared.client,
      close: async () => {
        if (released) {
          return;
        }
        released = true;
        shared.holders -= 1;
        if (shared.holders === 0 && pools.get(url) === shared) {
          pools.delete(url);
          await shared.client.close();
        }
      },
    };
  }

  return (url, options) => {
    const open = pools.get(url);
    if (open !== undefined) {
      return borrow(url, open);
    }
    if (options?.max === undefined) {
      return connect(url, options);
    }
    const shared: Shared = { client: connect(url, options), holders: 0 };
    pools.set(url, shared);
    return borrow(url, shared);
  };
}
