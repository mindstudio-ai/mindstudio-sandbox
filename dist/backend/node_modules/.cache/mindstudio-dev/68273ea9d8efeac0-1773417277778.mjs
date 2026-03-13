// dist/methods/src/tables/haikus.ts
import { db } from "@mindstudio-ai/agent";
var Haikus = db.defineTable("haikus");

// dist/methods/src/listHaikus.ts
async function listHaikus() {
  const haikus = await Haikus.sortBy((h) => h.created_at).reverse();
  return { haikus };
}
export {
  listHaikus
};
