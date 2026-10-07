import { eslintCompatPlugin } from "@oxlint/plugins";

import { noDirectEffectPromiseRule } from "./rules/no-direct-effect-promise.ts";

/** Rules owned by this repository. The vendored anti-slop plugins stay byte-identical to upstream. */
const catalogPlugin = eslintCompatPlugin({
  meta: { name: "catalog" },
  rules: {
    "no-direct-effect-promise": noDirectEffectPromiseRule,
  },
});

export default catalogPlugin;
