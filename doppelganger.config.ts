// The plugins this repo attaches to doppelganger. The package is installed in local/doppelganger/
// (npm cannot install into this Bun workspace root), so this file imports nothing from it: the
// engine reads only the default export's `plugins`.
import prices from "./local/doppelganger/tools/prices/plugin.ts";

export default { plugins: [prices] };
