/* "A human touched the panels" — announced here, acted on elsewhere.
 *
 * WHY ITS OWN MODULE, and why in core/: demo mode needs to stop its auto-tour when the user starts
 * driving, and the only place that knows a real click happened is the accordion code in
 * render/portfolio.js. Having the renderer import demo/data.js to say so would add a
 * render -> demo edge to a module graph CLAUDE.md describes as one cycle rooted at main.js, and it
 * would give the renderer knowledge of a mode it should not care about. An earlier draft of this
 * change did exactly that before catching it.
 *
 * So the dependency is inverted through this file, which imports NOTHING. Nothing can cycle through
 * it, and it stays honest about what it is: an event bus with one event.
 *
 * The renderer announces; whoever cares subscribes. Deliberately not a DOM CustomEvent — a listener
 * would then need a shared target element, and this has to work before any particular node exists.
 */

const listeners = new Set();

// Returns an unsubscribe function, so a caller that outlives one demo session can clean up rather
// than accumulating a listener per session.
export function onUserPanelInteraction(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* Called from real user-gesture handlers ONLY. Programmatic opens (demo mode's own showDemoIndex(),
   which calls setAccordionOpen directly) must never come through here — if they did, the auto-tour
   would cancel itself on its very first tick, which is the one bug this whole mechanism must not have.
   `reason` is free text for logging: "the cycle stopped" is uninformative next to "a person clicked". */
export function notifyUserPanelInteraction(reason) {
  for (const fn of [...listeners]) {
    try {
      fn(reason);
    } catch (err) {
      // A broken subscriber must not break the click the user actually made.
      console.error('[interaction] listener failed', err);
    }
  }
}
