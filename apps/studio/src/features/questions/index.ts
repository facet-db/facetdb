// The Questions feature's door: the page, and the part of the address it keeps (the source shown);
// and the question form, its thresholds and the live preview the setup flow reuses for a source
// that does not exist yet.
export { figuresFor } from "./answers.ts";
export type { QuestionForm, SourceForm } from "./draft.ts";
export { draftOf, formHolds, nameProblem, newQuestion, previewKey } from "./draft.ts";
export { TextField } from "./fields.tsx";
export { PreviewPanel } from "./PreviewPanel.tsx";
export type { PreviewState } from "./preview.ts";
export { PREVIEW_SETTLE_MS, usePreview } from "./preview.ts";
export { QuestionEditor, QuestionThresholds } from "./QuestionEditor.tsx";
export { QuestionsPage } from "./QuestionsPage.tsx";
export { CONFIG_KEY, projectConfigQuery } from "./queries.ts";
export type { QuestionsSearch } from "./search.ts";
export { questionsSearch } from "./search.ts";
export { countWords, dollarWords, issueWords, plural } from "./words.ts";
