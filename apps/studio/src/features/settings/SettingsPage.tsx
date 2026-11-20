import { Tag } from "@facetdb/ui";
import { useId } from "react";
import { PageHead } from "../../shell/index.ts";
import { AccessSection } from "./AccessSection.tsx";
import { ReviewersSection } from "./ReviewersSection.tsx";
import { SpendingSection } from "./SpendingSection.tsx";

/**
 * The Settings page: who may review, what the project may spend, how this studio is reached, and
 * the parts that are FacetDB Cloud's, marked as such and described, not built. Plain forms on the
 * one canvas, ruled apart; no primary action, since nothing on the page is the thing to do next.
 */

function CloudSection() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-lg font-bold tracking-tight">
          Members, environments, billing, retention
        </h2>
        <Tag tone="cloud">Cloud</Tag>
      </div>
      <p className="max-w-[64ch] text-text-2">
        Roles and invitations, dev, staging and production environments, invoices, and how long
        history is kept are FacetDB Cloud features. Open source keeps the whole log in your own
        database for as long as you keep it.
      </p>
    </section>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHead
        title="Settings"
        lede="Who may review, what the project may spend, and how this studio is reached."
      />
      <div className="grid max-w-[760px] [&>section]:border-t [&>section]:border-hairline [&>section]:py-7 [&>section:first-child]:border-t-0 [&>section:first-child]:pt-1">
        <ReviewersSection />
        <SpendingSection />
        <AccessSection />
        <CloudSection />
      </div>
    </>
  );
}
