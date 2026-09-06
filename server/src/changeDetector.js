// ---------------------------------------------------------------------------
// This is the module the whole hackathon problem hinges on: given what a
// symbol looked like the last time a user actually looked at it, and what it
// looks like now, decide what's *meaningful* rather than just recomputing a
// live number.
//
// Design choice: explicit, tunable rules over an ML/scoring model.
// A learned "attention score" would be more impressive-sounding but
// impossible to justify in a 72-hour build with no historical data to train
// on, and un-debuggable when it's wrong. Every rule below is one sentence a
// judge can ask "why" about and get a real answer.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  PRICE_MOVE_PCT: 1.5, // price moved at least this % since last-seen baseline
  VOLUME_SPIKE_MULT: 2.0, // volume this session vs rolling average
  STALE_DATA_MS: 10_000, // source data older than this is flagged stale (demo-scaled down;
  //                        would be minutes, not seconds, against a real feed)
};

/**
 * @param {object} current   current snapshot from marketFeed.getSnapshot()
 * @param {object|null} lastSeen  snapshot saved at the end of the user's last session, or null if never seen
 */
export function computeChange(current, lastSeen) {
  const now = Date.now();
  const stale = now - current.sourceTimestamp > THRESHOLDS.STALE_DATA_MS;

  if (!lastSeen) {
    return {
      isNew: true,
      meaningful: false,
      reasons: [],
      priceDeltaPct: 0,
      stale,
      dataAgeMs: now - current.sourceTimestamp,
    };
  }

  const reasons = [];

  const priceDeltaPct = Number(
    (((current.price - lastSeen.price) / lastSeen.price) * 100).toFixed(2)
  );
  if (Math.abs(priceDeltaPct) >= THRESHOLDS.PRICE_MOVE_PCT) {
    reasons.push({
      type: "price_move",
      detail: `${priceDeltaPct > 0 ? "Up" : "Down"} ${Math.abs(priceDeltaPct)}% since you last checked`,
    });
  }

  const volumeDelta = current.volume - lastSeen.volume;
  if (current.avgVolume > 0 && volumeDelta >= current.avgVolume * THRESHOLDS.VOLUME_SPIKE_MULT) {
    reasons.push({
      type: "volume_spike",
      detail: `Trading volume well above average since your last visit`,
    });
  }

  if (current.dayHigh > lastSeen.dayHigh) {
    reasons.push({ type: "new_high", detail: `Hit a new high (₹${current.dayHigh})` });
  }
  if (current.dayLow < lastSeen.dayLow) {
    reasons.push({ type: "new_low", detail: `Hit a new low (₹${current.dayLow})` });
  }

  // Reversal: was moving one way as of last snapshot's own day-change sign,
  // now moved meaningfully the other way.
  if (
    Math.sign(lastSeen.dayChangePct) !== 0 &&
    Math.sign(current.dayChangePct) !== 0 &&
    Math.sign(lastSeen.dayChangePct) !== Math.sign(current.dayChangePct) &&
    Math.abs(priceDeltaPct) >= THRESHOLDS.PRICE_MOVE_PCT
  ) {
    reasons.push({ type: "reversal", detail: `Direction flipped since your last visit` });
  }

  return {
    isNew: false,
    meaningful: reasons.length > 0,
    reasons,
    priceDeltaPct,
    stale,
    dataAgeMs: now - current.sourceTimestamp,
  };
}
