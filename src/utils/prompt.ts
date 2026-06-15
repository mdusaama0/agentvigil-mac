import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Prompts the user on stdin/stdout and resolves with their trimmed answer. */
export async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
