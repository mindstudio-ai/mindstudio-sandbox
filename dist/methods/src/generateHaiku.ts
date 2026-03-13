import { mindstudio } from '@mindstudio-ai/agent';
import { Haikus } from './tables/haikus';

export interface GenerateHaikuInput {
  topic: string;
}

export interface GenerateHaikuOutput {
  id: string;
  topic: string;
  text: string;
}

export async function generateHaiku(
  input: GenerateHaikuInput,
): Promise<GenerateHaikuOutput> {
  const { content } = await mindstudio.generateText({
    message: `Write a haiku about: ${input.topic}. Reply with only the haiku — three lines, no title, no extra commentary.`,
  });

  const haiku = await Haikus.push({
    topic: input.topic,
    text: content,
  });

  return {
    id: haiku.id,
    topic: haiku.topic,
    text: haiku.text,
  };
}
