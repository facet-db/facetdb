import { Button, buttonClasses, EmptyState } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { useApi, useSchedule } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Problem, StaleNote } from "../decisions/index.ts";
import { ApplyDialog } from "./ApplyDialog.tsx";
import { type Draft, draftOf, formOf, reconcile, rewordedQuestions } from "./draft.ts";
import { SourceTabs } from "./fields.tsx";
import { projectConfigQuery } from "./queries.ts";
import { SourceEditor } from "./SourceEditor.tsx";
import { TestDialog } from "./TestDialog.tsx";

/**
 * The Questions page: a tab per source, its form beside the live preview, the wording warnings and
 * the versions, and Test and Apply at the head, Apply the page's one `facet` action. The drafts are
 * the page's: one per source, kept while the tabs change, reconciled with every read of the config
 * and never replaced by one (draft.ts).
 */

const LEDE =
  "Write the question in plain words. The preview answers the 20 most recent rows when you ask, then again as you type.";

export function QuestionsPage({
  source,
  onSource,
}: {
  /** The source in the address; the first one when it names none or one the config lacks. */
  readonly source: string | undefined;
  readonly onSource: (name: string) => void;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const id = useId();
  const config = useQuery(projectConfigQuery(api));
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
  const [testOpen, setTestOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyOpened, setApplyOpened] = useState(0);

  const data = config.data;
  useEffect(() => {
    if (data !== undefined) {
      setDrafts((before) => reconcile(before, data.sources));
    }
  }, [data]);

  const names = data?.sources.map((candidate) => candidate.name) ?? [];
  const chosen = source !== undefined && names.includes(source) ? source : names[0];
  const draft = chosen === undefined ? undefined : drafts.get(chosen);
  const tabId = (name: string) => `${id}-tab-${name}`;
  const panelId = (name: string) => `${id}-panel-${name}`;
  const openApply = () => {
    setApplyOpened((count) => count + 1);
    setApplyOpen(true);
  };

  // Nothing is tested or written while a question's name cannot be sent (draft.ts, `nameProblem`).
  const sendable = draft === undefined ? undefined : draftOf(draft.form);
  const blockedId = `${id}-blocked`;

  const head =
    chosen === undefined || draft === undefined ? (
      <PageHead title="Questions" lede={LEDE} />
    ) : sendable === undefined ? (
      <PageHead title="Questions" lede={LEDE}>
        <Button disabled aria-describedby={blockedId}>
          Test
        </Button>
        <Button variant="primary" disabled aria-describedby={blockedId}>
          Apply
        </Button>
      </PageHead>
    ) : (
      <PageHead title="Questions" lede={LEDE}>
        <TestDialog
          source={chosen}
          draft={sendable}
          inForce={data?.versions[chosen]?.inForce ?? null}
          open={testOpen}
          onOpenChange={setTestOpen}
          onApply={() => {
            setTestOpen(false);
            openApply();
          }}
        />
        <ApplyDialog
          source={chosen}
          draft={sendable}
          changedQuestions={rewordedQuestions(draft)}
          open={applyOpen}
          opened={applyOpened}
          onOpenChange={(open) => {
            if (open) {
              openApply();
            } else {
              setApplyOpen(false);
            }
          }}
        />
      </PageHead>
    );

  if (data === undefined) {
    return (
      <>
        {head}
        {config.isError ? (
          <Problem error={config.error} />
        ) : (
          <p role="status" className="text-text-3">
            Reading the configuration
          </p>
        )}
      </>
    );
  }
  if (data.sources.length === 0) {
    return (
      <>
        {head}
        <EmptyState
          title="No source yet"
          action={
            <Link
              to="/sources/new"
              className={buttonClasses()}
              data-variant="primary"
              data-size="medium"
            >
              Add a source
            </Link>
          }
        >
          Questions belong to a source: add one, and its questions are written here.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {head}
      {draft !== undefined && sendable === undefined ? (
        <p id={blockedId} className="mb-5 border-l-2 border-review pl-3">
          Test and Apply wait until every question has a name of its own and its cut lines in order:
          see the question marked in the form.
        </p>
      ) : null}
      {config.isError ? (
        // The worker's last good answer stays, said as such: the drafts are untouched.
        <div className="mb-5 grid gap-1">
          <p className="m-0">The worker could not be reached for the configuration just now.</p>
          <Problem error={config.error} />
          <StaleNote
            what="The configuration shown was"
            readAt={config.dataUpdatedAt}
            now={new Date(schedule.now())}
          />
        </div>
      ) : null}
      <div className="mb-6">
        <SourceTabs
          names={names}
          chosen={chosen ?? ""}
          onChoose={onSource}
          tabId={tabId}
          panelId={panelId}
        />
      </div>
      {data.sources.map((candidate) => {
        const held = drafts.get(candidate.name);
        return (
          <div
            key={candidate.name}
            id={panelId(candidate.name)}
            role="tabpanel"
            aria-labelledby={tabId(candidate.name)}
            hidden={candidate.name !== chosen}
          >
            {held === undefined ? null : (
              <SourceEditor
                source={candidate}
                draft={held}
                versions={data.versions[candidate.name]}
                onForm={(form) => {
                  setDrafts((before) => {
                    const current = before.get(candidate.name);
                    return current === undefined
                      ? before
                      : new Map(before).set(candidate.name, { ...current, form });
                  });
                }}
                onDiscard={() => {
                  const fresh = formOf(candidate);
                  setDrafts((before) =>
                    new Map(before).set(candidate.name, { base: fresh, form: fresh }),
                  );
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
