/**
 * What a link's answers say about its time per event (#914 round 7).
 *
 * Samples are (events carried, send→answer time). The estimate is the
 * largest (time − fastest time) / (events − the fastest's events) over the
 * samples that carried more than the fastest: waiting behind other traffic
 * only inflates it, so it errs toward smaller requests, never larger. Null
 * until two sizes have been answered — a latency alone says nothing about
 * size, and a relay slow to answer must not shrink requests to one event.
 */
export interface LinkSample {
  n: number;
  ms: number;
}

/** Answers remembered per link for the estimate. */
export const LINK_SAMPLES = 16;

export function perEventMs(samples: ReadonlyArray<LinkSample>): number | null {
  if (samples.length < 2) return null;
  let fastest = samples[0]!;
  for (const s of samples) {
    if (s.ms < fastest.ms || (s.ms === fastest.ms && s.n > fastest.n)) fastest = s;
  }
  let est: number | null = null;
  for (const s of samples) {
    if (s.n <= fastest.n) continue;
    const slope = (s.ms - fastest.ms) / (s.n - fastest.n);
    est = est === null ? slope : Math.max(est, slope);
  }
  return est === null ? null : Math.max(0, est);
}

/** Remember one answer, keeping the last LINK_SAMPLES. */
export function noteSample(samples: LinkSample[], n: number, ms: number): void {
  samples.push({ n, ms });
  if (samples.length > LINK_SAMPLES) samples.shift();
}
