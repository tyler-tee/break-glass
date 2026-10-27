import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LlmRefusalError, parseOrReject, type LlmProvider } from './provider.js';

export function anthropicProvider(client: Anthropic): LlmProvider {
  return {
    async generateJson({ model, system, prompt, schema, maxTokens, effort }) {
      const response = await client.messages.parse({
        model,
        max_tokens: maxTokens ?? 4096,
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: zodOutputFormat(schema), ...(effort ? { effort } : {}) },
      });
      if (response.stop_reason === 'refusal') {
        throw new LlmRefusalError(response.stop_details?.category ?? null);
      }
      if (response.parsed_output != null) return response.parsed_output;
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      return parseOrReject(schema, text);
    },
  };
}
