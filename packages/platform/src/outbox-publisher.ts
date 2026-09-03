/**
 * Where outbox events go once they have been claimed.
 *
 * Behind an interface because the transport is the part most likely to change,
 * and the part least worth coupling to: the guarantee that matters — the event
 * and the change it describes commit together — is made by the outbox table,
 * not by whatever carries the message afterwards. Swapping BullMQ for Kafka is
 * one more implementation and one line in a composition root. See ADR-0005.
 */
export interface PublishableEvent {
  id: number;
  aggregate: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxPublisher {
  publish(events: readonly PublishableEvent[]): Promise<void>;
  /** Releases whatever the transport holds. Called on shutdown. */
  close(): Promise<void>;
}
