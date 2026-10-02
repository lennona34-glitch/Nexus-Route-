import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
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

  public static getMaestroOutputsDir(): string {
    const userProfile = process.env.USERPROFILE || os.homedir();
    const defaultPath = process.env.MAESTRO_OUTPUTS_DIR || path.join(userProfile, 'Desktop', 'Maestro AI', 'app', 'outputs');
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
    // Fallback to shared/audio/maestro
    const fallbackPath = path.resolve(process.cwd(), 'shared', 'audio', 'maestro');
    if (!fs.existsSync(fallbackPath)) {
      fs.mkdirSync(fallbackPath, { recursive: true });
    }
    return fallbackPath;
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
   * Generate structured lyrics using local Ollama model or procedural lyrical fallbacks
   */
  public static async generateLyrics(params: {
    prompt: string;
    genre?: string;
    mood?: string;
    vocalStyle?: string;
    model?: string;
  }): Promise<{ lyrics: string; modelUsed: string; structure: string[] }> {
    const { prompt, genre = 'Synthwave', mood = 'Energetic', vocalStyle = 'Melodic Baritone', model } = params;
    const cleanPrompt = prompt.trim() || `Song about ${mood} vibes in ${genre}`;

    const systemPrompt = `You are a master AI lyricist and hit songwriter for modern music generators like YuE2, Suno, Udio, and ACE-Step.
Write complete, high-impact song lyrics with explicit structural tags:
[Intro]
[Verse 1]
[Pre-Chorus]
[Chorus]
[Verse 2]
[Chorus]
[Bridge]
[Guitar / Synth Solo]
[Chorus]
[Outro]

Guidelines:
- Match the ${genre} genre and ${mood} mood with evocative lyrical imagery.
- Ensure natural rhythm, cadence, and consistent rhyming schemes.
- Add vocal cue annotations in parentheses where appropriate (e.g., (harmony), (whispered), (crescendo)).
- Return ONLY the lyrics with the section headers.`;

    const chosenModel = model || 'gemma-4-e4b-uncensored-hauhaucs-aggressive-q4:latest';

    // Attempt generation via local Ollama
    try {
      const ollamaResp = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: chosenModel,
          prompt: `${systemPrompt}\n\nUser Request: ${cleanPrompt}\nVocal Timbre: ${vocalStyle}`,
          stream: false,
          options: {
            temperature: 0.8,
            top_p: 0.9,
          },
        }),
      });

      if (ollamaResp.ok) {
        const data = (await ollamaResp.json()) as any;
        if (data.response && data.response.trim()) {
          const lyrics = data.response.trim();
          const structure = Array.from(lyrics.matchAll(/\[(.*?)\]/g)).map(m => (m as any)[1]);
          return {
            lyrics,
            modelUsed: chosenModel,
            structure: structure.length ? structure : ['Intro', 'Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Outro'],
          };
        }
      }
    } catch (err: any) {
      console.warn('[StudioEngine] Local Ollama lyric generation failed, using procedural fallback:', err.message);
    }

    // Procedural lyrical fallback if offline model isn't active
    const fallbackLyrics = `[Intro - Atmospheric ${genre} Arpeggios]
(Soft synth sweep, distant heartbeat beat)

[Verse 1]
The neon skyline starts to blur and fade
Lost in the echoes of decisions made
Static is whispering across the wire
Spark in the dark that ignites the fire

[Pre-Chorus]
(Building rhythm, rising tension)
Can you feel the frequency pull us in?
Where the signals stop and the dreams begin!

[Chorus]
(Full energy, driving bassline)
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
(Harmonized vocals, soaring delivery)
Hold on to the high-wire sound!
Feet off the pavement, we're leaving the ground!
Through the frequency and through the light
We ride the sonic wave tonight!

[Bridge]
(Half-time groove, filtered vocals)
And if the silence comes to take it all away
We'll build an empire out of what we play...

[Synth Solo / Breakdown]
(16-bar melodic lead, wide chorus effect)

[Outro]
(Distant echoes, decaying reverb)
Ride the sonic wave...
Ride into the light...
Fade to black.`;

    return {
      lyrics: fallbackLyrics,
      modelUsed: 'procedural-lyricist-v1',
      structure: ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Synth Solo', 'Outro'],
    };
  }

  /**
   * Craft grand musical prompts matching YuE2 & Suno/Udio/ACE-Step formats
   */
  public static async craftGrandPrompt(params: {
    genre?: string;
    tempo?: number;
    key?: string;
    mood?: string;
    vocalType?: string;
    instruments?: string[];
    description?: string;
    generateWithAi?: boolean;
    model?: string;
  }): Promise<{
    altPrompt: string;
    sunoTags: string;
    structurePrompt: string;
    tempo: number;
    key: string;
    genre: string;
  }> {
    const genre = params.genre || '80s Synthwave / Dark Cyberpunk';
    const tempo = params.tempo || 120;
    const key = params.key || 'E Minor';
    const mood = params.mood || 'Nostalgic, high-energy, yearning';
    const vocalType = params.vocalType || 'Male mid-range baritone, smooth and passionate delivery';
    const instruments = params.instruments?.length
      ? params.instruments.join(', ')
      : 'Analog Synthesizers, LinnDrum, tight driving bassline, twangy electric guitar with chorus';
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
            prompt: `Write a 2-sentence evocative musical atmosphere description for a ${genre} track at ${tempo} BPM in ${key} with ${mood} mood: "${desc}"`,
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

    // Exact YuE2 alt_prompt standard as used in Maestro AI
    const altPrompt = `Lead vocal: ${vocalType}. Genre: ${genre}. Lead instruments: ${instruments}. Mood: ${mood}. Production: Rich, slightly reverb-heavy, late 60s/80s analog warmth; layered backing harmonies during the chorus. Description: ${artisticDesc}. Tempo: Approx. ${tempo} BPM. Key: ${key}.`;

    // Suno / Udio / ACE-Step style tags
    const sunoTags = [
      genre.toLowerCase().replace(/\//g, ', '),
      `${tempo} bpm`,
      key.toLowerCase(),
      mood.toLowerCase().replace(/,/g, ''),
      vocalType.toLowerCase().split(',')[0],
      'analog warmth',
      'studio master',
      'punchy drums',
    ]
      .filter(Boolean)
      .join(', ');

    const structurePrompt = `[Genre: ${genre}] [Tempo: ${tempo} BPM] [Key: ${key}]
[Atmosphere: ${mood}]
[Instrumentation: ${instruments}]
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
      key,
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
      const pythonExe = process.platform === 'win32' ? 'python' : 'python3';

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

  // 3. Generate Lyrics with local Ollama
  app.post<{
    Body: {
      prompt: string;
      genre?: string;
      mood?: string;
      vocalStyle?: string;
      model?: string;
    };
  }>('/v1/studio/lyrics/generate', async (req, reply) => {
    try {
      const result = await NexusStudioEngine.generateLyrics(req.body || { prompt: 'Synthwave night drive' });
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 4. Grand Prompt Crafter
  app.post<{
    Body: {
      genre?: string;
      tempo?: number;
      key?: string;
      mood?: string;
      vocalType?: string;
      instruments?: string[];
      description?: string;
      generateWithAi?: boolean;
      model?: string;
    };
  }>('/v1/studio/prompts/grand', async (req, reply) => {
    try {
      const result = await NexusStudioEngine.craftGrandPrompt(req.body || {});
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // 5. Discover Maestro AI outputs
  app.get('/v1/studio/maestro/outputs', async () => {
    const tracks = await NexusStudioEngine.getMaestroOutputs();
    return {
      success: true,
      count: tracks.length,
      outputsDir: NexusStudioEngine.getMaestroOutputsDir(),
      tracks,
    };
  });

  // 6. Stream Maestro Audio
  app.get<{
    Querystring: {
      file?: string;
    };
  }>('/v1/studio/maestro/stream', async (req, reply) => {
    const fileName = req.query.file;
    if (!fileName) {
      return reply.status(400).send({ error: 'file query parameter is required.' });
    }
    return NexusStudioEngine.streamMaestroTrack(fileName, req, reply);
  });

  // 7. Share Maestro Track to Lounge
  app.post<{
    Body: {
      fileName: string;
      comment?: string;
    };
  }>('/v1/studio/maestro/share-to-lounge', async (req, reply) => {
    try {
      const { fileName, comment } = req.body || {};
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
  });

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
}
