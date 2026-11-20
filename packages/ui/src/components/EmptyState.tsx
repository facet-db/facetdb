import type { ReactNode } from "react";
import { type DitherContextFactory, DitherStrip } from "../dither/index.ts";

export type EmptyStateProps = {
  title: string;
  // The one sentence.
  children: ReactNode;
  // The one action: a Button, or a link made to look like one.
  action?: ReactNode;
  // The title's heading level in the page's outline.
  level?: 2 | 3;
  // Passed to the cloud (tests pass fakes; by default the device's).
  ratio?: number;
  context?: DitherContextFactory;
};

// The cloud is a 240 x 72 px field at 12% density (the mockups'): TypeSafe's sky, monochrome.
const cloud = { width: 240, rows: 36, value: 0.12 } as const;

// A low-density dither cloud with a title, one sentence and one action. The cloud is decoration, so
// a screen reader skips it; the words carry the state.
export function EmptyState({
  title,
  children,
  action,
  level = 2,
  ratio,
  context,
}: EmptyStateProps) {
  const Heading = level === 2 ? "h2" : "h3";
  const meter = {
    ...(ratio === undefined ? {} : { ratio }),
    ...(context === undefined ? {} : { context }),
  };
  return (
    <div className="fdb-empty">
      <span className="fdb-empty-cloud" aria-hidden="true">
        <DitherStrip
          value={cloud.value}
          label="A low-density dither cloud"
          width={cloud.width}
          rows={cloud.rows}
          {...meter}
        />
      </span>
      <Heading className="fdb-empty-title">{title}</Heading>
      <p className="fdb-empty-text">{children}</p>
      {action}
    </div>
  );
}
