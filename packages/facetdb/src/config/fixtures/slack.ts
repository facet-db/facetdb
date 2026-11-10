import { actionCall, type JsonValue } from "facetdb";

/** Stands in for `@facetdb/slack` in the fixture: a function that builds an action call. */
export const slack = {
  notify: (config: { readonly [key: string]: JsonValue }) =>
    actionCall("@facetdb/slack", "notify", config),
};
