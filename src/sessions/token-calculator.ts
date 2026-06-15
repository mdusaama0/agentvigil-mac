import fs from 'node:fs/promises';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  filesModified: number;
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  filesModified: 0,
};

// Per-million-token USD rates. Matched by substring against the transcript's
// `message.model` (e.g. "claude-sonnet-4-6"). These are estimates for the
// daily summary and may drift from Anthropic's published pricing over time.
const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  opus:   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  haiku:  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
};
const DEFAULT_PRICING = PRICING.sonnet;

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function pricingForModel(model: string): typeof DEFAULT_PRICING {
  const key = Object.keys(PRICING).find((k) => model.toLowerCase().includes(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

/**
 * Sums token usage and cost across every assistant turn in a Claude Code
 * transcript, and counts the distinct files touched via Write/Edit/MultiEdit.
 * Returns all-zero usage if the transcript can't be read.
 */
export async function calculateTokenUsage(transcriptPath: string): Promise<TokenUsage> {
  if (!transcriptPath) return { ...ZERO_USAGE };

  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.trim());

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let estimatedCostUsd = 0;
    const filesTouched = new Set<string>();

    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const usage = entry?.message?.usage;
      if (usage) {
        const model: string = entry.message.model ?? '';
        const pricing = pricingForModel(model);

        const input = usage.input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const cacheWrite = usage.cache_creation_input_tokens ?? 0;

        inputTokens += input;
        outputTokens += output;
        cacheReadTokens += cacheRead;

        estimatedCostUsd +=
          (input * pricing.input +
            output * pricing.output +
            cacheRead * pricing.cacheRead +
            cacheWrite * pricing.cacheWrite) /
          1_000_000;
      }

      collectModifiedFiles(entry, filesTouched);
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens,
      estimatedCostUsd,
      filesModified: filesTouched.size,
    };
  } catch {
    return { ...ZERO_USAGE };
  }
}

/** Adds the file path of any Write/Edit/MultiEdit tool_use block in `entry` to `filesTouched`. */
function collectModifiedFiles(entry: any, filesTouched: Set<string>): void {
  const blocks = entry?.message?.content;
  if (!Array.isArray(blocks)) return;

  for (const block of blocks) {
    if (block?.type !== 'tool_use' || !FILE_TOOLS.has(block.name)) continue;

    const filePath = (block.input?.file_path ?? block.input?.path) as string | undefined;
    if (filePath) filesTouched.add(filePath);
  }
}
