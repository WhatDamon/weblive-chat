/* Zero-dependency, no-build: shared by the page and by bun test (via globalThis).
   Exponential backoff with downward jitter so a server outage cannot turn every
   open tab into a synchronized reconnect storm. */
(function (g) {
  g.backoffDelay = function (attempt, rand) {
    var base = Math.min(30000, 1000 * Math.pow(2, attempt));
    return Math.round(base * (0.5 + rand() * 0.5));
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
