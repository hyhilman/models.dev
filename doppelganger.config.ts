// The plugins this repo attaches to doppelganger. The engine runs from its release image, which
// answers the plugin's `doppelganger/*` imports itself, so the repo installs no package. The engine
// reads only the default export's `plugins`.
import prices from "./local/doppelganger/tools/prices/plugin.ts";

export default { plugins: [prices] };
