import { UniversalRequest } from '../ir/types.js';
import { extractTextFromContent } from '../ir/validator.js';

export type PromptCategory = 'TRIVIAL' | 'CODE_DEV' | 'REASONING' | 'CREATIVE' | 'GENERAL';

export interface ClassificationResult {
  category: PromptCategory;
  complexityScore: number; // 0.0 (trivial) to 1.0 (deep reasoning/complex)
  recommendedTier: 'fast' | 'coding' | 'reasoning' | 'auto';
  paretoExplanation: string;
  hasTools: boolean;
  hasVision: boolean;
}

export class IntentClassifier {
  static classify(req: UniversalRequest): ClassificationResult {
    const messages = req.messages || [];
    const lastMsg = messages[messages.length - 1];
    const fullText = messages.map(m => extractTextFromContent(m.content)).join('\n').toLowerCase();
    const lastText = lastMsg ? extractTextFromContent(lastMsg.content).toLowerCase() : '';

    const hasVision = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
    const hasTools = Array.isArray(req.tools) && req.tools.length > 0;

    // 1. Check for Trivial / Greetings / Short ping
    const trivialWords = ['hi', 'hello', 'hey', 'ping', 'test', 'are you there', 'who are you', 'help', 'morning', 'thanks', 'thank you'];
    const isTrivial = lastText.length < 35 && trivialWords.some(w => lastText.trim() === w || lastText.startsWith(w + ' ') || lastText.endsWith(' ' + w));
    if (isTrivial) {
      return {
        category: 'TRIVIAL',
        complexityScore: 0.1,
        recommendedTier: 'fast',
        paretoExplanation: 'Low token count & conversational greeting detected. Routed to high-throughput, low-cost tier.',
        hasTools,
        hasVision,
      };
    }

    // 2. Check for Code Development / Debugging / Refactoring
    const codeKeywords = [
      'function', 'class', 'const', 'import', 'export', 'def', 'return',
      'typescript', 'python', 'javascript', 'rust', 'golang', 'sql', 'html', 'css',
      'bug', 'error', 'exception', 'stack trace', 'refactor', 'regex', 'api', 'endpoint',
      'dockerfile', 'yaml', 'json', 'algorithm', 'git', 'pull request'
    ];
    const codeMatches = codeKeywords.filter(k => fullText.includes(k)).length;
    if (codeMatches >= 2 || fullText.includes('```') || fullText.includes('write code') || fullText.includes('write a function') || fullText.includes('write a script')) {
      return {
        category: 'CODE_DEV',
        complexityScore: 0.85,
        recommendedTier: 'coding',
        paretoExplanation: 'Software engineering / code syntax patterns detected. Routed to frontier code synthesis tier.',
        hasTools,
        hasVision,
      };
    }

    // 3. Check for Math / Deep Reasoning / Complex Analysis
    const reasoningKeywords = [
      'prove', 'theorem', 'derivation', 'calculate', 'step-by-step', 'logic puzzle',
      'solve', 'equation', 'probability', 'statistics', 'game theory', 'quantum',
      'philosophy', 'deduce', 'why does', 'implication', 'evaluate trade-offs'
    ];
    const reasoningMatches = reasoningKeywords.filter(k => fullText.includes(k)).length;
    if (reasoningMatches >= 2 || fullText.length > 800 || lastText.includes('step by step') || lastText.includes('think carefully')) {
      return {
        category: 'REASONING',
        complexityScore: 0.95,
        recommendedTier: 'reasoning',
        paretoExplanation: 'Complex deductive reasoning or long-context analysis detected. Routed to frontier reasoning tier.',
        hasTools,
        hasVision,
      };
    }

    // 4. Check for Creative Writing / Brainstorming
    const creativeKeywords = ['story', 'poem', 'essay', 'brainstorm', 'joke', 'metaphor', 'rewrite', 'tone', 'dialogue'];
    if (creativeKeywords.some(k => fullText.includes(k))) {
      return {
        category: 'CREATIVE',
        complexityScore: 0.5,
        recommendedTier: 'auto',
        paretoExplanation: 'Creative writing / generation intent. Routed to balanced flagship tier.',
        hasTools,
        hasVision,
      };
    }

    // 5. Default General
    return {
      category: 'GENERAL',
      complexityScore: 0.4,
      recommendedTier: 'auto',
      paretoExplanation: 'General knowledge / balanced query. Routed to standard Pareto optimal tier.',
      hasTools,
      hasVision,
    };
  }
}
