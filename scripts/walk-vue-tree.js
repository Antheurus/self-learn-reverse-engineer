// ENV: browser-console — DevTools Console — paste the whole file into the console on a logged-in page. Defines multiple functions, so it does NOT fit run-code's single-expression sandbox.
// walk-vue-tree.js — find a Vue component instance by the SHAPE of its $data
// (a set of keys you expect, e.g. ['comments', 'counterVideoLive']) rather than
// by DOM selector. Useful when Vuex doesn't expose the state you need — the
// component holds it in local $data instead, and you don't know which of many
// nested components it lives on.
//
// Companion to primitives.md §10 (Vue v-model native-setter trick): that's for
// WRITING into a v-model input. This is for READING/FINDING state on an
// arbitrary component instance, no writing involved.
//
// EXECUTION CONTEXT: paste this whole file into DevTools Console (same as
// comprehensive-search-harvest.js) — it doesn't fit run-code's single-arrow
// sandbox (primitives.md §17) since it's a reusable function meant to be
// called against different roots/keys interactively. Then from the console:
//
//   findVueComponent(document.querySelector('#app').__vue__, ['comments', 'counterVideoLive'])
//
// `document.querySelector('#app').__vue__` is the Vue 2 root instance. For
// Vue 3, Composition API instances don't expose plain $data/$children the same
// way — check `.setupState` and `.ctx`/`.subTree` instead if $data comes back
// empty, or use the Vue DevTools global hook to grab a selected instance
// ($vm0 after clicking it in the Vue DevTools panel).
//
// To run non-interactively via `playwright-cli run-code --filename=`, wrap ONE
// call in a single arrow expression instead:
//   async (page) => {
//     return await page.evaluate(() => {
//       <paste findVueComponent body here>
//       return findVueComponent(document.querySelector('#app').__vue__, ['comments']);
//     });
//   }

function findVueComponent(root, expectedKeys, opts = {}) {
  const maxDepth = opts.maxDepth ?? 20;
  const visited = new Set();
  const matches = [];

  const score = (data) => {
    if (!data || typeof data !== 'object') return 0;
    return expectedKeys.filter((k) => k in data).length;
  };

  const walk = (vm, path, depth) => {
    if (!vm || depth > maxDepth || visited.has(vm)) return;
    visited.add(vm);

    const data = vm.$data || (vm.setupState ? vm.setupState : null);
    const s = score(data);
    if (s > 0) {
      matches.push({
        path,
        matchedKeys: expectedKeys.filter((k) => data && k in data),
        score: s,
        componentName: (vm.$options && (vm.$options.name || vm.$options._componentTag)) || '<anonymous>',
      });
    }

    const children = vm.$children || [];
    children.forEach((child, i) => walk(child, `${path}.$children[${i}]`, depth + 1));
  };

  walk(root, 'root', 0);
  matches.sort((a, b) => b.score - a.score);
  return {
    bestMatch: matches[0] || null,
    allMatches: matches,
    note: matches.length === 0
      ? 'No component matched — if this is Vue 3, $children/$data may not exist on Composition API components; try inspecting vm.setupState / vm.ctx directly, or use the Vue DevTools global hook ($vm0 after selecting in the Vue tab).'
      : undefined,
  };
}
