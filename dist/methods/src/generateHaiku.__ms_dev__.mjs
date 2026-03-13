// dist/methods/src/generateHaiku.ts
import { mindstudio } from "@mindstudio-ai/agent";

// dist/methods/src/tables/haikus.ts
import { db } from "@mindstudio-ai/agent";
var Haikus = db.defineTable("haikus");

// dist/methods/src/generateHaiku.ts
async function generateHaiku(input) {
  const { content } = await mindstudio.generateText({
    message: `Write a haiku about: ${input.topic}. Reply with only the haiku \u2014 three lines, no title, no extra commentary.`
  });
  const haiku = await Haikus.push({
    topic: input.topic,
    text: content
  });
  return {
    id: haiku.id,
    topic: haiku.topic,
    text: haiku.text
  };
}
export {
  generateHaiku
};
