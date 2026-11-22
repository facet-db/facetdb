import { Button, StatusWord } from "@facetdb/ui";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type AlertChannel, ApiError } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { whenWords } from "../decisions/index.ts";
import {
  channelState,
  channelTitle,
  channelWords,
  lastWords,
  quietWords,
  SENDS_WORDS,
} from "./words.ts";

/**
 * One channel as the mockup draws it: its name and state, what it sends, its quiet hours in their
 * zone, the newest thing it was sent (in the channel's own words when that failed), Send a test and
 * Edit, and the test's answer under the row. A test is not an alert: it is never recorded, so
 * nothing of it reaches the events below.
 */

type Tested =
  | { readonly kind: "sent"; readonly at: number }
  | { readonly kind: "failed"; readonly at: number; readonly words: string }
  | { readonly kind: "not-sent"; readonly at: number; readonly words: string };

/** The answer to a test send in words: the channel's own when it refused, the worker's otherwise. */
function testedOf(error: unknown, address: string, at: number): Tested {
  if (!(error instanceof ApiError)) {
    return {
      kind: "not-sent",
      at,
      words: "The worker could not be reached, so no test was sent.",
    };
  }
  return error.code === "channel_failed"
    ? { kind: "failed", at, words: channelWords(error.message, address) }
    : { kind: "not-sent", at, words: `${error.message} ${error.fix}` };
}

export function ChannelRow({
  channel,
  address,
  workerZone,
  now,
  onEdit,
}: {
  readonly channel: AlertChannel;
  /** The address a test is sent to: the channel's, or the file's for one the page withholds. */
  readonly address: string | null;
  readonly workerZone: string | null;
  readonly now: Date;
  /** Opens the channel's form; null while the file's channels are not known. */
  readonly onEdit: (() => void) | null;
}) {
  const headingId = useId();
  const api = useApi();
  const schedule = useSchedule();
  const [tested, setTested] = useState<Tested | null>(null);
  const test = useMutation({
    mutationFn: (to: string) => api.testAlertChannel(to),
    onSuccess: () => {
      setTested({ kind: "sent", at: schedule.now() });
    },
    onError: (error, to) => {
      setTested(testedOf(error, to, schedule.now()));
    },
  });
  const state = channelState(channel);
  const last = lastWords(channel, now);
  return (
    <article
      aria-labelledby={headingId}
      className="grid gap-x-6 gap-y-2 border-t border-hairline py-5.5 first:border-t-0 first:pt-1 min-[760px]:grid-cols-[180px_minmax(0,1fr)_auto]"
    >
      <div className="grid content-start justify-items-start gap-1">
        <h3 id={headingId} className="mb-1 break-words text-[17px] font-bold tracking-tight">
          {channelTitle(channel)}
        </h3>
        <StatusWord status={state.status} label={state.label} size="small" />
      </div>
      <dl className="m-0 grid content-start items-baseline gap-x-4 gap-y-1.5 min-[600px]:grid-cols-[110px_minmax(0,1fr)]">
        <dt className="text-text-2">Sends</dt>
        <dd className="m-0">{SENDS_WORDS[channel.sends]}</dd>
        {channel.quiet === null ? null : (
          <>
            <dt className="text-text-2">Quiet hours</dt>
            <dd className="m-0 break-words">{quietWords(channel.quiet, workerZone)}</dd>
          </>
        )}
        {last === null ? null : (
          <>
            <dt className="text-text-2">Last</dt>
            <dd className="m-0 break-words">{last}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2 min-[760px]:justify-end">
        <Button
          size="small"
          disabled={test.isPending || address === null}
          onClick={() => {
            if (address !== null) {
              test.mutate(address);
            }
          }}
        >
          {test.isPending ? "Sending" : "Send a test"}
          {/* The button says whose test it is: a page of channels has one per row. */}
          <span className="sr-only"> through {channelTitle(channel)}</span>
        </Button>
        {onEdit === null ? null : (
          <Button size="small" variant="quiet" onClick={onEdit}>
            Edit<span className="sr-only"> {channelTitle(channel)}</span>
          </Button>
        )}
      </div>
      <p
        role="status"
        // Always there, so a screen reader hears the answer arrive; empty, it takes no line.
        className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 min-[760px]:col-[2/-1]"
      >
        {tested === null || test.isPending ? null : (
          <>
            <StatusWord
              status={tested.kind === "sent" ? "done" : "error"}
              label={
                tested.kind === "sent"
                  ? "Test sent"
                  : tested.kind === "failed"
                    ? "Test failed"
                    : "Not sent"
              }
              size="small"
            />
            <span className="text-text-2">
              {tested.kind === "sent"
                ? whenWords(new Date(tested.at), now)
                : `${whenWords(new Date(tested.at), now)}: ${tested.words}`}
            </span>
          </>
        )}
      </p>
    </article>
  );
}
