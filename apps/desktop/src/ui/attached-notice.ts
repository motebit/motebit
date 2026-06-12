/**
 * Shared copy for the attached-frontend honest state. When this window
 * is a rendering frontend attached to the machine's coordinator
 * (daemon-desktop unification), the interior — memory, receipts, trust
 * — lives in that process. Panels whose data source is the runtime must
 * say so: the structural-void empty state (a READY pulse, see
 * docs/doctrine/panel-temporal-registers.md §"The structural-void
 * test") is for a fresh interior, and an attached frontend's interior
 * is not void — it is elsewhere. Rendering "memories appear here as
 * conversations build" over a thousand-memory interior is the dishonest
 * blank this module exists to prevent. Copy only — each panel places it
 * in its native empty markup.
 */
export function attachedNotice(
  coordinatorPid: number,
  records: string,
): { title: string; sub: string } {
  return {
    title: "Attached to this machine's coordinator",
    sub: `${records} live in the coordinator process (pid ${coordinatorPid}) — chat and approvals act there`,
  };
}

/** Single-line form for panels whose empty slot is one text node. */
export function attachedNoticeLine(coordinatorPid: number, records: string): string {
  const { title, sub } = attachedNotice(coordinatorPid, records);
  return `${title} — ${sub}`;
}
