import { DitherStrip } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId } from "react";
import { homeQuery } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { spendingConfigQuery } from "./queries.ts";
import { Unreachable } from "./Unreachable.tsx";
import { AT_CAP_WORDS, fileDiffersFromWorker, fileSetsWords, money, tokenWords } from "./words.ts";

/**
 * The spending cap, shown as the worker enforces it: the cap, what happens at 100% and the month's
 * spending from `GET /v1/home` (the page computes no figure). The worker keeps the cap it started
 * with until it is restarted, whatever a reload of the file has read since; `GET /v1/config` serves
 * the file as it reads now, so it is only compared: when the file sets something else the page says
 * so, and that a restart applies it.
 *
 * It is not a form. The studio's Apply writes one source at a time (a draft is merged over a source
 * and the project is read back; `spendingCap` and `onCapReached` belong to the project, and a
 * source takes neither), so a "Save" here would have nothing to save through. The page says where
 * the cap lives and what to do, rather than offer a control that writes nothing.
 */

const STRIP_WIDTH = 200;

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1 min-[600px]:grid-cols-[130px_minmax(0,1fr)]">
      <dt className="text-text-2">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

export function SpendingSection() {
  const api = useApi();
  const schedule = useSchedule();
  const file = useQuery(spendingConfigQuery(api));
  const home = useQuery(homeQuery(api));
  const headingId = useId();
  const now = new Date(schedule.now());
  const spending = home.data?.spending;
  const inForce = spending?.cap;
  // What the file sets, in words, when that is not what the worker enforces.
  const fileSets =
    inForce !== undefined && file.data !== undefined && fileDiffersFromWorker(inForce, file.data)
      ? fileSetsWords(file.data)
      : null;
  const failed = home.isError ? home : file.isError ? file : undefined;
  return (
    <section aria-labelledby={headingId} className="grid gap-4">
      <h2 id={headingId} className="text-lg font-bold tracking-tight">
        Spending cap
      </h2>
      {failed === undefined ? null : (
        <Unreachable
          what={failed === file ? "The cap in facetdb.config.ts" : "The spending cap"}
          error={failed.error}
          lastKnownAt={failed.data === undefined ? undefined : failed.dataUpdatedAt}
          now={now}
          retry={() => {
            void failed.refetch();
          }}
        />
      )}
      {spending === undefined ? (
        home.isError ? null : (
          <p role="status" className="text-text-2">
            Reading the cap.
          </p>
        )
      ) : (
        <dl className="m-0 grid gap-3">
          <Line label="Monthly cap">
            {spending.cap === null ? (
              "None set, so the project never pauses."
            ) : (
              <>
                <span className="font-mono font-semibold">{money(spending.cap.dollars)}</span>
                {", "}
                {tokenWords(spending.cap.inputTokens)}
              </>
            )}
          </Line>
          {spending.cap === null ? null : (
            <Line label="At 100%">{AT_CAP_WORDS[spending.cap.onCapReached]}</Line>
          )}
          <Line label="This month">
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-mono font-semibold">{spending.words.figure}</span>
              {spending.fraction === null ? null : (
                <DitherStrip
                  value={spending.fraction}
                  width={STRIP_WIDTH}
                  rows={4}
                  label={spending.words.sub}
                />
              )}
              <span
                className="text-text-2"
                aria-hidden={spending.fraction === null ? undefined : true}
              >
                {spending.words.sub}
              </span>
            </span>
          </Line>
        </dl>
      )}
      {fileSets === null ? null : (
        <p role="status" className="max-w-[64ch] border-l-2 border-facet pl-3">
          {`facetdb.config.ts sets ${fileSets}; restart the worker to apply it. The cap above is the one the worker is enforcing now.`}
        </p>
      )}
      <p className="max-w-[64ch] text-text-2">
        The cap is set in <code>facetdb.config.ts</code> and the worker reads it when it starts. To
        change it, edit <code>spendingCap</code> (billable input tokens) and{" "}
        <code>onCapReached</code> (<code>"pause"</code> or <code>"continue"</code>) there, then
        restart the worker. The studio's Apply writes one source at a time, so it cannot change a
        project setting. A warning goes out at 80% of the cap.
      </p>
    </section>
  );
}
