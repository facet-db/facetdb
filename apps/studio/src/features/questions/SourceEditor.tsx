import { Button } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ConfigSource, SourceDraft, SourceVersions } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { figuresFor } from "./answers.ts";
import {
  changedUnder,
  type Draft,
  draftKey,
  draftOf,
  edited,
  formHolds,
  nameProblem,
  newQuestion,
  previewKey,
  type SourceForm,
} from "./draft.ts";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { PREVIEW_SETTLE_MS, usePreview } from "./preview.ts";
import { QuestionEditor } from "./QuestionEditor.tsx";
import { validationQuery } from "./queries.ts";
import { Versions } from "./Versions.tsx";
import { Wording } from "./Wording.tsx";

/**
 * One source's split view: the form on the left, a question after another; the live preview, the
 * wording and the versions on the right. The draft is judged by the loader once the typing has
 * stood still for 1.5 s (free: no model), and the preview follows its own rule (preview.ts).
 */

/**
 * The draft once the typing has settled: the newest edit, 1.5 s after it, and not before. Undefined
 * while a question's name cannot be sent: nothing is judged then, the name's problem is the page's.
 */
function useSettled(
  key: string,
  draft: SourceDraft | undefined,
): { key: string; draft: SourceDraft | undefined } {
  const schedule = useSchedule();
  const [settled, setSettled] = useState({ key, draft });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the draft; a draft with the same key is the same draft
  useEffect(
    () =>
      schedule.after(PREVIEW_SETTLE_MS, () => {
        setSettled((before) => (before.key === key ? before : { key, draft }));
      }),
    [key, schedule],
  );
  return settled;
}

export function SourceEditor({
  source,
  draft,
  versions,
  onForm,
  onDiscard,
}: {
  /** The source as the config holds it now. */
  readonly source: ConfigSource;
  readonly draft: Draft;
  readonly versions: SourceVersions | undefined;
  readonly onForm: (form: SourceForm) => void;
  /** Back to the config as it is now, dropping the edits. */
  readonly onDiscard: () => void;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const now = new Date(schedule.now());
  const { form } = draft;
  // The person's edits in this panel of what the model reads: only they, or a click, ask the
  // preview again (preview.ts). A cut line moved or the stakes chosen is not one, even when the
  // config changed the wording under a draft nobody edited.
  const [edits, setEdits] = useState(0);
  const edit = (next: SourceForm) => {
    if (previewKey(next) !== previewKey(form)) {
      setEdits((count) => count + 1);
    }
    onForm(next);
  };
  const preview = usePreview(form, edits);
  const blocked = !formHolds(form);
  // The loader judges the thresholds too (each from 0 to 1, noBelow under yesAbove, the keys a kind
  // takes), and a cut set by hand can cross a stakes default the person just chose: a moved cut is
  // judged as well. The judgement is the loader's, free; the model is never asked by it.
  const settled = useSettled(draftKey(form), draftOf(form));
  const validation = useQuery(validationQuery(api, settled.key, settled.draft));
  const judged = blocked ? undefined : validation.data;
  const issues = judged?.issues ?? [];
  const checking =
    !blocked &&
    (settled.key !== draftKey(form) || validation.isPlaceholderData || validation.isFetching);

  return (
    <div className="grid gap-6">
      {changedUnder(draft, source) ? (
        <div className="grid gap-2 border-l-2 border-review pl-3" role="status">
          <p className="m-0">
            {`The configuration of ${source.name} changed since this draft started (an Apply, or the worker reloaded facetdb.config.ts). Your edits are kept as you typed them; Apply shows the file's diff as it is now.`}
          </p>
          <div>
            <Button variant="quiet" size="small" onClick={onDiscard}>
              Load the new configuration and drop my edits
            </Button>
          </div>
        </div>
      ) : null}
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6">
          {form.questions.map((question, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a new question's name is what is being typed; its place is stable
              key={index}
              className={index === 0 ? "" : "border-t border-hairline pt-5.5"}
            >
              <QuestionEditor
                question={question}
                issues={issues}
                nameProblem={nameProblem(form, index)}
                fileOverride={
                  question.existing
                    ? (draft.base.questions.find((was) => was.name === question.name)?.thresholds ??
                      {})
                    : {}
                }
                previewed={preview.shown !== null}
                figures={
                  preview.shown === null
                    ? []
                    : figuresFor(question, preview.shown.form, preview.shown.result.rows)
                }
                onChange={(next) => {
                  edit({
                    ...form,
                    questions: form.questions.map((existing, at) =>
                      at === index ? next : existing,
                    ),
                  });
                }}
                onRemove={
                  question.existing
                    ? undefined
                    : () => {
                        edit({
                          ...form,
                          questions: form.questions.filter((_, at) => at !== index),
                        });
                      }
                }
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2 border-t border-hairline pt-5.5">
            <Button
              onClick={() => {
                edit({ ...form, questions: [...form.questions, newQuestion(form)] });
              }}
            >
              Add a question
            </Button>
            {edited(draft) ? (
              <Button variant="quiet" onClick={onDiscard}>
                Discard my edits
              </Button>
            ) : null}
          </div>
          <p className="m-0 text-[12.5px] text-text-3">
            A new question adds its columns at the next facetdb migrate; its answers for existing
            records come from a backfill of that question alone, its cost shown first.
          </p>
        </div>
        <div className="grid min-w-0 gap-8">
          <PreviewPanel
            source={source.name}
            read={source.read}
            form={form}
            preview={preview}
            blocked={blocked}
          />
          <Wording
            blocked={blocked}
            judged={judged}
            checking={checking}
            failure={validation.isError ? validation.error : null}
            readAt={validation.dataUpdatedAt}
            now={now}
          />
          <Versions source={source.name} history={versions} now={now} />
        </div>
      </div>
    </div>
  );
}
