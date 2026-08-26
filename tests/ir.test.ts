import { describe, it, expect } from 'vitest';
import { validateAndNormalizeRequest, ValidationError, extractTextFromContent } from '../src/ir/validator.js';

describe('Canonical IR & Validator', () => {
  it('should validate and normalize a standard OpenAI request', () => {
    const raw = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello world' },
      ],
      temperature: 0.5,
      stream: false,
      session_id: 'chat-session-123',
      openrouter_routing: 'cheapest',
    };

    const req = validateAndNormalizeRequest(raw);
    expect(req.model).toBe('auto');
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0].role).toBe('system');
    expect(req.messages[1].role).toBe('user');
    expect(req.temperature).toBe(0.5);
    expect(req.stream).toBe(false);
    expect(req.session_id).toBe('chat-session-123');
    expect(req.openrouter_routing).toBe('cheapest');
  });

  it('should throw ValidationError on missing model or empty messages', () => {
    expect(() => validateAndNormalizeRequest({})).toThrow(ValidationError);
    expect(() => validateAndNormalizeRequest({ model: 'auto', messages: [] })).toThrow(ValidationError);
  });

  it('should extract text from multi-modal content parts', () => {
    const parts = [
      { type: 'text' as const, text: 'Part 1' },
      { type: 'image_url' as const, image_url: { url: 'https://example.com/img.png' } },
      { type: 'text' as const, text: 'Part 2' },
    ];
    const text = extractTextFromContent(parts);
    expect(text).toBe('Part 1\nPart 2');
  });
});
