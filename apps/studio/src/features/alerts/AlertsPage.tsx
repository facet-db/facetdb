import {
  Button,
  EmptyState,
  focusBrackets,
  SelfFillingTable,
  StatusWord,
  type TableColumn,
  Tag,
} from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  type AlertChannel,
  type AlertChannelEntry,
  type AlertEvent,
  ApiError,
} from "../../api/index.ts";
import { useApi, useDeps } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Moment, whenWords, ZoneNote } from "../decisions/index.ts";
import { followable } from "../home/index.ts";
import { Unreachable } from "../settings/index.ts";
import { ChannelDialog, type ChannelDialogMode } from "./ChannelDialog.tsx";
import { ChannelRow } from "./ChannelRow.tsx";
import { addressOf, indexInFile } from "./draft.ts";
import { alertsQuery, channelsInFileQuery } from "./queries.ts";
import { heldWords, whereOf } from "./words.ts";

/**
 * The Alerts page: the channels in force, each with its state, what it sends, its quiet hours, the
 * newest thing it was sent, a test send and its form; and what has happened, every alert in the
 * same shape (what happened, where, what FacetDB did, one link). The channels are ruled rows, the
 * events a full-grid table. "Add a channel" and Edit change facetdb.config.ts through Apply, the
 * diff first, and the worker puts the change in force at once, with no restart.
 */

/** A dialog of the page: which form, whether it is open, and its opening (each starts afresh). */
type DialogState = {
  readonly mode: ChannelDialogMode;
  readonly open: boolean;
  readonly opened: number;
};

/**
 * The file names other channels than the ones in force: the worker has not read it since a hand
 * edit, or could not put them in force. Check again asks it to reload, and says what came of it.
 */
function FileDiffers() {
  const api = useApi();
  const queryClient = useQueryClient();
  const reload = useMutation({
    mutationFn: () => api.reload(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });
  const outcome = reload.data;
  return (
    <div className="mb-4 grid max-w-[64ch] justify-items-start gap-2 border-l-2 border-review pl-3">
      <p className="m-0">facetdb.config.ts names other channels than the ones in force.</p>
      <Button size="small" onClick={() => reload.mutate()} disabled={reload.isPending}>
        {reload.isPending ? "Checking" : "Check again"}
      </Button>
      <p role="status" className="m-0 grid gap-1 text-text-2">
        {outcome === undefined ? null : outcome.loaded ? (
          "The file's channels are in force now."
        ) : (
          <>
            <span>{outcome.message}</span>
            <span>{outcome.fix}</span>
          </>
        )}
        {reload.isError
          ? reload.error instanceof ApiError
            ? `${reload.error.message} ${reload.error.fix}`
            : "The worker could not be reached. Try again in a moment."
          : null}
      </p>
    </div>
  );
}

function Channels({
  channels,
  entries,
  workerZone,
  now,
  onAdd,
  onEdit,
}: {
  readonly channels: readonly AlertChannel[];
  /** The channels as the file writes them; undefined while they are read. */
  readonly entries: readonly AlertChannelEntry[] | undefined;
  readonly workerZone: string | null;
  readonly now: Date;
  readonly onAdd: () => void;
  readonly onEdit: (channel: AlertChannel, position: number) => void;
}) {
  if (channels.length === 0) {
    return (
      <EmptyState
        title="No channel yet"
        level={3}
        action={
          <Button variant="primary" onClick={onAdd}>
            Add a channel
          </Button>
        }
      >
        Alerts are only recorded below until a channel tells someone.
      </EmptyState>
    );
  }
  return (
    <div>
      {channels.map((channel, position) => {
        // A channel whose address the page withholds is tested at the file's own address.
        const index = entries === undefined ? -1 : indexInFile(entries, channel, position);
        const entry = index < 0 ? undefined : entries?.[index];
        const address = channel.address ?? (entry === undefined ? null : addressOf(entry));
        return (
          <ChannelRow
            // Two channels of one kind and name cannot be in force at once: the file names each once.
            key={`${channel.kind}|${channel.name ?? ""}|${String(position)}`}
            channel={channel}
            address={address}
            workerZone={workerZone}
            now={now}
            onEdit={() => {
              onEdit(channel, position);
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * How an alert stands. Only a kind the worker resolves can be "not resolved"; one nothing ever
 * resolves (a spending warning, a finished backfill) says it was raised, and claims nothing more.
 */
function Standing({ event, now }: { readonly event: AlertEvent; readonly now: Date }) {
  const { standing } = event;
  const held = heldWords(event.held);
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
      {held === null ? null : <span className="text-[12.5px] text-text-2">{held}</span>}
      {event.raisedBeforeHistory ? (
        <span className="text-text-2">raised before the history shown</span>
      ) : null}
      {event.pending ? (
        <span className="text-text-2">not yet known whether a channel took it</span>
      ) : event.delivered || held !== null ? null : (
        <span className="text-text-2">no channel took it</span>
      )}
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
  const file = useQuery(channelsInFileQuery(api));
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** What the last write put in force, said under the heading until the next one. */
  const [written, setWritten] = useState<string | null>(null);
  const writtenRef = useRef<HTMLParagraphElement>(null);
  const now = new Date(schedule.now());
  const { data } = alerts;
  const open = (mode: ChannelDialogMode) => {
    setDialog((last) => ({ mode, open: true, opened: (last?.opened ?? 0) + 1 }));
  };
  const add = () => {
    open({ kind: "add" });
  };
  // A channel removed takes its Edit button with it: the focus goes to the words the write left.
  useEffect(() => {
    if (written !== null && document.activeElement === document.body) {
      writtenRef.current?.focus();
    }
  }, [written]);
  // Head's Add a channel: there are channels to add to, or they are still being read. With none,
  // the empty state holds the one primary action; with nothing readable, there is no page to act on.
  const headAction =
    (data === undefined && !alerts.isError) || (data !== undefined && data.channels.length > 0);
  return (
    <>
      <PageHead
        title="Alerts"
        lede="Who is told when something breaks, and what has happened so far."
      >
        {headAction ? (
          <Button variant="primary" onClick={add}>
            Add a channel
          </Button>
        ) : undefined}
      </PageHead>
      {alerts.isError ? (
        <div className="mb-6">
          <Unreachable
            what="The channels and the alert history"
            error={alerts.error}
            lastKnownAt={data === undefined ? undefined : alerts.dataUpdatedAt}
            now={now}
            retry={() => {
              void alerts.refetch();
            }}
          />
        </div>
      ) : null}
      {data === undefined && alerts.isError ? null : (
        <>
          <section aria-labelledby="alert-channels">
            <h2 id="alert-channels" className="mb-3.5 text-lg font-bold tracking-tight">
              Channels
            </h2>
            <p
              ref={writtenRef}
              role="status"
              tabIndex={-1}
              className="m-0 mb-3 empty:mb-0 focus-visible:outline-none"
            >
              {written}
            </p>
            {data === undefined ? (
              <p role="status" className="text-text-2">
                Reading the channels.
              </p>
            ) : (
              <>
                {data.fileChannelsDiffer ? <FileDiffers /> : null}
                <Channels
                  channels={data.channels}
                  entries={file.data}
                  workerZone={data.workerZone}
                  now={now}
                  onAdd={add}
                  onEdit={(channel, position) => {
                    open({ kind: "edit", channel, position });
                  }}
                />
              </>
            )}
          </section>
          <section aria-labelledby="alert-events" className="mt-10">
            <h2 id="alert-events" className="mb-3.5 text-lg font-bold tracking-tight">
              Events
            </h2>
            {data === undefined ? (
              <p role="status" className="text-text-2">
                Reading the alert history.
              </p>
            ) : (
              <>
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
              </>
            )}
          </section>
        </>
      )}
      {dialog === null ? null : (
        <ChannelDialog
          key={dialog.opened}
          mode={dialog.mode}
          open={dialog.open}
          onOpenChange={(next) => {
            setDialog((last) => (last === null ? null : { ...last, open: next }));
          }}
          entries={file.data}
          entriesFailed={file.isError && file.data === undefined}
          fileDiffers={data?.fileChannelsDiffer === true}
          workerZone={data?.workerZone ?? null}
          onWritten={setWritten}
        />
      )}
    </>
  );
}
