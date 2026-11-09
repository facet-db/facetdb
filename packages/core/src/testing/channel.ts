import type { AlertChannel, ChannelMessage } from "../contracts/index.ts";

export type Delivery<C> = {
  readonly message: ChannelMessage;
  readonly config: C;
};

/**
 * A channel that keeps every message it was asked to deliver. `failNextWith` makes the next delivery
 * reject, so a test can prove a failed delivery is reported.
 */
export class FakeChannel<C> implements AlertChannel<C> {
  readonly delivered: Delivery<C>[] = [];
  #failure: Error | null = null;

  failNextWith(error: Error): void {
    this.#failure = error;
  }

  deliver(message: ChannelMessage, config: C): Promise<void> {
    this.delivered.push({ message, config });
    const failure = this.#failure;
    if (failure !== null) {
      this.#failure = null;
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }
}
