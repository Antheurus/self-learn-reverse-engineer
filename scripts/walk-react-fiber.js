// walk-react-fiber.js — read internal React component state that Redux/Context
// doesn't expose, or FORCE a React-controlled prop (e.g. a `disabled` button
// that plain `el.disabled = false` won't unlock, because React re-renders it
// back to disabled on the next tick — the disabled state is controlled by
// component state, not a DOM attribute you can mutate directly).
//
// This is the React analog of the Vue v-model gotcha (primitives.md §10):
// direct DOM mutation is cosmetic-only when the framework owns the node.
//
// EXECUTION CONTEXT: this defines multiple functions meant to be called
// interactively against different elements during one debugging session — that
// doesn't fit run-code's single-arrow-expression sandbox (primitives.md §17).
// Paste the whole file into DevTools Console once (same as
// comprehensive-search-harvest.js), then call from the console:
//
//   readFiberState(document.querySelector('SEL'))
//   forceFiberProp(document.querySelector('SEL'), 'disabled', false)
//
// To run non-interactively via `playwright-cli run-code --filename=`, wrap ONE
// call in a single arrow expression instead, e.g.:
//   async (page) => {
//     const result = await page.evaluate((sel) => {
//       <paste getFiberKey + readFiberState + summarizeState bodies here>
//       return readFiberState(document.querySelector(sel));
//     }, 'SEL');
//     return result;
//   }

function getFiberKey(el) {
  return Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
}

function readFiberState(el, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const key = getFiberKey(el);
  if (!key) return { error: 'No React fiber key on this element — is React even mounted here, or is this the wrong node?' };
  let fiber = el[key];
  const trail = [];
  for (let i = 0; i < maxDepth && fiber; i++) {
    trail.push({
      depth: i,
      type: typeof fiber.type === 'string' ? fiber.type : (fiber.type && fiber.type.name) || '<anonymous>',
      memoizedProps: fiber.memoizedProps
        ? Object.fromEntries(Object.entries(fiber.memoizedProps).filter(([k]) => k !== 'children'))
        : null,
      memoizedState: fiber.memoizedState ? summarizeState(fiber.memoizedState) : null,
    });
    fiber = fiber.return; // walk up toward the owning component
  }
  return { trail };
}

// memoizedState on a hooks-based component is a linked list, not a plain object.
function summarizeState(state, depth = 0) {
  if (!state || depth > 5) return null;
  const out = [];
  let node = state;
  let i = 0;
  while (node && i < 10) {
    out.push(node.memoizedState !== undefined ? node.memoizedState : node);
    node = node.next;
    i++;
  }
  return out;
}

// Force a controlled prop. Walking to the fiber and calling its owner's real
// setState/dispatch path is non-trivial generically — the reliable shortcut is
// dispatching the SAME event the real unlock condition listens for (e.g. the
// form's onChange), not fighting React directly. Where that's not available,
// this monkeypatches the prop on the current render only (survives until the
// next re-render triggered by state change elsewhere) — good enough to get one
// click through during discovery, NOT a stable production technique.
function forceFiberProp(el, propName, value) {
  const key = getFiberKey(el);
  if (!key) return { error: 'No React fiber key on this element.' };
  const fiber = el[key];
  if (!fiber || !fiber.memoizedProps) return { error: 'Fiber has no memoizedProps.' };
  fiber.memoizedProps[propName] = value;
  // Also patch the pending props fiber (alternate) if present — React may
  // read from either depending on render phase.
  if (fiber.alternate && fiber.alternate.memoizedProps) {
    fiber.alternate.memoizedProps[propName] = value;
  }
  return { forced: propName, value, note: 'This survives until the next re-render caused by real state change elsewhere. Prefer finding the real unlock condition (fill the actual required field) over relying on this for production automation — it is a discovery/verification tool, not a stable production technique.' };
}
