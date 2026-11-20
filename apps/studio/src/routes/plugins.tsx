import { Button, EmptyState } from "@facetdb/ui";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHead } from "../shell/index.ts";
import { shellRoute } from "./root.tsx";

// Plugins. Until the plugin system arrives nothing can be installed, so the page says that: an
// honest empty state.
export const pluginsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/plugins",
  component: PluginsPage,
});

const GALLERY_WORDS =
  "The gallery opens in a later version: the registry's index with search, a verified badge and install counts.";

function PluginsPage() {
  const [asked, setAsked] = useState(false);
  return (
    <>
      <PageHead
        title="Plugins"
        lede="Sources such as GitHub, actions such as Slack, and alert channels, each with its own settings form."
      />
      <EmptyState
        title="Nothing installed yet"
        action={
          <Button
            onClick={() => {
              setAsked(true);
            }}
          >
            Browse the gallery
          </Button>
        }
      >
        Plugins arrive in a later version, and nothing can be installed before then. An installed
        plugin will show up here with the settings form its manifest declares.
      </EmptyState>
      <p role="status" className="mx-auto max-w-[44ch] text-center text-text-2">
        {asked ? GALLERY_WORDS : ""}
      </p>
    </>
  );
}
