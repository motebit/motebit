/**
 * A wire-faithful in-memory relay for sync-engine tests (#868): the push
 * route, and the pull route in both shapes — the seq shape when `after_seq`
 * is sent to a relay that serves it, the unchanged clock shape otherwise.
 * `servesSeq = false` is a pre-#868 relay: it ignores `after_seq`.
 *
 * The real relay is exercised end to end in
 * services/relay/src/__tests__/sync-seq-interleaving-868.test.ts.
 */
import type { EventLogEntry } from "@motebit/sdk";

export class FakeRelay {
  private rows: Array<{ seq: number; event: EventLogEntry }> = [];
  private nextSeq = 1;
  servesSeq = true;
  /** Every pull URL, for asserting which cursor a client sent. */
  pulls: URL[] = [];
  pageMax = 1000;
  /** Every event a push carried, duplicates included (#914: what a client re-sent). */
  pushedIds: string[] = [];

  constructor(readonly baseUrl = "http://relay.fake") {}

  /** Store an event exactly as the relay's push door does (dedup by event_id). */
  ingest(event: EventLogEntry): void {
    if (this.rows.some((r) => r.event.event_id === event.event_id)) return;
    this.rows.push({ seq: this.nextSeq++, event: { ...event } });
  }

  /** The event_ids the relay holds for `mid`, one row each, in ingest order. */
  heldIds(mid: string): string[] {
    return this.rows.filter((r) => r.event.motebit_id === mid).map((r) => r.event.event_id);
  }

  /** Simulate a relay database restored from an older backup. */
  rewindTo(keep: number): void {
    this.rows = this.rows.slice(0, keep);
    this.nextSeq = (this.rows[this.rows.length - 1]?.seq ?? 0) + 1;
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const [, , mid, op] = url.pathname.split("/");
    if (op === "push" && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { events: EventLogEntry[] };
      for (const e of body.events) {
        this.pushedIds.push(e.event_id);
        this.ingest(e);
      }
      return Response.json({ motebit_id: mid, accepted: body.events.length });
    }
    if (op === "pull") {
      this.pulls.push(url);
      const own = this.rows.filter((r) => r.event.motebit_id === mid);
      const afterSeqRaw = url.searchParams.get("after_seq");
      if (this.servesSeq && afterSeqRaw !== null) {
        const afterSeq = Number(afterSeqRaw);
        const limit = Number(url.searchParams.get("limit") ?? this.pageMax);
        const after = own.filter((r) => r.seq > afterSeq);
        const page = after.slice(0, Math.min(limit, this.pageMax));
        return Response.json({
          motebit_id: mid,
          events: page.map((r) => ({ ...r.event, seq: r.seq })),
          after_seq: afterSeq,
          next_seq: page.length > 0 ? page[page.length - 1]!.seq : afterSeq,
          has_more: after.length > page.length,
          latest_seq: own.length > 0 ? own[own.length - 1]!.seq : 0,
        });
      }
      const afterClock = Number(url.searchParams.get("after_clock") ?? "0");
      return Response.json({
        motebit_id: mid,
        events: own
          .map((r) => r.event)
          .filter((e) => e.version_clock > afterClock)
          .sort((a, b) => a.version_clock - b.version_clock),
        after_clock: afterClock,
      });
    }
    if (op === "clock") {
      const own = this.rows.filter((r) => r.event.motebit_id === mid);
      return Response.json({
        motebit_id: mid,
        latest_clock: Math.max(0, ...own.map((r) => r.event.version_clock)),
      });
    }
    return new Response("not found", { status: 404 });
  };
}
