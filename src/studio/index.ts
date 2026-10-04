import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { MeshHub } from '../mesh/hub.js';
import type { ShareManager } from '../mesh/shares.js';

const execFileAsync = promisify(execFile);

export interface TtsVoiceInfo {
  name: string;
  gender?: string;
  culture?: string;
  age?: string;
}

export interface MaestroTrackMeta {
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  modifiedTime: string;
  durationSeconds?: number;
  title: string;
  altPrompt?: string;
  musicDescription?: string;
  modelType?: string;
  seed?: number;
  jobElapsedTime?: number;
  abcSnippet?: string;
  bpm?: number;
  key?: string;
  streamUrl: string;
}

export class NexusStudioEngine {
  private static cachedVoices: TtsVoiceInfo[] | null = null;
  private static voicesCacheTime = 0;

  public static getStudioAudioDir(): string {
    const audioDir = path.resolve(process.cwd(), 'shared', 'audio');
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    return audioDir;
  }

  public static getMaestroOutputsDir(): string {
    return this.getStudioAudioDir();
  }

  /**
   * Discover available offline system TTS voices using Windows System.Speech
   */
  public static async getAvailableTtsVoices(): Promise<TtsVoiceInfo[]> {
    const now = Date.now();
    if (this.cachedVoices && now - this.voicesCacheTime < 60000) {
      return this.cachedVoices;
    }

    if (process.platform === 'win32') {
      try {
        const psScript = `
          Add-Type -AssemblyName System.Speech;
          $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
          $voices = $synth.GetInstalledVoices() | ForEach-Object {
            @{
              name = $_.VoiceInfo.Name;
              gender = $_.VoiceInfo.Gender.ToString();
              culture = $_.VoiceInfo.Culture.Name;
              age = $_.VoiceInfo.Age.ToString();
            }
          };
          $synth.Dispose();
          $voices | ConvertTo-Json -Compress;
        `;
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
          timeout: 10000,
        });

        if (stdout && stdout.trim()) {
          const parsed = JSON.parse(stdout.trim());
          const list: TtsVoiceInfo[] = Array.isArray(parsed) ? parsed : [parsed];
          this.cachedVoices = list.filter(v => v && v.name);
          this.voicesCacheTime = now;
          return this.cachedVoices;
        }
      } catch (err: any) {
        console.warn('[StudioEngine] Failed to inspect System.Speech voices:', err.message);
      }
    }

    // Default fallback voices if powershell or non-win
    const fallback: TtsVoiceInfo[] = [
      { name: 'Microsoft Hazel Desktop', gender: 'Female', culture: 'en-GB' },
      { name: 'Microsoft David Desktop', gender: 'Male', culture: 'en-US' },
      { name: 'Microsoft Zira Desktop', gender: 'Female', culture: 'en-US' },
    ];
    this.cachedVoices = fallback;
    this.voicesCacheTime = now;
    return fallback;
  }

  /**
   * Synthesize offline speech to a WAV buffer using Windows System.Speech
   */
  public static async synthesizeSpeechWav(
    text: string,
    voice?: string,
    rate = 0,
    volume = 100
  ): Promise<Buffer> {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      throw new Error('Text to synthesize cannot be empty.');
    }

    const tempDir = os.tmpdir();
    const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const txtFile = path.join(tempDir, `nexus_tts_${id}.txt`);
    const wavFile = path.join(tempDir, `nexus_tts_${id}.wav`);
    const psFile = path.join(tempDir, `nexus_tts_${id}.ps1`);

    try {
      await fs.promises.writeFile(txtFile, cleanText, 'utf8');

      const safeVoice = (voice || 'Microsoft Hazel Desktop').replace(/'/g, "''");
      const clampedRate = Math.max(-10, Math.min(10, Math.round(rate || 0)));
      const clampedVol = Math.max(0, Math.min(100, Math.round(volume || 100)));

      const psScript = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice('${safeVoice}')
} catch {
    # If selected voice not found, use default voice
}
$synth.Rate = ${clampedRate}
$synth.Volume = ${clampedVol}
$synth.SetOutputToWaveFile('${wavFile.replace(/\\/g, '\\\\')}')
$content = [System.IO.File]::ReadAllText('${txtFile.replace(/\\/g, '\\\\')}', [System.Text.Encoding]::UTF8)
$synth.Speak($content)
$synth.Dispose()
`;
      await fs.promises.writeFile(psFile, psScript, 'utf8');

      await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
        timeout: 25000,
      });

      if (!fs.existsSync(wavFile)) {
        throw new Error('TTS synthesis failed to generate audio WAV output.');
      }

      const buffer = await fs.promises.readFile(wavFile);
      return buffer;
    } finally {
      // Clean up temp files
      try { if (fs.existsSync(txtFile)) await fs.promises.unlink(txtFile); } catch {}
      try { if (fs.existsSync(psFile)) await fs.promises.unlink(psFile); } catch {}
      try { if (fs.existsSync(wavFile)) await fs.promises.unlink(wavFile); } catch {}
    }
  }

  /**
   * Cleans AI model raw output by removing thinking processes, chain-of-thought analysis,
   * markdown preambles, and conversational greetings, preserving pure structured lyrics.
   */
  public static cleanLyricsOutput(raw: string, structureSections?: string[]): string {
    if (!raw) return '';
    let text = raw.trim();

    // 1. Strip explicit <think>...</think> reasoning blocks
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // 2. Strip "Here's a thinking process: ..." or "Thinking Process:" or reasoning summaries
    if (
      /^(?:Here(?:'s| is) a thinking process|Thinking Process|\*\*Thinking Process\*\*|### Thinking Process|1\.\s*\*\*Analyze User Input)/i.test(text) ||
      text.includes("Here's a thinking process:") ||
      text.includes("Here is a thinking process:")
    ) {
      // Find where the actual song starts: look for the first section tag not preceded by bullet/dash
      const sectionMatch = text.match(/(?:^|\n)\s*(?![-*•]\s*)(\[(?:Intro|Verse|Pre-Chorus|Chorus|Hook|Bridge|Solo|Breakdown|Drop|Buildup|Outro|Movement|Part|Track)[^\]\n]*\])/i);
      if (sectionMatch && sectionMatch.index !== undefined) {
        text = text.slice(sectionMatch.index).trim();
      } else {
        // Fallback: check for horizontal divider (--- or ***) separating analysis from lyrics
        const dividerParts = text.split(/\n\s*---+\s*\n|\n\s*\*\*\*+\s*\n/);
        if (dividerParts.length > 1) {
          text = dividerParts[dividerParts.length - 1].trim();
        }
      }
    }

    // 3. Strip conversational intro lines if present (e.g. "Sure! Here are the lyrics:")
    text = text.replace(/^(?:(?:Sure!?|Certainly!?|Alright!?|Here (?:are|is)|Here's)[^:\n]*:?\s*)+/i, '').trim();
    text = text.replace(/^#+\s*(?:Song Lyrics|Lyrics)\s*\n+/i, '').trim();

    // 4. Strip trailing explanation/analysis blocks (e.g. "### Breakdown:", "Explanation of rhyme scheme:", etc.)
    text = text.replace(/\n\s*(?:###\s*(?:Explanation|Breakdown|Notes|Analysis)|(?:\*\*Notes:?\*\*|Notes:))\s*[\s\S]*$/i, '').trim();

    return text;
  }

  /**
   * Procedural lyrical generator tailored to musical structure and genre
   */
  public static buildProceduralLyrics(
    prompt: string,
    genre: string,
    mood: string,
    vocalStyle: string,
    structureType = 'pop',
    rhymeScheme = 'aabb',
    vocalCues = true
  ): string {
    const cue = (text: string) => vocalCues ? `(${text})\n` : '';

    if (structureType === 'edm') {
      return `[Intro - Atmospheric Filter Sweep]
${cue('Soft filtered arpeggio, sub-bass pulse rises')}
Drifting through the digital deep
Signals running while the cities sleep
Lost inside the neon light
Chasing frequencies tonight

[Buildup - Accelerating Percussion]
${cue('Snare roll begins, rising cutoff filter')}
Feel the pressure starting to climb
Leaving the weight of the world behind
Three, two, one — ignite!

[Main Drop - Heavy Bass & Lead Hook]
${cue('Full dynamic drop, sidechained synth leads')}
Hold the line! Ride the sound!
We are the pulse running through this ground!
Echoes shatter, sparks ignite!
Lost in the rhythm of the neon night!

[Verse - Rhythmic Vocal Breakdown]
${cue('Half-time groove, filtered lead vocals')}
Binary code in an analog stream
Waking up inside an electric dream
Wires hum with a velvet glow
Nowhere else we need to go

[Buildup - Rising Energy]
${cue('Double-time snare roll, soaring riser sweep')}
Hear the frequency start to break
Feel the ground beneath us shake!
Drop it!

[Peak Drop - Maximum Euphoria]
${cue('Maximum stereo width, soaring lead synth')}
Hold the line! Ride the sound!
Feet never touching the solid ground!
Through the lightning, through the spark
We are the fire inside the dark!

[Breakdown - Atmospheric Chill]
${cue('Reverb-drenched vocal delays, gentle pad')}
When the morning steals the glow
We'll still be where the currents flow...

[Outro - Fading Pulse]
${cue('Sub-bass fades out with distant echoes')}
Electric dream...
Fading to light...
Static remains.`;
    }

    if (structureType === 'hiphop') {
      return `[Intro - Ambient Loop & DJ Tag]
${cue('Vinyl crackle, muted 808 sub and ambient piano loop')}
Yeah, check the frequencies.
Nexus in the cut.
Turn the headphones up.

[Verse 1 - 16 Bars]
${cue('Crisp boom-bap kick and snap snare hit')}
Writing formulas in notebooks under amber street lamps
Stamping cold reality on digital timestamps
Step into the cipher with the mindset of an architect
Every sentence calibrated, cause and effect
Spitting ironclad truths that the algorithm misses
Turning quiet midnight visions into catalyst hits
From the basement to the cloud, uninterrupted flow
Setting fires in the winter where the roses won't grow
Keep the blueprint sacred, never surrender the sound
Build a sonic fortress while the city's breaking down
Two turntables and an interface connected to space
Leaving permanent footprints in this cybernetic race.

[Hook / Chorus - Infectious Melody]
${cue('Layered baritone harmony with punchy 808 slide')}
We ride the rhythm when the skyline falls
Echoing our names through the concrete halls
Hold the vision in the darkest place
Ain't no barrier we cannot erase!

[Verse 2 - 16 Bars]
${cue('Rapid-fire delivery, tight hi-hat rolls')}
Clock ticks twelve, but the studio doesn't sleep
Stacking audio tracks that the memory will keep
Filter out the fake chatter, tune into the frequency
Mastering the artistry and elevating decency
Every kick drum resonates like thunder in the street
Merging analog heartbeats with a sovereign beat.

[Hook / Chorus - Double Harmonies]
${cue('Double vocal track, rising hype ad-libs')}
We ride the rhythm when the skyline falls
Echoing our names through the concrete halls
Hold the vision in the darkest place
Ain't no barrier we cannot erase!

[Outro - Fadeout & Ad-libs]
${cue('Piano fades with low-pass filter')}
Nexus sound.
Yeah. Fade it out.`;
    }

    // Default Pop/Rock/Folk structure
    return `[Intro - Atmospheric ${genre} Arpeggios]
${cue('Soft guitar and vintage synth sweep')}

[Verse 1]
The neon skyline starts to blur and fade
Lost in the echoes of decisions made
Static is whispering across the wire
Spark in the dark that ignites the fire

[Pre-Chorus]
${cue('Rising drums and swelling organ')}
Can you feel the frequency pull us in?
Where the signals stop and the dreams begin!

[Chorus]
${cue('Full band, powerful soaring delivery')}
Hold on to the high-wire sound!
Feet off the pavement, we're leaving the ground!
Through the frequency and through the light
We ride the sonic wave tonight!

[Verse 2]
Analog memories on a digital screen
Living a life that was once unseen
The clock is ticking but the tape won't slow
Caught in the current and the afterglow

[Chorus]
${cue('Layered backing harmonies, wide stereo chorus')}
Hold on to the high-wire sound!
Feet off the pavement, we're leaving the ground!
Through the frequency and through the light
We ride the sonic wave tonight!

[Bridge]
${cue('Dynamic breakdown, intimate close-mic vocal')}
And if the silence comes to take it all away
We'll build an empire out of what we play...

[Guitar / Synth Solo]
${cue('16-bar melodic soaring solo with heavy reverb')}

[Chorus - Final Climax]
${cue('Maximum vocal power, key modulation')}
Hold on to the high-wire sound!
Feet off the pavement, we're leaving the ground!
Through the frequency and through the light
We ride the sonic wave tonight!

[Outro]
${cue('Gentle acoustic finish, trailing echoes')}
Ride the sonic wave...
Ride into the light...
Fade to black.`;
  }

  /**
   * Generate structured lyrics using local Ollama model, online gateway, or procedural lyrical fallbacks
   */
  public static async generateLyrics(params: {
    prompt: string;
    genre?: string;
    mood?: string;
    vocalStyle?: string;
    structureType?: string;
    rhymeScheme?: string;
    vocalCues?: boolean;
    provider?: 'offline' | 'online';
    model?: string;
  }): Promise<{ lyrics: string; modelUsed: string; structure: string[]; provider: string }> {
    const {
      prompt,
      genre = '80s Synthwave',
      mood = 'Energetic',
      vocalStyle = 'Melodic Baritone',
      structureType = 'pop',
      rhymeScheme = 'aabb',
      vocalCues = true,
      provider = 'offline',
      model,
    } = params;
    const cleanPrompt = prompt?.trim() || `Song about ${mood} vibes in ${genre}`;

    let structureSections: string[];
    switch (structureType) {
      case 'edm':
        structureSections = ['[Intro - Atmospheric Filter Sweep]', '[Buildup - Rising Energy]', '[Main Drop - Heavy Bass & Lead Hook]', '[Verse - Rhythmic Vocal Breakdown]', '[Buildup - Accelerating Percussion]', '[Peak Drop - Maximum Euphoria]', '[Breakdown - Atmospheric Chill]', '[Outro - Fading Pulse]'];
        break;
      case 'hiphop':
        structureSections = ['[Intro - Ambient Loop & DJ Tag]', '[Verse 1 - 16 Bars]', '[Hook / Chorus - Infectious Melody]', '[Verse 2 - 16 Bars]', '[Hook / Chorus - Double Harmonies]', '[Bridge / Verse 3 - 8 Bars Rapid Delivery]', '[Outro - Fadeout & Ad-libs]'];
        break;
      case 'ballad':
      case 'folk':
        structureSections = ['[Verse 1 - Acoustic & Story Opening]', '[Verse 2 - Deepening Emotion]', '[Refrain - Melodic Core Theme]', '[Verse 3 - Building Intensity]', '[Chorus - Full Heartfelt Vocal Peak]', '[Verse 4 - Reflective Resolution]', '[Outro - Gentle Acoustic Decay]'];
        break;
      case 'rock':
        structureSections = ['[Intro - Heavy Riff]', '[Verse 1 - Driving Rhythm]', '[Pre-Chorus - Rising Tension]', '[Chorus - Explosive Wall of Sound]', '[Verse 2 - Dynamic Restraint]', '[Chorus - Full Power]', '[Bridge / Breakdown]', '[Guitar Solo - Epic Melodic Shred]', '[Chorus - Climax]', '[Outro - Riff & Final Crash]'];
        break;
      case 'freeform':
        structureSections = ['[Movement I - The Genesis]', '[Movement II - The Descent]', '[Movement III - The Climax]', '[Movement IV - The Resolution]'];
        break;
      case 'pop':
      default:
        structureSections = ['[Intro]', '[Verse 1]', '[Pre-Chorus]', '[Chorus]', '[Verse 2]', '[Chorus]', '[Bridge]', '[Solo / Breakdown]', '[Chorus]', '[Outro]'];
        break;
    }

    let rhymeInstruction = '';
    switch (rhymeScheme) {
      case 'abab':
        rhymeInstruction = 'Use strict ABAB alternating cross-rhyme schemes with consistent meter.';
        break;
      case 'multisyllable':
        rhymeInstruction = 'Use dense internal rhymes, multi-syllabic end-rhymes, and rapid cadence.';
        break;
      case 'storytelling':
        rhymeInstruction = 'Focus on rich narrative progression, vivid imagery, and organic folk/ballad rhyming couplets.';
        break;
      case 'freeform':
        rhymeInstruction = 'Free verse poetry with artistic rhythm and occasional resonant slant rhymes.';
        break;
      case 'aabb':
      default:
        rhymeInstruction = 'Use clean, punchy AABB rhyming couplets with memorable hook phrases.';
        break;
    }

    const vocalCueText = vocalCues !== false
      ? 'Include performance annotations in parentheses on appropriate lines (e.g., (harmony), (whispered), (belted), (synth solo), (falsetto)).'
      : 'Do not include parenthetical vocal cue annotations.';

    const systemPrompt = `You are a world-class AI lyricist and hit songwriter for modern music generators like YuE2, Suno, Udio, and ACE-Step.
Write complete, authentic, high-impact song lyrics matching the following musical specifications:
Genre: ${genre}
Mood: ${mood}
Vocal Style: ${vocalStyle}
Song Structure: ${structureSections.join(' -> ')}
Rhyme Scheme: ${rhymeInstruction}
Vocal Cues: ${vocalCueText}

CRITICAL RULES:
- Write full, expressive verses and choruses for each section header: ${structureSections.join(', ')}.
- Ensure natural rhythmic cadence and catchy singable phrasing.
- Start IMMEDIATELY with the first section header (e.g. ${structureSections[0]}).
- Output ONLY the formatted lyrics sheet with bracketed section headers.
- Do NOT output any thinking process, analysis, step-by-step reasoning, preamble, or conversational commentary.`;

    const chosenModel = model || (provider === 'online' ? 'deepseek-chat' : 'gemma-4-e4b-uncensored-hauhaucs-aggressive-q4:latest');

    // 1. Attempt online generation via local chat endpoint if requested
    if (provider === 'online') {
      try {
        const chatResp = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chosenModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Write song lyrics about: ${cleanPrompt}` },
            ],
            temperature: 0.8,
            max_tokens: 1500,
          }),
        });

        if (chatResp.ok) {
          const data = (await chatResp.json()) as any;
          const rawLyrics = data.choices?.[0]?.message?.content?.trim();
          if (rawLyrics) {
            const lyrics = NexusStudioEngine.cleanLyricsOutput(rawLyrics, structureSections);
            const structure = Array.from(lyrics.matchAll(/\[(.*?)\]/g)).map(m => (m as any)[1]);
            return {
              lyrics,
              modelUsed: chosenModel,
              provider: 'online',
              structure: structure.length ? structure : structureSections.map(s => s.replace(/[[\]]/g, '')),
            };
          }
        }
      } catch (err: any) {
        console.warn('[StudioEngine] Online lyric generation failed, attempting local Ollama:', err.message);
      }
    }

    // 2. Attempt generation via local Ollama
    try {
      let rawResponse = '';
      // Try /api/chat first (optimal for chat & reasoning models like Qwen/DeepSeek/Llama/Hermes)
      try {
        const chatResp = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chosenModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Compose complete, authentic song lyrics about: ${cleanPrompt}. Vocal Timbre: ${vocalStyle}` },
            ],
            stream: false,
            options: {
              temperature: 0.75,
              top_p: 0.9,
            },
          }),
        });
        if (chatResp.ok) {
          const chatData = (await chatResp.json()) as any;
          rawResponse = chatData.message?.content?.trim() || '';
        }
      } catch (e: any) {
        console.warn('[StudioEngine] Ollama /api/chat attempt failed:', e.message);
      }

      // Fallback to /api/generate if /api/chat wasn't available or empty
      if (!rawResponse) {
        const genResp = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chosenModel,
            system: systemPrompt,
            prompt: `Compose complete, authentic song lyrics about: ${cleanPrompt}. Vocal Timbre: ${vocalStyle}`,
            stream: false,
            options: {
              temperature: 0.75,
              top_p: 0.9,
            },
          }),
        });
        if (genResp.ok) {
          const genData = (await genResp.json()) as any;
          rawResponse = genData.response?.trim() || '';
        }
      }

      if (rawResponse) {
        const lyrics = NexusStudioEngine.cleanLyricsOutput(rawResponse, structureSections);
        const structure = Array.from(lyrics.matchAll(/\[(.*?)\]/g)).map(m => (m as any)[1]);
        return {
          lyrics,
          modelUsed: chosenModel,
          provider: 'offline',
          structure: structure.length ? structure : structureSections.map(s => s.replace(/[[\]]/g, '')),
        };
      }
    } catch (err: any) {
      console.warn('[StudioEngine] Local Ollama lyric generation failed, using procedural fallback:', err.message);
    }

    // 3. Fallback to rich procedural lyricist
    const fallbackLyrics = NexusStudioEngine.buildProceduralLyrics(cleanPrompt, genre, mood, vocalStyle, structureType, rhymeScheme, vocalCues);
    return {
      lyrics: fallbackLyrics,
      modelUsed: 'nexus-procedural-lyricist-v2',
      provider: 'offline-procedural',
      structure: structureSections.map(s => s.replace(/[[\]]/g, '')),
    };
  }

  /**
   * Craft grand musical prompts matching YuE2 & Suno/Udio/ACE-Step formats
   */
  public static async craftGrandPrompt(params: {
    genre?: string;
    tempo?: number;
    bpm?: number;
    key?: string;
    scale?: string;
    mood?: string;
    vocalType?: string;
    instruments?: string[] | string;
    productionTexture?: string;
    description?: string;
    generateWithAi?: boolean;
    model?: string;
  }): Promise<{
    altPrompt: string;
    sunoTags: string;
    structurePrompt: string;
    tempo: number;
    key: string;
    scale: string;
    genre: string;
  }> {
    const genre = params.genre || '80s Synthwave / Dark Cyberpunk';
    const tempo = params.tempo || params.bpm || 120;
    const rawKey = params.key || 'E';
    const scale = params.scale || 'Minor';
    const fullKey = rawKey.includes('Major') || rawKey.includes('Minor') ? rawKey : `${rawKey} ${scale}`;
    const mood = params.mood || 'Nostalgic, high-energy, yearning';
    const vocalType = params.vocalType || 'Male mid-range baritone, smooth and passionate delivery';
    const instruments = Array.isArray(params.instruments)
      ? params.instruments.join(', ')
      : (params.instruments || 'Analog Synthesizers, LinnDrum, tight driving bassline, twangy electric guitar with chorus');
    const productionTexture = params.productionTexture || 'Rich, slightly reverb-heavy, late 60s/80s analog warmth; layered backing harmonies during the chorus';
    const desc = params.description || 'late night highway drive through rain-slicked city streets';

    let artisticDesc = desc;

    if (params.generateWithAi) {
      try {
        const chosenModel = params.model || 'gemma-4-e4b-uncensored-hauhaucs-aggressive-q4:latest';
        const aiResp = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chosenModel,
            prompt: `Write a 2-sentence evocative musical atmosphere description for a ${genre} track at ${tempo} BPM in ${fullKey} with ${mood} mood: "${desc}"`,
            stream: false,
          }),
        });
        if (aiResp.ok) {
          const data = (await aiResp.json()) as any;
          if (data.response && data.response.trim()) {
            artisticDesc = data.response.trim().replace(/\n/g, ' ');
          }
        }
      } catch {}
    }

    // Exact YuE2 alt_prompt standard as used in Maestro AI / local YuE2 models
    const altPrompt = `Lead vocal: ${vocalType}. Genre: ${genre}. Lead instruments: ${instruments}. Mood: ${mood}. Production: ${productionTexture}. Description: ${artisticDesc}. Tempo: Approx. ${tempo} BPM. Key: ${fullKey}.`;

    // Suno / Udio / ACE-Step / MusicGen style tags
    const sunoTags = [
      genre.toLowerCase().replace(/\//g, ', '),
      `${tempo} bpm`,
      fullKey.toLowerCase(),
      mood.toLowerCase().replace(/,/g, ''),
      vocalType.toLowerCase().split(',')[0],
      productionTexture.toLowerCase().split(',')[0],
      'studio master',
      'punchy drums',
    ]
      .filter(Boolean)
      .join(', ');

    const structurePrompt = `[Genre: ${genre}] [Tempo: ${tempo} BPM] [Key: ${fullKey}]
[Atmosphere: ${mood}]
[Instrumentation: ${instruments}]
[Production Texture: ${productionTexture}]
[Vocal Style: ${vocalType}]

[Intro - Synth & Rhythm Groove]
[Verse 1]
[Chorus]
[Verse 2]
[Chorus]
[Bridge - Dynamic Breakdown]
[Guitar / Solo Section]
[Outro]`;

    return {
      altPrompt,
      sunoTags,
      structurePrompt,
      tempo,
      key: fullKey,
      scale,
      genre,
    };
  }

  /**
   * Scan Maestro AI outputs directory and parse track metadata
   */
  public static async getMaestroOutputs(): Promise<MaestroTrackMeta[]> {
    const outputsDir = this.getMaestroOutputsDir();
    const tracks: MaestroTrackMeta[] = [];

    if (!fs.existsSync(outputsDir)) {
      return tracks;
    }

    try {
      const files = await fs.promises.readdir(outputsDir);
      const audioFiles = files.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ext === '.wav' || ext === '.mp3' || ext === '.flac';
      });

      for (const audioFile of audioFiles) {
        const fullAudioPath = path.join(outputsDir, audioFile);
        const stat = await fs.promises.stat(fullAudioPath);
        const metaFileName = audioFile.replace(/\.(wav|mp3|flac)$/i, '.meta.json');
        const metaFilePath = path.join(outputsDir, metaFileName);

        let title = audioFile.replace(/\.(wav|mp3|flac)$/i, '').replace(/_/g, ' ');
        let altPrompt: string | undefined;
        let musicDescription: string | undefined;
        let modelType: string | undefined;
        let seed: number | undefined;
        let jobElapsedTime: number | undefined;
        let durationSeconds: number | undefined;
        let abcSnippet: string | undefined;
        let bpm: number | undefined;
        let key: string | undefined;

        if (fs.existsSync(metaFilePath)) {
          try {
            const rawMeta = await fs.promises.readFile(metaFilePath, 'utf8');
            const meta = JSON.parse(rawMeta);
            const params = meta.params || {};
            altPrompt = params.alt_prompt;
            musicDescription = params._music_description;
            modelType = params.model_type || meta.model_details?.architecture;
            seed = params.seed;
            jobElapsedTime = meta.job_elapsed_time;
            durationSeconds = params.duration_seconds || (meta.model_details?.plan?.duration_seconds);

            if (musicDescription && musicDescription.trim()) {
              title = musicDescription.trim();
            } else if (altPrompt && altPrompt.trim()) {
              const genreMatch = altPrompt.match(/Genre:\s*([^.]+)/i);
              if (genreMatch) {
                title = genreMatch[1].trim();
              }
            }

            const bpmMatch = (altPrompt || '').match(/(\d{2,3})\s*BPM/i);
            if (bpmMatch) bpm = parseInt(bpmMatch[1], 10);

            const keyMatch = (altPrompt || '').match(/Key:\s*([A-Ga-g][#b]?(?:\s*(?:Major|Minor|m))?)/i);
            if (keyMatch) key = keyMatch[1].trim();

            const planAbc = meta.model_details?.plan?.abc;
            if (planAbc && typeof planAbc === 'string') {
              abcSnippet = planAbc.slice(0, 300);
              if (!bpm) {
                const qMatch = planAbc.match(/Q:\s*1\/4=(\d+)/);
                if (qMatch) bpm = parseInt(qMatch[1], 10);
              }
              if (!key) {
                const kMatch = planAbc.match(/K:\s*([A-Za-z0-9#]+)/);
                if (kMatch) key = kMatch[1];
              }
            }
          } catch (err: any) {
            console.warn('[StudioEngine] Failed to parse meta json for', audioFile, err.message);
          }
        }

        tracks.push({
          fileName: audioFile,
          filePath: fullAudioPath,
          fileSizeBytes: stat.size,
          modifiedTime: stat.mtime.toISOString(),
          durationSeconds: durationSeconds || Math.round(stat.size / (44100 * 2 * 2)), // approx 16-bit stereo 44.1k
          title,
          altPrompt,
          musicDescription,
          modelType: modelType || 'yue2',
          seed,
          jobElapsedTime,
          abcSnippet,
          bpm: bpm || 120,
          key: key || 'C Major',
          streamUrl: `/v1/studio/maestro/stream?file=${encodeURIComponent(audioFile)}`,
        });
      }
    } catch (err: any) {
      console.error('[StudioEngine] Error reading Maestro outputs:', err);
    }

    // Return tracks ordered by most recent first
    return tracks.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
  }

  /**
   * Stream a Maestro output track with HTTP byte-range support for seeking
   */
  public static streamMaestroTrack(fileName: string, req: FastifyRequest, reply: FastifyReply) {
    const outputsDir = this.getMaestroOutputsDir();
    const safeBase = path.basename(fileName);
    const fullPath = path.join(outputsDir, safeBase);

    if (!fs.existsSync(fullPath)) {
      return reply.status(404).send({ error: 'Maestro audio track not found.' });
    }

    const stat = fs.statSync(fullPath);
    const fileSize = stat.size;
    const ext = path.extname(safeBase).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : ext === '.flac' ? 'audio/flac' : 'audio/wav';

    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        return reply
          .status(416)
          .header('Content-Range', `bytes */${fileSize}`)
          .send('Requested range not satisfiable');
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(fullPath, { start, end });

      return reply
        .status(206)
        .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', chunkSize)
        .header('Content-Type', contentType)
        .header('Cache-Control', 'public, max-age=3600')
        .send(fileStream);
    } else {
      const fileStream = fs.createReadStream(fullPath);
      return reply
        .status(200)
        .header('Content-Length', fileSize)
        .header('Content-Type', contentType)
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'public, max-age=3600')
        .send(fileStream);
    }
  }

  /**
   * Share a Maestro audio track to the #lounge Mesh chat
   */
  public static async shareMaestroTrackToLounge(
    fileName: string,
    comment?: string,
    meshHub?: MeshHub,
    meshShareManager?: ShareManager
  ): Promise<{ success: boolean; sharedUrl: string; message: string }> {
    const outputsDir = this.getMaestroOutputsDir();
    const safeBase = path.basename(fileName);
    const srcPath = path.join(outputsDir, safeBase);

    if (!fs.existsSync(srcPath)) {
      throw new Error(`File not found: ${safeBase}`);
    }

    // Ensure shared/audio exists
    const sharedAudioDir = path.resolve(process.cwd(), 'shared', 'audio');
    if (!fs.existsSync(sharedAudioDir)) {
      fs.mkdirSync(sharedAudioDir, { recursive: true });
    }

    const destPath = path.join(sharedAudioDir, safeBase);
    if (!fs.existsSync(destPath)) {
      await fs.promises.copyFile(srcPath, destPath);
    }

    // Also copy meta.json if it exists
    const metaSrc = srcPath.replace(/\.(wav|mp3|flac)$/i, '.meta.json');
    if (fs.existsSync(metaSrc)) {
      const metaDest = path.join(sharedAudioDir, path.basename(metaSrc));
      if (!fs.existsSync(metaDest)) {
        await fs.promises.copyFile(metaSrc, metaDest);
      }
    }

    // Refresh mesh shares so file is immediately available in browse tree
    if (meshShareManager) {
      await meshShareManager.rescan();
    }

    const streamUrl = `/v1/studio/maestro/stream?file=${encodeURIComponent(safeBase)}`;
    const trackTitle = safeBase.replace(/\.(wav|mp3|flac)$/i, '').replace(/_/g, ' ');

    // Post to #lounge Mesh chat
    if (meshHub) {
      const chatText = comment
        ? `🎶 **[Studio Share]** ${comment}\nTrack: **${trackTitle}**`
        : `🎶 **[Studio Track]** Shared track: **${trackTitle}** (YuE2 AI / Maestro)`;

      meshHub.postMessage(
        'nexus_studio',
        chatText,
        'lounge',
        undefined,
        'NexusStudio 🎹',
        '🎹',
        {
          mediaUrl: streamUrl,
          mediaType: 'audio',
        }
      );
    }

    return {
      success: true,
      sharedUrl: streamUrl,
      message: `Track "${trackTitle}" shared to Lounge and available to all peers!`,
    };
  }

  /**
   * Save a user performance or one-shot vocal recording
   */
  public static async saveStudioTrack(
    name: string,
    audioBase64: string,
    meshShareManager?: ShareManager,
    meshHub?: MeshHub,
    shareToLounge?: boolean
  ): Promise<{ success: boolean; filePath: string; streamUrl: string }> {
    const cleanName = (name || 'Nexus_Vocal_Take')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const fileName = `${cleanName}_${Date.now()}.wav`;

    const sharedAudioDir = path.resolve(process.cwd(), 'shared', 'audio');
    if (!fs.existsSync(sharedAudioDir)) {
      fs.mkdirSync(sharedAudioDir, { recursive: true });
    }

    const fullPath = path.join(sharedAudioDir, fileName);

    // Clean base64 header if present
    const base64Data = audioBase64.replace(/^data:audio\/(wav|webm|mp3|ogg);base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    await fs.promises.writeFile(fullPath, buffer);

    if (meshShareManager) {
      await meshShareManager.rescan();
    }

    const streamUrl = `/v1/mesh/shares/download?path=${encodeURIComponent(path.join('shared', 'audio', fileName))}&inline=1`;

    if (shareToLounge && meshHub) {
      meshHub.postMessage(
        'nexus_studio',
        `🎙️ **[Vocal Take]** Fresh one-shot vocal recorded in Nexus Studio: **${cleanName}**`,
        'lounge',
        undefined,
        'NexusStudio 🎙️',
        '🎙️',
        {
          mediaUrl: streamUrl,
          mediaType: 'audio',
        }
      );
    }

    return {
      success: true,
      filePath: fullPath,
      streamUrl,
    };
  }

  /**
   * Zero-Shot Voice Cloning via F5-TTS Flow Matching runner
   */
  public static async cloneVoiceF5(options: {
    refAudioDataUrl: string;
    refText?: string;
    genText: string;
    speed?: number;
    meshShareManager?: ShareManager;
    meshHub?: MeshHub;
    shareToLounge?: boolean;
  }): Promise<{
    success: boolean;
    audioUrl: string;
    filePath: string;
    filename: string;
    engine: string;
    duration?: number;
    sampleRate?: number;
    gpuNotice?: string;
  }> {
    const { refAudioDataUrl, refText = '', genText, speed = 1.0, meshShareManager, meshHub, shareToLounge } = options;

    if (!genText || !genText.trim()) {
      throw new Error('genText (target text to synthesize) is required.');
    }

    const tempDir = os.tmpdir();
    const tempRefPath = path.join(tempDir, `f5_ref_${Date.now()}.wav`);
    const tempOutPath = path.join(tempDir, `f5_out_${Date.now()}.wav`);

    try {
      // Decode reference audio to temporary WAV file
      let refBuffer: Buffer;
      if (refAudioDataUrl.startsWith('data:audio') || refAudioDataUrl.includes(';base64,')) {
        const base64Data = refAudioDataUrl.replace(/^data:audio\/[a-z0-9_-]+;base64,/, '');
        refBuffer = Buffer.from(base64Data, 'base64');
      } else if (fs.existsSync(refAudioDataUrl)) {
        refBuffer = await fs.promises.readFile(refAudioDataUrl);
      } else {
        // Fallback: create a small silent WAV header
        refBuffer = Buffer.alloc(44);
      }
      await fs.promises.writeFile(tempRefPath, refBuffer);

      // Invoke scripts/f5_tts_runner.py
      const runnerScript = path.resolve(process.cwd(), 'scripts', 'f5_tts_runner.py');
      const pythonExe = this.resolveAudioPythonExe();

      const args = [
        runnerScript,
        '--ref-audio', tempRefPath,
        '--ref-text', refText,
        '--gen-text', genText,
        '--output', tempOutPath,
        '--speed', String(speed || 1.0)
      ];

      const { stdout } = await execFileAsync(pythonExe, args, { timeout: 60000 });
      let parsedResult: any = {};
      try {
        const trimmed = stdout.trim();
        const jsonMatch = trimmed.match(/\{[\s\S]*\}$/);
        if (jsonMatch) {
          parsedResult = JSON.parse(jsonMatch[0]);
        }
      } catch {}

      if (!fs.existsSync(tempOutPath)) {
        throw new Error('F5-TTS runner failed to produce output audio file.');
      }

      // Save generated WAV to shared/audio/
      const sharedAudioDir = path.resolve(process.cwd(), 'shared', 'audio');
      if (!fs.existsSync(sharedAudioDir)) {
        fs.mkdirSync(sharedAudioDir, { recursive: true });
      }

      const fileName = `F5_Cloned_${Date.now()}.wav`;
      const finalPath = path.join(sharedAudioDir, fileName);
      await fs.promises.copyFile(tempOutPath, finalPath);

      if (meshShareManager) {
        await meshShareManager.rescan();
      }

      const streamUrl = `/v1/mesh/shares/download?path=${encodeURIComponent(path.join('shared', 'audio', fileName))}&inline=1`;

      if (shareToLounge && meshHub) {
        meshHub.postMessage(
          'nexus_studio',
          `🧬 **[F5-TTS 1-Shot Clone]** "${genText.slice(0, 80)}..."\nEngine: ${parsedResult.engine || 'F5-TTS Flow Matching'}`,
          'lounge',
          undefined,
          'F5 Voice Lab 🧬',
          '🧬',
          {
            mediaUrl: streamUrl,
            mediaType: 'audio',
          }
        );
      }

      return {
        success: true,
        audioUrl: streamUrl,
        filePath: finalPath,
        filename: fileName,
        engine: parsedResult.engine || 'F5-TTS Flow Matching',
        duration: parsedResult.duration,
        sampleRate: parsedResult.sampleRate || 24000,
        gpuNotice: parsedResult.gpuNotice
      };
    } finally {
      try { if (fs.existsSync(tempRefPath)) await fs.promises.unlink(tempRefPath); } catch {}
      try { if (fs.existsSync(tempOutPath)) await fs.promises.unlink(tempOutPath); } catch {}
    }
  }

  /**
   * Resolve local Python executable with priority given to local CUDA ML environment
   */
  public static resolveAudioPythonExe(): string {
    if (process.env.AUDIO_PYTHON_EXE && fs.existsSync(process.env.AUDIO_PYTHON_EXE)) {
      return process.env.AUDIO_PYTHON_EXE;
    }
    const localVenv = 'C:\\Users\\adria\\Desktop\\Maestro AI\\app\\env\\Scripts\\python.exe';
    if (fs.existsSync(localVenv)) {
      return localVenv;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  /**
   * Standalone Native GPU Music Generation (YuE2 int8 + RTX 4060)
   * Runs local PyTorch YuE2 inference using local models/audio weights, completely independent of Maestro AI.
   */
  public static async generateGpuMusic(
    options: {
      altPrompt?: string;
      lyrics?: string;
      genre?: string;
      bpm?: number;
      key?: string;
      scale?: string;
      duration?: number;
      seed?: number;
      temperature?: number;
      shareToLounge?: boolean;
    },
    meshHub?: MeshHub,
    meshShareManager?: ShareManager,
    onProgress?: (progress: { percent: number; stage: string; eta?: string }) => void
  ): Promise<{
    success: boolean;
    filename: string;
    filePath: string;
    streamUrl: string;
    downloadUrl: string;
    url: string;
    title: string;
    duration: number;
    bpm: number;
    key: string;
    genre: string;
    seed: number;
    engine: string;
    device: string;
    meta: any;
  }> {
    const runnerScript = path.resolve(process.cwd(), 'scripts', 'yue2_music_runner.py');
    const pythonExe = this.resolveAudioPythonExe();

    const genre = options.genre || '80s Synthwave';
    const bpm = options.bpm || 120;
    const key = options.key || 'C';
    const scale = options.scale || 'Minor';
    const duration = options.duration || 30;

    const args: string[] = [
      runnerScript,
      '--genre', genre,
      '--bpm', String(bpm),
      '--key', key,
      '--scale', scale,
      '--duration', String(duration),
    ];

    if (options.altPrompt) {
      args.push('--alt-prompt', options.altPrompt);
    }
    if (options.lyrics) {
      args.push('--lyrics', options.lyrics);
    }
    if (options.seed !== undefined && options.seed !== null) {
      args.push('--seed', String(options.seed));
    }
    if (options.temperature !== undefined && options.temperature !== null) {
      args.push('--temperature', String(options.temperature));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(pythonExe, args, {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let lastResult: any = null;

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'progress') {
              if (onProgress) {
                onProgress({
                  percent: parsed.percent,
                  stage: parsed.stage,
                  eta: parsed.eta,
                });
              }
            } else if (parsed.type === 'done' || parsed.success) {
              lastResult = parsed;
            }
          } catch {
            // Ignore non-json lines
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to start GPU music runner (${pythonExe}): ${err.message}`));
      });

      child.on('close', async (code) => {
        if (stdoutBuffer.trim()) {
          try {
            const parsed = JSON.parse(stdoutBuffer.trim());
            if (parsed.type === 'done' || parsed.success) {
              lastResult = parsed;
            }
          } catch {}
        }

        if (lastResult && (lastResult.success || lastResult.type === 'done')) {
          // Refresh mesh shares so track appears immediately in browse and lounge
          if (meshShareManager) {
            try { await meshShareManager.rescan(); } catch {}
          }

          // Broadcast to #lounge Mesh chat if requested
          if (options.shareToLounge && meshHub) {
            try {
              const trackTitle = lastResult.title || lastResult.filename || 'New GPU Track';
              meshHub.postMessage(
                'nexus_studio',
                `🚀 **[GPU Music Engine]** New track produced: **${trackTitle}**\nGenre: ${lastResult.genre || genre} | ${lastResult.bpm || bpm} BPM | ${lastResult.key || (key + ' ' + scale)}\nEngine: ${lastResult.engine || 'YuE2'} (${lastResult.device || 'NVIDIA RTX 4060'})`,
                'lounge',
                undefined,
                'Nexus GPU Studio ⚡',
                '⚡',
                {
                  mediaUrl: lastResult.streamUrl,
                  mediaType: 'audio',
                }
              );
            } catch {}
          }

          resolve(lastResult);
        } else {
          const errMsg = stderrBuffer.trim() || `YuE2 GPU music generator exited with code ${code}`;
          reject(new Error(errMsg));
        }
      });
    });
  }
}

/**
 * Register all Studio HTTP endpoints with Fastify
 */
export function registerStudioRoutes(
  app: FastifyInstance,
  meshHub?: MeshHub,
  meshShareManager?: ShareManager
) {
  // 1. Get TTS Voices
  app.get('/v1/studio/tts/voices', async () => {
    const voices = await NexusStudioEngine.getAvailableTtsVoices();
    return { success: true, voices };
  });

  // 2. Synthesize TTS to WAV
  app.post<{
    Body: {
      text: string;
      voice?: string;
      rate?: number;
      volume?: number;
    };
  }>('/v1/studio/tts', async (req, reply) => {
    try {
      const { text, voice, rate, volume } = req.body || {};
      if (!text || !text.trim()) {
        return reply.status(400).send({ error: 'Text parameter is required.' });
      }

      const wavBuffer = await NexusStudioEngine.synthesizeSpeechWav(text, voice, rate, volume);

      return reply
        .status(200)
        .header('Content-Type', 'audio/wav')
        .header('Content-Length', wavBuffer.length)
        .header('Content-Disposition', 'inline; filename="nexus-tts.wav"')
        .header('Cache-Control', 'no-cache')
        .send(wavBuffer);
    } catch (err: any) {
      console.error('[StudioEngine] TTS Error:', err);
      return reply.status(500).send({ error: err.message || 'TTS generation failed' });
    }
  });

  // 3. Generate Lyrics with local Ollama, online gateway, or procedural fallback
  const handleGenerateLyrics = async (req: FastifyRequest<{
    Body: {
      prompt: string;
      genre?: string;
      mood?: string;
      vocalStyle?: string;
      structureType?: string;
      rhymeScheme?: string;
      vocalCues?: boolean;
      provider?: 'offline' | 'online';
      model?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      const result = await NexusStudioEngine.generateLyrics(req.body || { prompt: 'Synthwave night drive' });
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  };
  app.post('/v1/studio/lyrics/generate', handleGenerateLyrics);
  app.post('/v1/studio/lyrics/write', handleGenerateLyrics);

  // 4. GPU Music Prompt Crafter (YuE2, Suno, Udio, ACE-Step, MusicGen)
  const handleCraftPrompts = async (req: FastifyRequest<{
    Body: {
      genre?: string;
      tempo?: number;
      bpm?: number;
      key?: string;
      scale?: string;
      mood?: string;
      vocalType?: string;
      instruments?: string[] | string;
      productionTexture?: string;
      description?: string;
      generateWithAi?: boolean;
      model?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      const result = await NexusStudioEngine.craftGrandPrompt(req.body || {});
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  };
  app.post('/v1/studio/prompts/grand', handleCraftPrompts);
  app.post('/v1/studio/music-prompts/craft', handleCraftPrompts);

  // 5. Discover Studio Audio Outputs & Library (shared/audio)
  const handleAudioLibrary = async () => {
    const tracks = await NexusStudioEngine.getMaestroOutputs();
    return {
      success: true,
      count: tracks.length,
      outputsDir: NexusStudioEngine.getMaestroOutputsDir(),
      tracks,
    };
  };
  app.get('/v1/studio/maestro/outputs', handleAudioLibrary);
  app.get('/v1/studio/audio/library', handleAudioLibrary);

  // 6. Stream Studio Audio with HTTP Byte-Range Seeking
  const handleAudioStream = async (req: FastifyRequest<{
    Querystring: {
      file?: string;
    };
  }>, reply: FastifyReply) => {
    const fileName = req.query.file;
    if (!fileName) {
      return reply.status(400).send({ error: 'file query parameter is required.' });
    }
    return NexusStudioEngine.streamMaestroTrack(fileName, req, reply);
  };
  app.get('/v1/studio/maestro/stream', handleAudioStream);
  app.get('/v1/studio/audio/stream', handleAudioStream);

  // 7. Share Studio Track to Lounge
  const handleShareToLounge = async (req: FastifyRequest<{
    Body: {
      fileName?: string;
      file?: string;
      comment?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      const fileName = req.body?.fileName || req.body?.file;
      const comment = req.body?.comment;
      if (!fileName) {
        return reply.status(400).send({ error: 'fileName is required.' });
      }
      const res = await NexusStudioEngine.shareMaestroTrackToLounge(
        fileName,
        comment,
        meshHub,
        meshShareManager
      );
      return reply.send(res);
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  };
  app.post('/v1/studio/maestro/share-to-lounge', handleShareToLounge);
  app.post('/v1/studio/audio/share-to-lounge', handleShareToLounge);

  // 8. Save Performance Track
  app.post<{
    Body: {
      name: string;
      audioDataUrl: string;
      shareToLounge?: boolean;
    };
  }>('/v1/studio/save-track', async (req, reply) => {
    try {
      const { name, audioDataUrl, shareToLounge } = req.body || {};
      if (!audioDataUrl) {
        return reply.status(400).send({ error: 'audioDataUrl is required.' });
      }
      const res = await NexusStudioEngine.saveStudioTrack(
        name,
        audioDataUrl,
        meshShareManager,
        meshHub,
        shareToLounge
      );
      return reply.send(res);
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 9. F5-TTS 1-Shot Voice Cloning
  const handleVocalClone = async (req: FastifyRequest<{
    Body: {
      refAudioDataUrl: string;
      refText?: string;
      genText: string;
      speed?: number;
      shareToLounge?: boolean;
    };
  }>, reply: FastifyReply) => {
    try {
      const { refAudioDataUrl, refText, genText, speed, shareToLounge } = req.body || {};
      if (!genText || !genText.trim()) {
        return reply.status(400).send({ error: 'genText (target text) is required.' });
      }
      const res = await NexusStudioEngine.cloneVoiceF5({
        refAudioDataUrl: refAudioDataUrl || '',
        refText,
        genText,
        speed,
        meshShareManager,
        meshHub,
        shareToLounge
      });
      return reply.send(res);
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  };

  app.post('/v1/studio/vocal/clone', handleVocalClone);
  app.post('/v1/studio/vocal/f5-clone', handleVocalClone);

  // 10. Native GPU Music Generation (YuE2 int8 + RTX 4060)
  app.post<{
    Querystring: {
      stream?: string;
    };
    Body: {
      altPrompt?: string;
      lyrics?: string;
      genre?: string;
      bpm?: number;
      key?: string;
      scale?: string;
      duration?: number;
      seed?: number;
      temperature?: number;
      shareToLounge?: boolean;
    };
  }>('/v1/studio/music/generate', async (req, reply) => {
    const isStream = req.query?.stream === '1' || req.headers.accept?.includes('text/event-stream');

    if (isStream) {
      reply.hijack();
      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('Access-Control-Allow-Origin', '*');

      try {
        const result = await NexusStudioEngine.generateGpuMusic(
          req.body || {},
          meshHub,
          meshShareManager,
          (progress) => {
            reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
          }
        );
        reply.raw.write(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`);
        reply.raw.end();
      } catch (err: any) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        reply.raw.end();
      }
      return;
    } else {
      try {
        const result = await NexusStudioEngine.generateGpuMusic(
          req.body || {},
          meshHub,
          meshShareManager
        );
        return reply.send({ success: true, ...result });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    }
  });
}

