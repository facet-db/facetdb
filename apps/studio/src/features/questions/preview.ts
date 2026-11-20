import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DraftPreview, SourceDraft } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { draftOf, previewKey, type SourceForm } from "./draft.ts";

/**
 * When the live preview asks the model. It spends the customer's tokens, so: never on its own at
 * first, only on the person's first "Preview"; after that, once the questions have stood still for
 * `PREVIEW_SETTLE_MS` after an edit the person made in this panel; never for a cut line moved or
 * the stakes chosen (the key holds only what the model reads, and the page re-applies the
 * thresholds to the answers it holds); never for a config that changed under a draft nobody edited
 * (the rows then say they were answered for an earlier configuration, and wait for the person);
 * never from a mount or a remount (the first run is a click, and a remount starts unarmed); never
 * while a name or a pair of cut lines cannot be sent. Every run's cost is counted.
 *
 * A stale answer is never painted: each run is numbered, and an answer is shown only when it is the
 * newest run's and the questions it was asked with are still the draft's. An older run's answer, or
 * one that arrives after the draft moved on, is counted and dropped; the settled draft's own run
 * follows.
 */

/** Typing has stopped: 1.5 s without an edit. */
export const PREVIEW_SETTLE_MS = 1_500;

/** A preview on screen: what it answered, and the draft it was asked with. */
export type ShownPreview = {
  /** The run's number: a new run is a new table, which fills in again. */
  readonly run: number;
  readonly key: string;
  /** The draft as it was sent: the table's columns are its questions. */
  readonly form: SourceForm;
  readonly result: DraftPreview;
  /** When it arrived, in epoch milliseconds. */
  readonly at: number;
};

export type PreviewState = {
  /** The person asked for the first preview: from now on the preview follows their edits. */
  readonly armed: boolean;
  readonly running: boolean;
  readonly shown: ShownPreview | null;
  /** Why the newest run failed; the rows of an earlier run stay on screen beside it. */
  readonly error: Error | null;
  /** The person edited the questions since the last run was sent: one follows when typing stops. */
  readonly editPending: boolean;
  /** Every run that came back on this page, painted or dropped, and what they cost together. */
  readonly runs: number;
  readonly spent: number;
  /** The first preview, or another one now, by the person's click. */
  readonly run: () => void;
};

/**
 * `edits` counts the person's edits in this panel (SourceEditor): a form that changed without one
 * (the config read again) arms nothing. `previewOf` asks for one run: the Questions page's is `POST
 * /v1/preview` over a running source; the setup flow's reads a new source's rows with the admin
 * connection string the page holds.
 */
export function usePreview(
  form: SourceForm,
  edits: number,
  previewOf?: (draft: SourceDraft) => Promise<DraftPreview>,
): PreviewState {
  const api = useApi();
  const schedule = useSchedule();
  const key = previewKey(form);
  const ask = useMutation({ mutationFn: previewOf ?? api.previewDraft });

  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState<ShownPreview | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [spending, setSpending] = useState({ runs: 0, spent: 0 });
  /** The person's edit count and the questions at the last run sent, for what the page says. */
  const [lastSent, setLastSent] = useState({ edit: 0, key: "" });

  // The draft now, for an answer to be judged against and for the settled run to send.
  const latest = useRef({ key, form, edits });
  useEffect(() => {
    latest.current = { key, form, edits };
  });
  /** The newest run's number, and the questions it was sent with. */
  const newest = useRef({ run: 0, key: "" });

  const send = (sent: SourceForm, atEdit: number) => {
    const draft = draftOf(sent);
    if (draft === undefined) {
      return;
    }
    const run = newest.current.run + 1;
    const sentKey = previewKey(sent);
    newest.current = { run, key: sentKey };
    setLastSent({ edit: atEdit, key: sentKey });
    setRunning(true);
    setError(null);
    void ask.mutateAsync(draft).then(
      (result) => {
        setSpending((before) => ({
          runs: before.runs + 1,
          spent: before.spent + result.cost.dollars,
        }));
        if (run !== newest.current.run) {
          return;
        }
        setRunning(false);
        if (sentKey === latest.current.key) {
          setShown({ run, key: sentKey, form: sent, result, at: schedule.now() });
        }
      },
      (failure: unknown) => {
        if (run !== newest.current.run) {
          return;
        }
        setRunning(false);
        setError(failure instanceof Error ? failure : new Error(String(failure)));
      },
    );
  };
  const sendLatest = useRef(send);
  useEffect(() => {
    sendLatest.current = send;
  });

  // Once armed, an edit of the person's sends the draft when the typing has settled; the timer is
  // set again on every edit. Questions already sent as they are now (an edit undone, a stakes
  // chosen, a cut line moved) send nothing.
  useEffect(() => {
    if (!armed || edits === 0) {
      return;
    }
    return schedule.after(PREVIEW_SETTLE_MS, () => {
      const now = latest.current;
      if (now.key !== newest.current.key) {
        sendLatest.current(now.form, now.edits);
      }
    });
  }, [armed, edits, schedule]);

  return {
    armed,
    running,
    shown,
    error,
    editPending: armed && edits !== lastSent.edit && key !== lastSent.key,
    runs: spending.runs,
    spent: spending.spent,
    run: () => {
      setArmed(true);
      send(form, edits);
    },
  };
}
