/**
 * A source's id in the FacetDB store: the project and the name, so two projects with a same-named
 * source keep two logs. Every store key of a source (`sources.id`, and `source_id` in the log, the
 * question-set versions and the records) is built here and nowhere else; store migration 4 rekeyed
 * the ids written before as the bare name.
 */
export function sourceIdOf(projectId: string, name: string): string {
  return `${projectId}:${name}`;
}
