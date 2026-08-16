const DEFAULT_WINDOW_MS = 350;

export function guardPhysicalTap(event, lastAcceptedAt, options = {}) {
  if (!event || typeof event !== 'object') {
    return { accepted: true, acceptedAt: lastAcceptedAt, elapsed: null, source: 'PROGRAMMATIC' };
  }

  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const hostTimestamp = Number(event.timeStamp);
  const hasUsableHostTimestamp = Number.isFinite(hostTimestamp) && hostTimestamp > 0;
  const acceptedAt = hasUsableHostTimestamp ? hostTimestamp : Number(now());
  if (!Number.isFinite(acceptedAt)) {
    return { accepted: true, acceptedAt: lastAcceptedAt, elapsed: null, source: 'UNAVAILABLE' };
  }

  const windowMs = Number.isFinite(options.windowMs) && options.windowMs >= 0
    ? options.windowMs
    : DEFAULT_WINDOW_MS;
  const elapsed = Number.isFinite(lastAcceptedAt) ? acceptedAt - lastAcceptedAt : null;
  if (elapsed !== null && elapsed >= 0 && elapsed < windowMs) {
    return {
      accepted: false,
      acceptedAt: lastAcceptedAt,
      elapsed,
      source: hasUsableHostTimestamp ? 'HOST' : 'MONOTONIC_FALLBACK'
    };
  }

  return {
    accepted: true,
    acceptedAt,
    elapsed,
    source: hasUsableHostTimestamp ? 'HOST' : 'MONOTONIC_FALLBACK'
  };
}
