// The notification dispatch seam (dev-work-plan P9-A step 8). P9-B builds the
// channels (for example Discord, a webhook or e-mail) on it: a channel is a
// NotificationSubscriber that names the activity types of contract C6 it
// wants and receives each new row of those types. The dispatcher listens to
// ActivityService, so every module that records an event through record()
// reaches the channels without knowing them.
//
// Notifications are Paid (feature notifications, contract C1): on Free no
// event is handed to any subscriber, and none is queued for later. Delivery
// never blocks or fails the action that wrote the event: it starts after
// record() returns, and a subscriber that throws or rejects is logged and
// left alone. Retries, rate limits and the channel settings belong to P9-B.
import type { EntitlementGate } from "@dialwarden/entitlement";
import type { FastifyBaseLogger } from "fastify";
import type {
  ActivityEvent,
  ActivityService,
  ActivityType,
} from "../activity/service.js";

/** One notification channel, as P9-B registers it. */
export interface NotificationSubscriber {
  /** A short stable name for the logs, for example "discord". */
  readonly name: string;
  /** The C6 activity types this channel receives. */
  readonly types: readonly ActivityType[];
  /**
   * Delivers one C6 row: { id, type, serverId, at, actor, data }. A
   * rejection is logged with the channel name, the event id and the
   * error's name only.
   */
  deliver(event: ActivityEvent): Promise<void>;
}

export interface NotificationDispatcherOptions {
  readonly activity: ActivityService;
  readonly entitlement: EntitlementGate;
  readonly log: FastifyBaseLogger;
}

export class NotificationDispatcher {
  readonly #entitlement: EntitlementGate;
  readonly #log: FastifyBaseLogger;
  readonly #subscribers = new Set<NotificationSubscriber>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(options: NotificationDispatcherOptions) {
    this.#entitlement = options.entitlement;
    this.#log = options.log;
    this.#unsubscribe = options.activity.subscribe((event) => {
      this.#dispatch(event);
    });
  }

  /** Adds a channel; returns the function that removes it again. */
  register(subscriber: NotificationSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** The channels registered now. */
  get subscribers(): readonly NotificationSubscriber[] {
    return [...this.#subscribers];
  }

  #dispatch(event: ActivityEvent): void {
    if (!this.#entitlement.can("notifications")) return;
    for (const subscriber of this.#subscribers) {
      if (!subscriber.types.includes(event.type)) continue;
      const delivery = this.#deliver(subscriber, event);
      this.#inFlight.add(delivery);
      void delivery.finally(() => this.#inFlight.delete(delivery));
    }
  }

  async #deliver(
    subscriber: NotificationSubscriber,
    event: ActivityEvent,
  ): Promise<void> {
    // After the action that recorded the event: a slow channel never holds
    // the request, the apply or the scheduler that wrote it.
    await Promise.resolve();
    try {
      await subscriber.deliver(event);
    } catch (error) {
      // Only the error's name: a channel's message can carry its webhook
      // address, which holds a secret.
      const reason = error instanceof Error ? error.name : "unknown";
      this.#log.warn(
        {
          channel: subscriber.name,
          eventId: event.id,
          type: event.type,
          reason,
        },
        "notification delivery failed",
      );
    }
  }

  /** Resolves once every delivery started so far has settled. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /** Stops listening to the activity (app close). */
  stop(): void {
    this.#unsubscribe();
  }
}
