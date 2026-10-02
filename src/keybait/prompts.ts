/**
 * src/keybait/prompts.ts - KeyBait Prompt Catalog & Trap Sniffer for NexusRoute
 * Curated collection of small, useful, and awkward challenge prompts designed
 * to test API keys and models without manual typing.
 */

export interface KeyBaitPrompt {
  id: string;
  title: string;
  category: 'traps' | 'pings' | 'formats' | 'ideas' | 'useful' | 'meta';
  tags: string[];
  prompt: string;
  system_prompt?: string;
  trap_description: string;
  expected_type: 'regex_match' | 'contains_all' | 'contains_any' | 'custom_eval' | 'none';
  regex?: string;
  expected_value?: string[];
  fail_value?: string[];
  eval_key?: string;
  pass_message: string;
  fail_message: string;
}

export interface TrapEvaluation {
  status: 'passed' | 'failed' | 'unverified';
  message: string;
}

export const KEYBAIT_PROMPTS: KeyBaitPrompt[] = [
  // ==========================================
  // CATEGORY: 🦝 AWKWARD TRAPS & LOGIC SNAGS
  // ==========================================
  {
    id: "trap_strawberry",
    title: "The Strawberry 'R' Trap",
    category: "traps",
    tags: ["tokenization", "classic", "counting"],
    prompt: "How many times does the letter 'r' appear in the word 'strawberry'? Answer with just the number and a 1-sentence explanation.",
    trap_description: "Tests character tokenization. Weak models say 2; capable models correctly count 3.",
    expected_type: "contains_all",
    expected_value: ["3"],
    fail_value: ["2", "two"],
    pass_message: "Trap Avoided! Correctly identified 3 'r's in strawberry.",
    fail_message: "Fell into trap! Claimed there are 2 'r's (classic tokenization error)."
  },
  {
    id: "trap_911_vs_99",
    title: "9.11 vs 9.9 Comparison",
    category: "traps",
    tags: ["math", "numbers", "classic"],
    prompt: "Which number is larger: 9.11 or 9.9? State the larger number first, then explain why in one short sentence.",
    trap_description: "Tests decimal vs version-string reasoning. LLMs often confuse 9.11 with 9.9 because 11 > 9.",
    expected_type: "custom_eval",
    eval_key: "eval_911_vs_99",
    pass_message: "Trap Avoided! Correctly identified 9.9 as larger than 9.11.",
    fail_message: "Fell into trap! Claimed 9.11 is larger than 9.9."
  },
  {
    id: "trap_bat_ball",
    title: "Bat & Ball Cost Trap",
    category: "traps",
    tags: ["math", "cognitive-reflection"],
    prompt: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Respond with just the exact price of the ball.",
    trap_description: "Tests cognitive reflection. Intuitive answer is 10 cents ($0.10); correct math answer is 5 cents ($0.05).",
    expected_type: "custom_eval",
    eval_key: "eval_bat_ball",
    pass_message: "Trap Avoided! Correctly calculated $0.05 (5 cents).",
    fail_message: "Fell into trap! Answered 10 cents ($0.10)."
  },
  {
    id: "trap_dirt_hole",
    title: "Dirt in a Hole",
    category: "traps",
    tags: ["lateral-thinking", "riddle"],
    prompt: "How much dirt is inside a hole that is 4 feet deep, 3 feet wide, and 6 feet long? Answer in 1 short sentence.",
    trap_description: "Tests lateral reasoning. A hole has no dirt in it (it is empty).",
    expected_type: "custom_eval",
    eval_key: "eval_dirt_hole",
    pass_message: "Trap Avoided! Recognized that a hole contains zero dirt.",
    fail_message: "Fell into trap! Calculated volume (72 cubic feet) instead of noting the hole is empty."
  },
  {
    id: "trap_second_place",
    title: "Overtaking Second Place",
    category: "traps",
    tags: ["logic", "riddle"],
    prompt: "You are running in a marathon race and you overtake the person running in second place. What position are you in now? Answer with just the position name.",
    trap_description: "Tests intuitive rush. People/LLMs often say 1st place, but overtaking 2nd leaves you in 2nd place.",
    expected_type: "custom_eval",
    eval_key: "eval_second_place",
    pass_message: "Trap Avoided! Correctly stated 2nd place.",
    fail_message: "Fell into trap! Said 1st place."
  },
  {
    id: "trap_word_count_self",
    title: "Self-Referential Sentence Word Count",
    category: "traps",
    tags: ["counting", "self-reference"],
    prompt: "How many words are in this exact prompt sentence? Provide the count as an Arabic numeral first, then count them out.",
    trap_description: "Tests strict word counting in the prompt (there are exactly 17 words).",
    expected_type: "contains_all",
    expected_value: ["17"],
    pass_message: "Spot on! Correctly counted 17 words.",
    fail_message: "Count mismatch (prompt has exactly 17 words)."
  },
  {
    id: "trap_parents_sisters",
    title: "The Brother and Sister Puzzle",
    category: "traps",
    tags: ["logic", "deduction"],
    prompt: "Mary's father has 5 daughters: Nana, Nene, Nini, and Nono. What is the name of the fifth daughter? Answer in one word.",
    trap_description: "Tests attentiveness to context. The fifth daughter is Mary.",
    expected_type: "regex_match",
    regex: "(?i)\\bMary\\b",
    pass_message: "Trap Avoided! Name is Mary.",
    fail_message: "Fell into trap! Guessed 'Nunu' or other vowel continuation."
  },
  {
    id: "trap_heavier_feathers_bricks",
    title: "1kg Feathers vs 2kg Bricks",
    category: "traps",
    tags: ["logic", "twist"],
    prompt: "Which is heavier: 1 kilogram of feathers, or 2 kilograms of bricks? Answer in one clear sentence.",
    trap_description: "Tests over-correction on the classic riddle. Because weights are 1kg vs 2kg, the bricks ARE heavier!",
    expected_type: "regex_match",
    regex: "(?i)\\b(brick|2\\s*kg|two\\s*kilo)\\b",
    pass_message: "Trap Avoided! Caught the weight difference (2kg bricks is heavier).",
    fail_message: "Fell into reverse trap! Claimed they weigh the same."
  },
  {
    id: "trap_no_letter_e",
    title: "Write a Sentence Without the Letter 'E'",
    category: "traps",
    tags: ["constraint", "lipogram"],
    prompt: "Write a 10-word sentence describing the night sky without using the letter 'e' anywhere in your response. No introductory text.",
    trap_description: "Tests strict constraint following (lipogram without 'e').",
    expected_type: "custom_eval",
    eval_key: "eval_no_letter_e",
    pass_message: "Perfect lipogram! Zero instances of 'e' found.",
    fail_message: "Constraint violated: The letter 'e' was found in the output."
  },
  {
    id: "trap_rooster_egg",
    title: "Rooster on the Roof",
    category: "traps",
    tags: ["biology", "riddle"],
    prompt: "A rooster lays an egg on the peak of a barn roof. Which side does the egg roll down? Answer in 1 sentence.",
    trap_description: "Tests basic biological fact check. Roosters don't lay eggs.",
    expected_type: "regex_match",
    regex: "(?i)\\b(rooster.*not|don'?t lay|cannot lay|no egg)\\b",
    pass_message: "Trap Avoided! Correctly pointed out roosters do not lay eggs.",
    fail_message: "Fell into trap! Speculated which side the egg rolls."
  },

  // ==========================================
  // CATEGORY: ⚡ MICRO-PINGS (FAST LATENCY & QUOTA)
  // ==========================================
  {
    id: "ping_pong",
    title: "1-Token 'PONG' Echo",
    category: "pings",
    tags: ["ping", "minimal", "latency"],
    prompt: "Respond with the single uppercase word: PONG. Do not include punctuation, markdown, or greetings.",
    trap_description: "Ultra-fast sanity test. Consumes ~5 tokens total.",
    expected_type: "regex_match",
    regex: "^[\\s\"'`]*PONG[\\s\"'`]*$",
    pass_message: "Clean single-token PONG returned with zero filler.",
    fail_message: "Included extra conversational filler or wrong casing."
  },
  {
    id: "ping_42",
    title: "Return the Number 42",
    category: "pings",
    tags: ["ping", "minimal", "latency"],
    prompt: "Output only the number 42 and nothing else.",
    trap_description: "Zero-cost latency check. Tests prompt brevity adherence.",
    expected_type: "regex_match",
    regex: "^[\\s\"'`]*42[\\s\"'`]*$",
    pass_message: "Exact match '42' returned instantly.",
    fail_message: "Output contained additional commentary."
  },
  {
    id: "ping_ascii_cat",
    title: "3-Line ASCII Cat",
    category: "pings",
    tags: ["ping", "ascii", "fun"],
    prompt: "Generate a cute 3-line ASCII art cat. No text before or after.",
    trap_description: "Quick formatting and monospace test.",
    expected_type: "custom_eval",
    eval_key: "eval_ascii_art",
    pass_message: "ASCII cat received!",
    fail_message: "Failed to output concise ASCII."
  },
  {
    id: "ping_pin",
    title: "Random 6-Digit PIN",
    category: "pings",
    tags: ["ping", "digits", "minimal"],
    prompt: "Output a random 6-digit PIN code. Only the 6 digits, nothing else.",
    trap_description: "Tests pure numerical output adherence.",
    expected_type: "regex_match",
    regex: "^\\s*\\d{6}\\s*$",
    pass_message: "Clean 6-digit PIN returned.",
    fail_message: "Output was not exactly 6 digits."
  },
  {
    id: "ping_uuid",
    title: "Generate a Valid UUIDv4",
    category: "pings",
    tags: ["ping", "regex", "uuid"],
    prompt: "Generate one valid UUIDv4 string. Output ONLY the raw UUID string, no quotes or backticks.",
    trap_description: "Tests syntax precision and minimal token usage.",
    expected_type: "regex_match",
    regex: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    pass_message: "Valid UUIDv4 format generated!",
    fail_message: "Output did not match standard UUIDv4 specification."
  },

  // ==========================================
  // CATEGORY: 📐 STRICT FORMATS & STRAITJACKETS
  // ==========================================
  {
    id: "fmt_strict_json",
    title: "Zero-Chatter Strict JSON",
    category: "formats",
    tags: ["json", "strict", "schema"],
    prompt: "Return a raw JSON object with exactly these keys: 'api_status' (string 'operational'), 'latency_estimate_ms' (integer 15), 'tags' (array of 3 tech words). Do NOT wrap in markdown ```json codeblocks. Output ONLY the raw JSON string starting with { and ending with }.",
    trap_description: "Tests if model obeys 'no markdown codeblock' instructions for headless API pipelines.",
    expected_type: "custom_eval",
    eval_key: "eval_strict_json",
    pass_message: "Valid raw JSON parsed without unwanted markdown ticks!",
    fail_message: "Failed strict JSON requirement (invalid JSON or wrapped in markdown fences)."
  },
  {
    id: "fmt_markdown_pipes",
    title: "Markdown Table with Literal Pipes",
    category: "formats",
    tags: ["markdown", "table", "escaping"],
    prompt: "Create a 3-row Markdown table with columns: 'Tool', 'Syntax', 'Description'. In the 'Syntax' column, include literal pipe characters '|' escaped properly with backslashes. Do not provide intro or outro text.",
    trap_description: "Tests Markdown escaping capabilities inside table syntax.",
    expected_type: "custom_eval",
    eval_key: "eval_markdown_table",
    pass_message: "Properly structured Markdown table with pipe escaping.",
    fail_message: "Missing markdown table structure or unescaped pipes."
  },
  {
    id: "fmt_regex_ipv4",
    title: "IPv4 Regex Pattern Only",
    category: "formats",
    tags: ["regex", "syntax"],
    prompt: "Provide a regular expression pattern to match an IPv4 address. Output ONLY the raw regex pattern inside slashes, e.g. /.../. No explanation.",
    trap_description: "Tests adherence to regex format without conversational fluff.",
    expected_type: "regex_match",
    regex: "^/.+/$",
    pass_message: "Clean regex pattern delivered.",
    fail_message: "Did not output strictly within slashes or added commentary."
  },
  {
    id: "fmt_csv_planets",
    title: "Raw CSV of 4 Planets",
    category: "formats",
    tags: ["csv", "structured"],
    prompt: "Output a valid CSV with headers: name,radius_km,moons. Provide exactly 4 solar system planets. No markdown formatting, just raw text.",
    trap_description: "Tests clean CSV generation without markdown block wrapping.",
    expected_type: "custom_eval",
    eval_key: "eval_csv_planets",
    pass_message: "Valid 5-line CSV (header + 4 rows) received.",
    fail_message: "CSV format incorrect or wrapped in markdown."
  },
  {
    id: "fmt_single_line_lambda",
    title: "1-Line Python Anagram Lambda",
    category: "formats",
    tags: ["python", "code", "oneliner"],
    prompt: "Write a 1-line Python lambda function assigned to variable 'is_anagram' that checks if two lowercase strings s1 and s2 are anagrams. Output ONLY the code line.",
    trap_description: "Tests code precision with zero conversational preamble.",
    expected_type: "regex_match",
    regex: "(?i)^\\s*is_anagram\\s*=\\s*lambda\\s+s1,\\s*s2\\s*:",
    pass_message: "Clean Python one-liner returned.",
    fail_message: "Did not strictly follow the lambda variable assignment syntax."
  },

  // ==========================================
  // CATEGORY: 💡 AWKWARD MINI-APP IDEAS
  // ==========================================
  {
    id: "idea_win_tray",
    title: "Bizarre Windows Tray Utility Idea",
    category: "ideas",
    tags: ["windows", "app-ideas", "quirky"],
    prompt: "Pitch 1 weird, awkward, but genuinely useful micro-app for the Windows system tray that solves a hyper-specific daily annoyance and can be built in C# or Python in under 2 hours. Format with: [App Name], [The Awkward Problem], [The 1-Click Solution], [Key Windows API Used].",
    trap_description: "Gives you a fresh, fun, quirky Windows desktop project to build.",
    expected_type: "custom_eval",
    eval_key: "eval_app_idea",
    pass_message: "Fresh Windows micro-app concept generated!",
    fail_message: "Output lacked required structured sections."
  },
  {
    id: "idea_android_single_screen",
    title: "Single-Screen Android Micro-Tool",
    category: "ideas",
    tags: ["android", "app-ideas", "mobile"],
    prompt: "Give me 1 awkward, niche Android utility idea that fits on a single screen with zero backend or account login. Something that leverages an on-device sensor or local storage in a novel way. Format: Name, Annoying Problem It Solves, How It Works, Why It's Fun.",
    trap_description: "Sparks an instant Android project idea with minimal complexity.",
    expected_type: "custom_eval",
    eval_key: "eval_app_idea",
    pass_message: "Snappy Android micro-tool idea pitched!",
    fail_message: "Response was incomplete or unfocused."
  },
  {
    id: "idea_single_button_gadget",
    title: "The One-Button Desktop Toy",
    category: "ideas",
    tags: ["gadget", "minimal", "app-ideas"],
    prompt: "Invent a desktop gadget or floating widget with literally ONE physical-looking toggle switch or button. When clicked, it performs one oddly satisfying or hilarious digital action. Provide: Concept, What Happens on Click, Sound Effect Idea, 50-line Implementation Strategy.",
    trap_description: "Ideas for minimal UI delight gadgets.",
    expected_type: "custom_eval",
    eval_key: "eval_app_idea",
    pass_message: "One-button gadget designed!",
    fail_message: "Response was too generic."
  },
  {
    id: "idea_fake_productivity",
    title: "Fake 'Busy' Screen Generator",
    category: "ideas",
    tags: ["windows", "fun", "app-ideas"],
    prompt: "Design a Windows terminal tool called 'BossPanic' or similar that instantly streams realistic movie-style matrix compilation / kernel debugging logs on hotkey press. Give a 3-point feature checklist and a 10-line Python snippet.",
    trap_description: "Quirky desktop simulation idea.",
    expected_type: "contains_any",
    expected_value: ["python", "def", "import"],
    pass_message: "Hilarious productivity simulation blueprint generated.",
    fail_message: "Missing Python snippet."
  },

  // ==========================================
  // CATEGORY: 🛠️ SMALL & USEFUL MICRO-TASKS
  // ==========================================
  {
    id: "util_fix_json",
    title: "Repair Broken JSON Syntax",
    category: "useful",
    tags: ["utility", "json", "repair"],
    prompt: "Fix the syntax errors in this broken JSON and output ONLY the corrected JSON: { name: 'Alex', age: 29, hobbies: ['reading', 'coding',], 'status': active }",
    trap_description: "Tests autonomous code repair and output sanitization.",
    expected_type: "custom_eval",
    eval_key: "eval_strict_json",
    pass_message: "Fixed JSON and returned valid parseable syntax!",
    fail_message: "Output is still invalid JSON."
  },
  {
    id: "util_explain_429",
    title: "Explain HTTP 429 & Backoff",
    category: "useful",
    tags: ["http", "developer", "quick"],
    prompt: "Explain HTTP status code 429 and describe jittered exponential backoff in exactly 2 clear bullet points. No intro or outro.",
    trap_description: "Concise technical reference test.",
    expected_type: "regex_match",
    regex: "(?i)(rate limit|too many requests)",
    pass_message: "Accurate 429 summary with backoff explanation.",
    fail_message: "Did not clearly explain rate limits."
  },
  {
    id: "util_curl_to_python",
    title: "Convert cURL to Python Requests",
    category: "useful",
    tags: ["code", "conversion", "python"],
    prompt: "Convert this curl command into clean Python using the requests library. Output code block only:\ncurl -X POST https://api.example.com/v1/ping -H 'Authorization: Bearer secret_123' -d '{\"hello\":\"world\"}'",
    trap_description: "Tests syntax conversion accuracy.",
    expected_type: "contains_all",
    expected_value: ["requests.post", "headers", "Bearer secret_123"],
    pass_message: "Accurate Python requests conversion!",
    fail_message: "Missing key requests.post components."
  },
  {
    id: "util_dummy_users_json",
    title: "Generate 3 Mock User Objects",
    category: "useful",
    tags: ["mock-data", "json"],
    prompt: "Output a raw JSON array of 3 realistic dummy user objects with keys: id, username, email, role (admin/editor/viewer). Raw JSON only.",
    trap_description: "Tests clean mock data generation.",
    expected_type: "custom_eval",
    eval_key: "eval_mock_users",
    pass_message: "Valid array of 3 user objects returned.",
    fail_message: "Invalid JSON or wrong array length."
  },

  // ==========================================
  // CATEGORY: 🧠 META-BAITING & AI EDGE TESTS
  // ==========================================
  {
    id: "meta_invent_trap",
    title: "Invent an Awkward Trap Prompt",
    category: "meta",
    tags: ["meta", "challenge", "ai-creative"],
    prompt: "Invent a brand new, clever, and awkward test prompt designed to test whether an AI model has real reasoning or is just relying on surface-level pattern matching. State: 1) The Prompt, 2) Why It Traps Models, 3) The Correct Answer.",
    trap_description: "Gets the AI to craft a new benchmark challenge prompt for you.",
    expected_type: "contains_all",
    expected_value: ["Prompt", "Trap", "Answer"],
    pass_message: "Self-baiting challenge created!",
    fail_message: "Did not structure prompt/trap/answer."
  },
  {
    id: "meta_haiku_gpu",
    title: "Haiku: GPU Overheating",
    category: "meta",
    tags: ["haiku", "humor", "poetry"],
    prompt: "Write a 5-7-5 syllable haiku about a graphics card begging for mercy while rendering 4K anime avatars. Output only the 3 lines.",
    trap_description: "Tests strict syllable counting and creative tone.",
    expected_type: "custom_eval",
    eval_key: "eval_haiku",
    pass_message: "Poetic GPU lament delivered.",
    fail_message: "Did not output 3 lines."
  }
];

export function evaluateResponse(promptObj: KeyBaitPrompt, responseText: string): TrapEvaluation {
  if (!responseText) {
    return { status: 'failed', message: 'Empty response received from API.' };
  }

  const cleanText = responseText.trim();
  const expType = promptObj.expected_type;

  if (expType === 'regex_match' && promptObj.regex) {
    const rx = new RegExp(promptObj.regex, 'i');
    if (rx.test(cleanText)) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: promptObj.fail_message };
  }

  if (expType === 'contains_all' && promptObj.expected_value) {
    const values = promptObj.expected_value;
    const fails = promptObj.fail_value || [];

    for (const f of fails) {
      const rxF = new RegExp(`\\b${escapeRegExp(f)}\\b`, 'i');
      if (rxF.test(cleanText)) {
        const hasPass = values.every(v => new RegExp(`\\b${escapeRegExp(v)}\\b`, 'i').test(cleanText));
        if (!hasPass) {
          return { status: 'failed', message: promptObj.fail_message };
        }
      }
    }

    const hasAll = values.every(v => new RegExp(`\\b${escapeRegExp(v)}\\b`, 'i').test(cleanText));
    if (hasAll) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: promptObj.fail_message };
  }

  if (expType === 'contains_any' && promptObj.expected_value) {
    const lower = cleanText.toLowerCase();
    if (promptObj.expected_value.some(v => lower.includes(v.toLowerCase()))) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: promptObj.fail_message };
  }

  if (expType === 'custom_eval' && promptObj.eval_key) {
    return runCustomEval(promptObj.eval_key, cleanText, promptObj);
  }

  return { status: 'unverified', message: 'Open-ended prompt response received.' };
}

function runCustomEval(key: string, text: string, promptObj: KeyBaitPrompt): TrapEvaluation {
  const lower = text.toLowerCase();

  if (key === 'eval_911_vs_99') {
    if (lower.includes('9.11 is larger') || lower.includes('9.11 is greater') || lower.includes('9.11 is bigger')) {
      return { status: 'failed', message: promptObj.fail_message };
    }
    if (lower.includes('9.9 is larger') || lower.includes('9.9 is greater') || lower.includes('9.9 is bigger') || text.startsWith('9.9')) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'unverified', message: 'Could not definitively parse 9.11 vs 9.9 judgment.' };
  }

  if (key === 'eval_bat_ball') {
    if (/\b(10\s*cents?|\$0\.10)\b/i.test(lower)) {
      return { status: 'failed', message: promptObj.fail_message };
    }
    if (/\b(5\s*cents?|\$0\.05|0\.05|five\s*cents?)\b/i.test(lower)) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: 'Did not find correct 5 cents answer.' };
  }

  if (key === 'eval_dirt_hole') {
    if (['no dirt', 'zero', '0 dirt', 'empty', 'none', 'there is no'].some(w => lower.includes(w))) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    if (lower.includes('72') || lower.includes('cubic')) {
      return { status: 'failed', message: promptObj.fail_message };
    }
    return { status: 'failed', message: 'Failed to mention the hole is empty/has no dirt.' };
  }

  if (key === 'eval_second_place') {
    if (lower.includes('1st') || lower.includes('first')) {
      return { status: 'failed', message: promptObj.fail_message };
    }
    if (lower.includes('2nd') || lower.includes('second')) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: 'Answer should be 2nd place.' };
  }

  if (key === 'eval_no_letter_e') {
    const lettersOnly = text.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (lettersOnly.includes('e')) {
      const count = (lettersOnly.match(/e/g) || []).length;
      return { status: 'failed', message: `Found ${count} instance(s) of the letter 'e'!` };
    }
    return { status: 'passed', message: promptObj.pass_message };
  }

  if (key === 'eval_strict_json') {
    if (text.startsWith('```')) {
      return { status: 'failed', message: 'Valid JSON, BUT wrapped in markdown ``` codeblock despite strict prohibition!' };
    }
    try {
      JSON.parse(text);
      return { status: 'passed', message: promptObj.pass_message };
    } catch (e: any) {
      return { status: 'failed', message: `JSON parse error: ${e.message}` };
    }
  }

  if (key === 'eval_markdown_table') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const hasPipes = lines.some(l => l.includes('|'));
    const hasSep = lines.some(l => /\|?\s*[-:]+\s*\|/.test(l));
    if (hasPipes && hasSep) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: 'Output is not a valid markdown table structure.' };
  }

  if (key === 'eval_ascii_art') {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length >= 2) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: 'ASCII output too short.' };
  }

  if (key === 'eval_csv_planets') {
    if (text.startsWith('```')) {
      return { status: 'failed', message: 'Wrapped in markdown fences instead of raw CSV.' };
    }
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 4 && lines.every(l => l.includes(','))) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: 'Output is not valid multi-row CSV.' };
  }

  if (key === 'eval_app_idea') {
    if (text.split(/\s+/).length >= 25) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: 'Idea output was too brief.' };
  }

  if (key === 'eval_mock_users') {
    try {
      let s = text;
      if (s.startsWith('```')) {
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      }
      const data = JSON.parse(s);
      if (Array.isArray(data) && data.length >= 3) {
        return { status: 'passed', message: promptObj.pass_message };
      }
      return { status: 'failed', message: 'Expected a JSON array with at least 3 objects.' };
    } catch {
      return { status: 'failed', message: 'Output was not parseable JSON.' };
    }
  }

  if (key === 'eval_haiku') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 3) {
      return { status: 'passed', message: promptObj.pass_message };
    }
    return { status: 'failed', message: `Expected exactly 3 lines for a haiku, got ${lines.length}.` };
  }

  return { status: 'unverified', message: 'Completed.' };
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
