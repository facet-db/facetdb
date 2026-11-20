import { createRoute } from "@tanstack/react-router";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// "Add a source" on the Sources page opens this setup flow (the mockups' add-source.html). Under
// /sources, so the rail marks Sources. Its content is not built yet.
export const addSourceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/sources/new",
  component: AddSourcePage,
});

function AddSourcePage() {
  return (
    <PageHead
      title="Add a source"
      lede="Connect a table, choose what the model reads, write the questions, watch the preview fill in, and install."
    />
  );
}
