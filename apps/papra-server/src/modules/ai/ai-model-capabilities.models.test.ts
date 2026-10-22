import { describe, expect, it } from 'vitest';
import {
  computeMetadataInputBudget,
  METADATA_INPUT_CEILING_MAX_CHARS,
  METADATA_INPUT_DEFAULT_MAX_CHARS,
  METADATA_INPUT_MIN_CHARS,
  parseAnthropicModelMetadata,
  parseOllamaShowResponse,
  parseOpenAiCompatibleModelMetadata,
  resolveFamilyMaxLongEdge,
} from './ai-model-capabilities.models';

describe('ai-model-capabilities.models', () => {
  describe('resolveFamilyMaxLongEdge', () => {
    it.each([
      ['claude-sonnet-4-20250514', 1568],
      ['anthropic/claude-opus-4.1', 1568],
      ['CLAUDE-3-5-SONNET', 1568],
      ['gpt-4o', 2048],
      ['gpt-4.1-mini', 2048],
      ['o3', 2048],
      ['o4-mini-2025-04-16', 2048],
      ['gemma3:27b', 768],
      ['gemma-3-12b-it', 768],
      ['qwen2.5-vl-7b-instruct', 1600],
      ['qwen2.5vl:7b', 1600],
      ['llama3.1:8b', undefined],
      ['gpt-3.5-turbo', undefined],
    ])('maps %s to %s', (modelName, expected) => {
      expect(resolveFamilyMaxLongEdge({ modelName })).toBe(expected);
    });
  });

  describe('computeMetadataInputBudget', () => {
    it('falls back to the conservative default when no context is advertised', () => {
      expect(computeMetadataInputBudget({})).toBe(METADATA_INPUT_DEFAULT_MAX_CHARS);
      expect(computeMetadataInputBudget({ contextLength: 0 })).toBe(
        METADATA_INPUT_DEFAULT_MAX_CHARS,
      );
    });

    it('converts ~40% of the context window to characters', () => {
      // 32k tokens * 4 chars/token * 0.4 = 51.2k chars
      expect(computeMetadataInputBudget({ contextLength: 32_768 })).toBe(
        Math.round(32_768 * 4 * 0.4),
      );
    });

    it('floors tiny-context models to at least a page of text', () => {
      expect(computeMetadataInputBudget({ contextLength: 512 })).toBe(METADATA_INPUT_MIN_CHARS);
    });

    it('caps huge contexts: metadata is front-loaded, extra input is pure cost', () => {
      expect(computeMetadataInputBudget({ contextLength: 1_000_000 })).toBe(
        METADATA_INPUT_CEILING_MAX_CHARS,
      );
    });
  });

  describe('parseOpenAiCompatibleModelMetadata', () => {
    it('reads OpenRouter-style context_length and input modalities', () => {
      expect(
        parseOpenAiCompatibleModelMetadata({
          id: 'anthropic/claude-sonnet-4',
          context_length: 200_000,
          architecture: { modality: 'text+image=>text', input_modalities: ['text', 'image'] },
        }),
      ).to.eql({ contextLength: 200_000, visionCapable: true });
    });

    it('detects non-vision models from the modality list', () => {
      expect(
        parseOpenAiCompatibleModelMetadata({
          context_length: 64_000,
          architecture: { input_modalities: ['text'] },
        }),
      ).to.eql({ contextLength: 64_000, visionCapable: false });
    });

    it('accepts vLLM-style max_model_len and top-level modalities', () => {
      expect(
        parseOpenAiCompatibleModelMetadata({
          max_model_len: 32_768,
          supported_modalities: ['text', 'image'],
        }),
      ).to.eql({ contextLength: 32_768, visionCapable: true });
    });

    it('falls back to the legacy modality string', () => {
      expect(
        parseOpenAiCompatibleModelMetadata({ architecture: { modality: 'text=>text' } }),
      ).to.eql({ visionCapable: false });
    });

    it('returns an empty metadata object for bare or malformed bodies', () => {
      expect(parseOpenAiCompatibleModelMetadata({ id: 'gpt-4o' })).to.eql({});
      expect(parseOpenAiCompatibleModelMetadata('nope')).to.eql({});
      expect(parseOpenAiCompatibleModelMetadata(null)).to.eql({});
    });
  });

  describe('parseOllamaShowResponse', () => {
    it('reads architecture-prefixed context_length and vision capability', () => {
      expect(
        parseOllamaShowResponse({
          model_info: {
            'general.architecture': 'qwen2.5vl',
            'qwen2.5vl.context_length': 32_768,
            'qwen2.5vl.blur': 5,
          },
          capabilities: ['completion', 'vision'],
        }),
      ).to.eql({ contextLength: 32_768, visionCapable: true });
    });

    it('reports a text-only ollama model as not vision capable', () => {
      expect(
        parseOllamaShowResponse({
          model_info: { 'llama.context_length': 131_072 },
          capabilities: ['completion', 'tools'],
        }),
      ).to.eql({ contextLength: 131_072, visionCapable: false });
    });

    it('tolerates missing fields', () => {
      expect(parseOllamaShowResponse({ model_info: {} })).to.eql({});
      expect(parseOllamaShowResponse(undefined)).to.eql({});
    });
  });

  describe('parseAnthropicModelMetadata', () => {
    it('picks up max_input_tokens when present', () => {
      expect(
        parseAnthropicModelMetadata({ id: 'claude-sonnet-4', max_input_tokens: 200_000 }),
      ).to.eql({ contextLength: 200_000 });
    });

    it('returns nothing for the current sparse model listing', () => {
      expect(parseAnthropicModelMetadata({ id: 'claude-sonnet-4', type: 'model' })).to.eql({});
    });
  });
});
