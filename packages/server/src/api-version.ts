/**
 * The path prefix of every endpoint; a breaking change makes a new one beside it. Its own module so
 * a feature's routes can name their full path (hooks/routes.ts, which the HTTP adapter caps by it)
 * without importing app.ts, which imports them.
 */
export const API_VERSION = "v1";
