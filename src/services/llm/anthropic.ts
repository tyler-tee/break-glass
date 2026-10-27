import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  LlmRefusalError,
  LlmValidationError,
  parseOrReject,
  type LlmProvider,
} from './provider.js';

export function anthropicProvider(client: Anthropic): LlmProvider {
  return {
    async generateJson({ model, system, prompt, schema, maxTokens, effort }) {
      // Drop the SDK's parse hook: we validate ourselves so failures keep the raw text.
      const { parse: _ignored, ...format } = zodOutputFormat(schema);
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens ?? 4096,
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format, ...(effort ? { effort } : {}) },
      });
      if (response.stop_reason === 'refusal') {
        throw new LlmRefusalError(response.stop_details?.category ?? null);
      }
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      if (response.stop_reason === 'max_tokens') {
        throw new LlmValidationError(text, null, 'output truncated at max_tokens');
      }
      return parseOrReject(schema, text);
    },
  };
}
