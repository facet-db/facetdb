import type { RecordKey } from "../contracts/index.ts";
import {
  type LockResult,
  type QueueCount,
  REVIEW_LOCK_MS,
  type ReviewCard,
  type ReviewEntry,
  type ReviewFilter,
  type ReviewLock,
  type ReviewQueue,
} from "../review/index.ts";

type Row = {
  entry: ReviewEntry;
  lock: ReviewLock | null;
  skippedBy: string[];
};

/**
 * An in-memory review queue with the store's rules (`facetdb.reviews`): one card per source and
 * key, a refresh at the same hash keeps the card's `since`, lease and skips, a new hash makes a new
 * card, leases compared with the caller's `nowMs` only. `rows` shows what the table would hold.
 */
export class FakeReviewQueue implements ReviewQueue {
  readonly #rows = new Map<string, Row>();

  /** Every card, oldest first, with its lease and the viewers who skipped it. */
  get rows(): readonly (ReviewEntry & { lock: ReviewLock | null; skippedBy: readonly string[] })[] {
    return [...this.#rows.values()]
      .sort((a, b) => compareCards(a.entry, b.entry))
      .map((row) => ({ ...row.entry, lock: row.lock, skippedBy: [...row.skippedBy] }));
  }

  upsert(entry: ReviewEntry): Promise<void> {
    const id = idOf(entry.source, entry.key);
    const found = this.#rows.get(id);
    if (found !== undefined && found.entry.stateHash === entry.stateHash) {
      found.entry = { ...entry, since: found.entry.since };
    } else {
      this.#rows.set(id, { entry, lock: null, skippedBy: [] });
    }
    return Promise.resolve();
  }

  remove(source: string, key: RecordKey): Promise<void> {
    this.#rows.delete(idOf(source, key));
    return Promise.resolve();
  }

  withdraw(source: string, key: RecordKey, stateHash: string): Promise<void> {
    if (this.#rows.get(idOf(source, key))?.entry.stateHash === stateHash) {
      this.#rows.delete(idOf(source, key));
    }
    return Promise.resolve();
  }

  list(filter: ReviewFilter, viewer: string, nowMs: number): Promise<readonly ReviewCard[]> {
    const cards = [...this.#rows.values()]
      .filter((row) => cardMatches({ ...row.entry, lock: row.lock }, filter, viewer, nowMs))
      .map(
        (row): ReviewCard => ({
          ...row.entry,
          lock: row.lock,
          skipped: row.skippedBy.includes(viewer),
        }),
      )
      .sort((a, b) => firstOrder(Number(a.skipped) - Number(b.skipped), compareCards(a, b)));
    return Promise.resolve(filter.limit === undefined ? cards : cards.slice(0, filter.limit));
  }

  async count(
    filter: Omit<ReviewFilter, "limit">,
    viewer: string,
    nowMs: number,
  ): Promise<QueueCount> {
    const cards = await this.list(filter, viewer, nowMs);
    const oldest = cards.reduce<Date | undefined>(
      (found, card) => (found === undefined || card.since < found ? card.since : found),
      undefined,
    );
    return { count: cards.length, oldestSince: oldest };
  }

  lock(source: string, key: RecordKey, viewer: string, nowMs: number): Promise<LockResult> {
    const row = this.#rows.get(idOf(source, key));
    if (row === undefined) {
      return Promise.resolve({ kind: "gone" });
    }
    if (row.lock !== null && row.lock.by !== viewer && row.lock.until.getTime() > nowMs) {
      return Promise.resolve({ kind: "held", by: row.lock.by, until: row.lock.until });
    }
    row.lock = { by: viewer, until: new Date(nowMs + REVIEW_LOCK_MS) };
    return Promise.resolve({ kind: "locked", until: row.lock.until });
  }

  renew(source: string, key: RecordKey, viewer: string, nowMs: number): Promise<LockResult> {
    const row = this.#rows.get(idOf(source, key));
    if (row === undefined) {
      return Promise.resolve({ kind: "gone" });
    }
    if (row.lock?.by === viewer) {
      row.lock = { by: viewer, until: new Date(nowMs + REVIEW_LOCK_MS) };
      return Promise.resolve({ kind: "locked", until: row.lock.until });
    }
    if (row.lock !== null && row.lock.until.getTime() > nowMs) {
      return Promise.resolve({ kind: "held", by: row.lock.by, until: row.lock.until });
    }
    return Promise.resolve({ kind: "lost" });
  }

  release(source: string, key: RecordKey, viewer: string): Promise<void> {
    const row = this.#rows.get(idOf(source, key));
    if (row?.lock?.by === viewer) {
      row.lock = null;
    }
    return Promise.resolve();
  }

  skip(source: string, key: RecordKey, viewer: string): Promise<void> {
    const row = this.#rows.get(idOf(source, key));
    if (row === undefined) {
      return Promise.resolve();
    }
    if (!row.skippedBy.includes(viewer)) {
      row.skippedBy.push(viewer);
    }
    if (row.lock?.by === viewer) {
      row.lock = null;
    }
    return Promise.resolve();
  }
}

/**
 * Whether a viewer's `list` shows a card, as the store's `list` statement says it: another
 * reviewer's live lease hides it (a lease ends at `until`), and the filter must match.
 */
function cardMatches(
  card: ReviewEntry & { readonly lock: ReviewLock | null },
  filter: ReviewFilter,
  viewer: string,
  nowMs: number,
): boolean {
  if (card.lock !== null && card.lock.by !== viewer && card.lock.until.getTime() > nowMs) {
    return false;
  }
  if (filter.source !== undefined && card.source !== filter.source) {
    return false;
  }
  if (filter.key !== undefined && card.key !== filter.key) {
    return false;
  }
  const { question, below } = filter;
  if (question !== undefined && !card.openQuestions.includes(question)) {
    return false;
  }
  if (below === undefined) {
    return true;
  }
  return Object.entries(card.numbers).some(
    ([name, figure]) => (question === undefined || name === question) && figure < below,
  );
}

function idOf(source: string, key: RecordKey): string {
  return JSON.stringify([source, key]);
}

/** Oldest first, then by source and key, as the store orders them. */
function compareCards(a: ReviewEntry, b: ReviewEntry): number {
  return firstOrder(
    a.since.getTime() - b.since.getTime(),
    compareText(a.source, b.source),
    compareText(a.key, b.key),
  );
}

/** The first comparison that tells two cards apart. */
function firstOrder(...orders: readonly number[]): number {
  return orders.find((order) => order !== 0) ?? 0;
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
