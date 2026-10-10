// local/ has no package.json of its own, since that would mean editing upstream's workspace
// list. Bun installs zod under packages/core only, so we borrow that copy: the same version
// the upstream schema uses.
export { z } from "../../packages/core/node_modules/zod";
