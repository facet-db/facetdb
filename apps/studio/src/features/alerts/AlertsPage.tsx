import {
  Button,
  EmptyState,
  focusBrackets,
  SelfFillingTable,
  StatusWord,
  type TableColumn,
  Tag,
} from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { AlertChannel, AlertEvent } from "../../api/index.ts";
import { useApi, useDeps } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Moment, whenWords, ZoneNote } from "../decisions/index.ts";
import { followable } from "../home/index.ts";
import { Unreachable } from "../settings/index.ts";
import { alertsQuery } from "./queries.ts";
import { channelTitle, whereOf } from "./words.ts";

/**
 * The Alerts page: the channels the config names, and what has happened, every alert in the same
 * shape (what happened, where, what FacetDB did, one link). The channels are ruled rows, the events
 * a full-grid table. Channels that deliver, quiet hours and the test button belong to the channel
 * plugins, so each says so and none pretends: a channel here is named in the config and nothing
 * more.
 */

/** The channels listed are the ones the worker runs with; the file may have moved on. */
const CHANNELS_DIFFER_WORDS =
  "facetdb.config.ts names other channels than the ones listed, which are the ones the worker runs with. Restart the worker to apply the file's.";
const QUIET_HOURS_WORDS = "Arrive in a later version, with the channel plugins.";
const TEST_WORDS =
  "Test messages arrive in a later version, with the channel plugins. Nothing was sent.";

function ChannelRow({ channel }: { readonly channel: AlertChannel }) {
  const headingId = useId();
  const [tried, setTried] = useState(false);
  return (
    <article
      aria-labelledby={headingId}
      className="grid gap-x-6 gap-y-3 border-t border-hairline py-5 first:border-t-0 first:pt-1 min-[760px]:grid-cols-[210px_minmax(0,1fr)_auto]"
    >
      <div className="grid content-start justify-items-start gap-2">
        <h3 id={headingId} className="break-words text-[17px] font-bold tracking-tight">
          {channelTitle(channel)}
        </h3>
        <Tag>Not delivering yet</Tag>
      </div>
      <dl className="m-0 grid content-start gap-x-4 gap-y-1.5 min-[600px]:grid-cols-[110px_minmax(0,1fr)]">
        <dt className="text-text-2">Sends</dt>
        <dd className="m-0">
          Nothing yet: delivery to a channel arrives in a later version. Until then an alert is
          recorded in the history below and printed by the worker.
        </dd>
        <dt className="text-text-2">Quiet hours</dt>
        <dd className="m-0">{QUIET_HOURS_WORDS}</dd>
      </dl>
      <div className="min-[760px]:justify-self-end">
        <Button
          size="small"
          onClick={() => {
            setTried(true);
          }}
        >
          Send a test
        </Button>
      </div>
      <p role="status" className="text-text-2 min-[760px]:col-span-3">
        {tried ? TEST_WORDS : ""}
      </p>
    </article>
  );
}

function Channels({ channels }: { readonly channels: readonly AlertChannel[] }) {
  if (channels.length === 0) {
    return (
      <EmptyState title="No channel is named" level={3}>
        Alerts are recorded below and printed by the worker. To name a channel, add it to
        alerts.channels in facetdb.config.ts, for example "slack:#ops"; delivery arrives in a later
        version.
      </EmptyState>
    );
  }
  return (
    <div>
      {channels.map((channel, index) => (
        // Two channels of one kind and name may be written twice; the position tells them apart.
        <ChannelRow
          key={`${channel.kind}|${channel.name ?? ""}|${String(index)}`}
          channel={channel}
        />
      ))}
    </div>
  );
}

/**
 * How an alert stands. Only a kind the worker resolves can be "not resolved"; one nothing ever
 * resolves (a spending warning, a finished backfill) says it was raised, and claims nothing more.
 */
function Standing({ event, now }: { readonly event: AlertEvent; readonly now: Date }) {
  const { standing } = event;
  return (
    <div className="grid justify-items-start gap-1">
      {standing.phase === "resolved" ? (
        <StatusWord
          status="resolved"
          size="small"
          label={`resolved ${whenWords(new Date(standing.at), now)}`}
        />
      ) : (
        <span className="text-text-2">{standing.phase === "open" ? "not resolved" : "raised"}</span>
      )}
      {event.raisedBeforeHistory ? (
        <span className="text-text-2">raised before the history shown</span>
      ) : null}
      {event.delivered ? null : <span className="text-text-2">no channel took it</span>}
    </div>
  );
}

function Events({
  events,
  now,
  origin,
}: {
  readonly events: readonly AlertEvent[];
  readonly now: Date;
  readonly origin: string;
}) {
  const columns: readonly TableColumn<AlertEvent>[] = [
    {
      kind: "text",
      id: "when",
      header: "When",
      numeric: true,
      cell: (event) => <Moment at={event.at} now={now} />,
    },
    {
      kind: "text",
      id: "event",
      header: "Event",
      cell: (event) => (
        <div className="grid min-w-[16rem] max-w-[24rem] gap-1">
          <strong>{event.title}</strong>
          <span className="text-text-2">{event.what}</span>
        </div>
      ),
    },
    {
      kind: "text",
      id: "severity",
      header: "Severity",
      cell: (event) => <StatusWord status={event.severity} size="small" />,
    },
    { kind: "text", id: "where", header: "Where", cell: (event) => whereOf(event) },
    {
      kind: "text",
      id: "did",
      header: "What FacetDB did",
      cell: (event) => {
        const href = followable(event.link, origin);
        return (
          <div className="grid min-w-[14rem] max-w-[22rem] justify-items-start gap-1">
            <span className="text-text-2">{event.did}</span>
            {href === null ? null : (
              <a
                href={href}
                className={`${focusBrackets} text-text underline decoration-1 underline-offset-4`}
              >
                See details<span className="sr-only"> of {event.title}</span>
              </a>
            )}
          </div>
        );
      },
    },
    {
      kind: "text",
      id: "state",
      header: "State",
      cell: (event) => <Standing event={event} now={now} />,
    },
  ];
  return (
    <SelfFillingTable
      label="Alerts, newest first"
      columns={columns}
      rows={events}
      // Two alerts of one kind can share a second; the position (at most 100 rows) tells them apart.
      rowKey={(event) => `${String(events.indexOf(event))}|${event.at}|${event.kind}`}
    />
  );
}

export function AlertsPage() {
  const api = useApi();
  const { schedule, origin } = useDeps();
  const alerts = useQuery(alertsQuery(api));
  const now = new Date(schedule.now());
  const { data } = alerts;
  return (
    <>
      <PageHead
        title="Alerts"
        lede="Who is told when something breaks, and what has happened so far."
      />
      {alerts.isError ? (
        <div className="mb-6">
          <Unreachable
            what="The alerts"
            error={alerts.error}
            lastKnownAt={data === undefined ? undefined : alerts.dataUpdatedAt}
            now={now}
            retry={() => {
              void alerts.refetch();
            }}
          />
        </div>
      ) : null}
      {data === undefined ? (
        alerts.isError ? null : (
          <p role="status" className="text-text-2">
            Reading the channels and the history.
          </p>
        )
      ) : (
        <>
          <section aria-labelledby="alert-channels">
            <h2 id="alert-channels" className="mb-3.5 text-lg font-bold tracking-tight">
              Channels
            </h2>
            {data.fileChannelsDiffer ? (
              <p role="status" className="mb-3 max-w-[64ch] text-text-2">
                {CHANNELS_DIFFER_WORDS}
              </p>
            ) : null}
            <Channels channels={data.channels} />
          </section>
          <section aria-labelledby="alert-events" className="mt-10">
            <h2 id="alert-events" className="mb-3.5 text-lg font-bold tracking-tight">
              Events
            </h2>
            {data.events.length === 0 ? (
              <EmptyState title="No alerts yet" level={3}>
                Nothing has gone wrong and nothing has finished since this project started.
              </EmptyState>
            ) : (
              <div className="grid gap-3">
                <Events events={data.events} now={now} origin={origin} />
                <ZoneNote />
              </div>
            )}
            <div className="mt-3 grid gap-1.5 text-[12.5px] text-text-2">
              <p>
                One alert per event every 30 minutes until it resolves, then a resolved message.
              </p>
              {data.capped ? (
                <p>
                  {`The newest ${String(data.limit)} lines of the history are read; older events are kept in the store and not shown here.`}
                </p>
              ) : null}
              <p className="flex flex-wrap items-center gap-2">
                <Tag tone="cloud">Cloud</Tag>
                <span>
                  The review-queue and answer-drift alerts are FacetDB Cloud's, so none appears
                  here.
                </span>
              </p>
            </div>
          </section>
        </>
      )}
    </>
  );
}
