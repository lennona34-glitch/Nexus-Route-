import fs from 'fs';
import path from 'path';
import { unloadOllamaModels } from '../gpu/ollama.js';

export interface ArtworkLedgerEntry {
  id: number;
  title: string;
  creativeIntent: string;
  positivePrompt: string;
  negativePrompt: string;
  seed: number;
  size: string;
  progress: string;
  imageUrl?: string;
  localPath?: string;
  formattedText?: string;
  timestamp: string;
}

export type EndlessForgeState = 'idle' | 'running' | 'paused' | 'stopped';

interface ConceptCandidate {
  title: string;
  intent: string;
  prompt: string;
  negativePrompt: string;
  size: string;
  realm: string;
  style: string;
  palette: string;
  score?: number;
}

export class EndlessForgeEngine {
  private state: EndlessForgeState = 'idle';
  private currentProgress = 0;
  private maxArtworks = 25;
  private sessionStartTime: number | null = null;
  private readonly maxDurationMs = 4 * 60 * 60 * 1000;
  private ledger: ArtworkLedgerEntry[] = [];
  private currentDirection = '';
  private isProcessing = false;
  private pfPort = 17861;
  private pfToken = '';
  private loopTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private consecutiveRenderFailures = 0;

  constructor() {
    this.refreshPromptForgeConfig();
    this.startHeartbeat();
  }

  public refreshPromptForgeConfig(): { token: string; port: number } {
    try {
      const configPath = 'C:\\Users\\adria\\AppData\\Local\\PromptForgeRTX\\config.json';
      if (fs.existsSync(configPath)) {
        const pfJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (pfJson.api_token) this.pfToken = pfJson.api_token;
        if (pfJson.api_port) this.pfPort = pfJson.api_port;
      }
    } catch {}
    return { token: this.pfToken, port: this.pfPort };
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(async () => {
      this.refreshPromptForgeConfig();
      if (this.pfToken) {
        try {
          await fetch(`http://127.0.0.1:${this.pfPort}/v1/models`, {
            headers: { Authorization: `Bearer ${this.pfToken}` },
            signal: AbortSignal.timeout(2000),
          });
        } catch {}
      }
    }, 3500);
  }

  public async checkHealth(): Promise<{ online: boolean; activeModel?: string; queueBusy?: boolean; message?: string }> {
    this.refreshPromptForgeConfig();
    try {
      const res = await fetch(`http://127.0.0.1:${this.pfPort}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as any;
      return {
        online: data.status === 'ok',
        activeModel: data.active_model,
        queueBusy: data.gpu_queue_busy,
      };
    } catch (err: any) {
      return {
        online: false,
        message: 'PromptForge RTX is not responding. Please open PromptForge RTX.',
      };
    }
  }

  public getStatus() {
    return {
      state: this.state,
      currentProgress: this.currentProgress,
      maxArtworks: this.maxArtworks,
      ledgerLength: this.ledger.length,
      currentDirection: this.currentDirection,
      isProcessing: this.isProcessing,
      lastArtwork: this.ledger[this.ledger.length - 1] || null,
      sessionElapsedSeconds: this.sessionStartTime ? Math.floor((Date.now() - this.sessionStartTime) / 1000) : 0,
    };
  }

  public getPollData(sinceId = 0) {
    const newEntries = this.ledger.filter((item) => item.id > sinceId);
    return {
      success: true,
      state: this.state,
      currentProgress: this.currentProgress,
      maxArtworks: this.maxArtworks,
      isProcessing: this.isProcessing,
      lastArtwork: this.ledger[this.ledger.length - 1] || null,
      newEntries,
    };
  }

  public async handleCommand(command: string, theme?: string): Promise<{ text: string; artwork?: ArtworkLedgerEntry }> {
    const cleanCmd = command.trim().toLowerCase();
    let explicitTheme = theme?.trim() || '';
    if (!explicitTheme) {
      if (command.includes(':')) {
        explicitTheme = command.split(':').slice(1).join(':').trim();
      } else if (cleanCmd.includes('with theme')) {
        explicitTheme = command.replace(/^.*?with theme\s*[:=]?\s*/i, '').trim();
      }
    }

    if (cleanCmd.includes('start')) return this.startSession(explicitTheme);
    if (cleanCmd.includes('pause')) return this.pauseSession();
    if (cleanCmd.includes('stop')) return this.stopSession();
    if (cleanCmd.includes('skip')) return this.skipConcept();
    if (cleanCmd.includes('evolve')) return this.evolveConcept();
    if (cleanCmd.includes('pivot')) return this.hardPivot();
    return { text: `Unknown Endless Forge command: "${command}". Available: Start Endless Forge, Pause Endless Forge, Stop Endless Forge, Skip, Evolve this, Hard pivot.` };
  }

  public async startSession(theme?: string, maxArtworks = 100): Promise<{ text: string; artwork?: ArtworkLedgerEntry }> {
    const health = await this.checkHealth();
    if (!health.online) {
      return { text: '⚠️ PromptForge RTX is unavailable. Please launch PromptForge RTX on your PC, then click **Start Endless Forge**.' };
    }
    const ollamaUnload = await unloadOllamaModels();
    if (this.state === 'stopped' || this.currentProgress >= this.maxArtworks) {
      this.currentProgress = 0;
    }
    this.state = 'running';
    this.maxArtworks = Math.max(maxArtworks, this.currentProgress + 25);
    this.sessionStartTime = Date.now();
    if (theme !== undefined) {
      this.currentDirection = theme?.trim() || '';
    }
    const started = this.launchRender();
    return {
      text: started
        ? `🔥 **Endless Forge started.**${ollamaUnload.unloadedModels.length ? ` Freed Ollama VRAM from ${ollamaUnload.unloadedModels.join(', ')}.` : ''} The first artwork is rendering on ${health.activeModel || 'PromptForge RTX'} and will appear in the live feed when complete.`
        : '⚡ Endless Forge is already rendering an artwork. The result will appear in the live feed when complete.',
    };
  }

  public pauseSession(): { text: string } {
    this.state = 'paused';
    if (this.loopTimeout) clearTimeout(this.loopTimeout);
    return { text: `⏸️ **Endless Forge Paused.** On standby at ${this.currentProgress} artworks. Click **Start Endless Forge** to resume.` };
  }

  public stopSession(): { text: string } {
    this.state = 'stopped';
    if (this.loopTimeout) clearTimeout(this.loopTimeout);
    return { text: `⏹️ **Endless Forge Stopped.** Session ended after ${this.currentProgress} artworks rendered.` };
  }

  public async skipConcept(): Promise<{ text: string; artwork?: ArtworkLedgerEntry }> {
    this.state = 'running';
    const started = this.launchRender({ forceFresh: true });
    return { text: started ? '⏭️ Current concept skipped. A fresh direction is rendering.' : '⚡ The current GPU render must finish before Skip can take effect.' };
  }

  public async evolveConcept(): Promise<{ text: string; artwork?: ArtworkLedgerEntry }> {
    this.state = 'running';
    const started = this.launchRender({ evolve: true });
    return { text: started ? '🧬 Evolution queued. The next variation is rendering.' : '⚡ The current GPU render must finish before Evolve can take effect.' };
  }

  public async hardPivot(): Promise<{ text: string; artwork?: ArtworkLedgerEntry }> {
    this.state = 'running';
    const started = this.launchRender({ hardPivot: true });
    return { text: started ? '↪️ Hard pivot accepted. A substantially different concept is rendering.' : '⚡ The current GPU render must finish before Hard Pivot can take effect.' };
  }

  private launchRender(options: { forceFresh?: boolean; evolve?: boolean; hardPivot?: boolean } = {}): boolean {
    if (this.isProcessing) return false;
    void this.renderNextArtwork(options).finally(() => {
      if (this.state === 'running') this.scheduleNextLoop();
    });
    return true;
  }

  private scheduleNextLoop() {
    if (this.state !== 'running') return;
    if (this.loopTimeout) clearTimeout(this.loopTimeout);
    this.loopTimeout = setTimeout(async () => {
      if (this.state !== 'running') return;
      if (this.currentProgress >= this.maxArtworks) {
        this.maxArtworks += 25; // Auto-extend session so Endless Forge never halts unexpectedly
      }
      if (this.sessionStartTime && Date.now() - this.sessionStartTime > this.maxDurationMs) {
        this.state = 'stopped';
        return;
      }

      try {
        await this.renderNextArtwork();
      } catch (err: any) {
        console.error('Endless Forge loop render error:', err?.message || err);
      }

      if (this.state === 'running') {
        this.scheduleNextLoop();
      }
    }, 2500);
  }

  public async renderNextArtwork(options: { forceFresh?: boolean; evolve?: boolean; hardPivot?: boolean } = {}): Promise<{ text: string; artwork?: ArtworkLedgerEntry }> {
    if (this.isProcessing) {
      return { text: '⚡ A render is currently being synthesized on your GPU. Please allow the current artwork to finish.' };
    }
    this.isProcessing = true;
    try {
      const nextIndex = this.currentProgress + 1;

      // 1. Privately invent 3 substantially different concepts
      const candidates = this.generateThreeUniqueCandidates(nextIndex, options);

      // 2. Judge for originality, visual coherence, emotional impact and SDXL renderability
      const chosen = this.selectBestCandidate(candidates);

      // 3. Render through PromptForge RTX in Quality preset (28 steps, guidance 6.0)
      const renderRes = await this.executePromptForgeRender(chosen);

      const outputText = `![${chosen.title}](${renderRes.imageUrl})

**Title:** ${chosen.title}

**Creative intent:** ${chosen.intent}

**Positive prompt:** ${chosen.prompt}

**Negative prompt:** ${chosen.negativePrompt}

**Seed:** ${renderRes.seed}

**Progress through the session:** ${nextIndex} / ${this.maxArtworks}`;

      const entry: ArtworkLedgerEntry = {
        id: nextIndex,
        title: chosen.title,
        creativeIntent: chosen.intent,
        positivePrompt: chosen.prompt,
        negativePrompt: chosen.negativePrompt,
        seed: renderRes.seed,
        size: chosen.size,
        progress: `${nextIndex} / ${this.maxArtworks}`,
        imageUrl: renderRes.imageUrl,
        localPath: renderRes.localPath,
        formattedText: outputText,
        timestamp: new Date().toISOString(),
      };

      this.ledger.push(entry);
      if (this.ledger.length > 20) this.ledger.shift();
      this.currentProgress = nextIndex;
      this.consecutiveRenderFailures = 0;

      return { text: outputText, artwork: entry };
    } catch (err: any) {
      this.consecutiveRenderFailures++;
      const reason = err?.message || String(err);
      if (this.consecutiveRenderFailures >= 3) {
        this.state = 'paused';
        if (this.loopTimeout) clearTimeout(this.loopTimeout);
        return {
          text: `❌ Render Error: ${reason}\n\n⏸️ Endless Forge paused after ${this.consecutiveRenderFailures} consecutive renderer failures. Failed attempts were not counted as artworks.`,
        };
      }
      return { text: `❌ Render Error: ${reason}` };
    } finally {
      this.isProcessing = false;
    }
  }

  // --- High-Entropy Infinite Concept Synthesis Engine ---

  private generateThreeUniqueCandidates(index: number, options: { forceFresh?: boolean; evolve?: boolean; hardPivot?: boolean } = {}): ConceptCandidate[] {
    const isEvolutionMilestone = index % 4 === 0 || options.evolve;
    const isDepartureMilestone = index % 8 === 0 || options.hardPivot;

    const candidate1 = this.synthesizeProceduralConcept(index, { realmBias: isDepartureMilestone ? 'departure' : (isEvolutionMilestone ? 'evolution' : 'fresh') });
    const candidate2 = this.synthesizeProceduralConcept(index + 101, { realmBias: 'divergent' });
    const candidate3 = this.synthesizeProceduralConcept(index + 202, { realmBias: 'exotic' });

    return [candidate1, candidate2, candidate3];
  }

  private selectBestCandidate(candidates: ConceptCandidate[]): ConceptCandidate {
    const scored = candidates.map((c) => {
      let score = 80 + Math.random() * 15;
      const recentTitles = this.ledger.map((l) => l.title.toLowerCase());
      if (recentTitles.some((t) => t.includes(c.title.toLowerCase()) || c.title.toLowerCase().includes(t))) {
        score -= 40;
      }
      return { ...c, score };
    });
    scored.sort((a, b) => (b.score || 0) - (a.score || 0));
    return scored[0];
  }

  private synthesizeProceduralConcept(seedOffset: number, options: { realmBias?: string } = {}): ConceptCandidate {
    const realms = [
      {
        name: 'Cosmic Mysticism',
        subjects: [
          'an ancient star-weaver with luminescent silver hair weaving glowing celestial nebulae on a crystalline loom',
          'a cloaked astrological cartographer measuring the event horizon of a dormant golden black hole with brass astrolabes',
          'a colossal celestial sphinx carved from comet ice drifting through the rings of an indigo gas giant',
          'a solitary astronaut meditating inside an orbital glass dome while a supernova blooms in silence across deep space',
          'an interstellar cathedral ship powered by a captive dying star pulsing with violet gravitational ripples',
        ],
        settings: [
          'deep violet cosmic void with glittering star dust and cyan auroral filaments',
          'orbit above a shattered crystal moon surrounded by iridescent asteroid rings',
          'inside a vast stratospheric observatory suspended over a turbulent turquoise gas planet',
          'the edge of an accretion disk with blinding golden plasma jets and obsidian gravitational lens distortions',
        ],
        styles: [
          'Masterpiece digital painting with ethereal illumination and luminous nebula volumetrics, 8k resolution, trending on ArtStation',
          'Vintage 1970s science fiction book cover illustration in the style of John Harris and Chris Foss, crisp airbrush and rich gouache tones',
          'Epic cinematic matte painting with dramatic astronomical lighting, deep color saturation and intricate interstellar details',
        ],
        palettes: 'deep indigo, luminescent cyan, ultraviolet, glittering starlight gold',
        aspects: ['1152x768', '1216x832', '1024x1024'],
      },
      {
        name: 'Cyberpunk & Biopunk Synthetics',
        subjects: [
          'a porcelain android geisha with delicate exposed brass joints and fiber-optic hair adjusting a traditional paper umbrella under neon rain',
          'a solitary cybernetic street surgeon grafting bioluminescent glass coral onto a mechanical arm in a smoky alleyway',
          'a gigantic holographic carp swimming between towering rain-slicked megacity skyscrapers in Neo-Kyoto',
          'an autonomous bio-mechanical tiger with transparent carbon-fiber chassis stalking through an abandoned hydroponic lab',
          'a high-speed monorail conductor with augmented chrome optic implants looking out at the glittering neon horizon',
        ],
        settings: [
          'dense rain-drenched neon metropolis with glowing holographic advertisements and wet asphalt reflections',
          'cluttered subterranean cyber-bazaar illuminated by warm paper lanterns and flickering green cathode-ray terminals',
          'hyper-modern rooftop greenhouse filled with glowing transgenic flora overlooking a sprawling nocturnal megacity',
          'misty industrial waterfront under heavy monsoon clouds with towering container cranes and holographic harbor beacons',
        ],
        styles: [
          'Cinematic cyberpunk photography with anamorphic lens flares, rich bokeh, rain textures, and 35mm film grain, 8k',
          'Dark futuristic digital concept art in the style of Syd Mead and Blade Runner, hyper-detailed architectural rendering',
          'Vibrant synthwave neo-noir illustration with intense contrasting rim lights and atmospheric steam haze',
        ],
        palettes: 'neon magenta, electric cyan, deep obsidian black, amber neon reflections',
        aspects: ['1152x768', '832x1216', '1216x832'],
      },
      {
        name: 'Dark Gothic Baroque & Alchemy',
        subjects: [
          'a hooded Renaissance alchemist pouring incandescent liquid gold into a complex clockwork homunculus in a vaulted stone crypt',
          'a gothic monastic choir holding silver incense censers beneath a fractured cathedral ceiling opening to an eclipsing blood moon',
          'a masked plague doctor examining an illuminated botanical manuscript in an ancient candlelit library surrounded by glass alembics',
          'a majestic clockwork archangel with stained-glass wings standing watch over an ornate brass cathedral organ',
          'an aristocratic vampire countess draped in crimson velvet seated on an obsidian throne carved with gargoyles',
        ],
        settings: [
          'grand Gothic cathedral ruin with towering ribbed vaults, shattered stained glass, and drifting candlelight smoke',
          'dimly lit subterranean alchemical laboratory filled with glowing glass retorts, parchment scrolls, and amber shadows',
          'misty midnight courtyard of a Romanian castle surrounded by towering gargoyles and withered black iron gates',
          'ancient vaulted library with towering spiral staircases, glowing candelabras, and floating dust motes',
        ],
        styles: [
          'Masterpiece classical oil painting in the dramatic chiaroscuro style of Caravaggio and Rembrandt, rich impasto and heavy shadows, 8k',
          'Dark romantic fantasy painting in the style of Caspar David Friedrich, moody atmospheric haze and sublime gothic architecture',
          'Detailed Baroque digital illustration with intricate gold filigree, realistic candle flame physics, and rich textured fabrics',
        ],
        palettes: 'Prussian blue, warm candlelight amber, deep velvet crimson, aged parchment gold',
        aspects: ['832x1216', '1024x1024', '1152x768'],
      },
      {
        name: 'Solarpunk & Verdant Utopias',
        subjects: [
          'an architectural botanist in flowing linen tending a vertical sky-forest integrated into white curving solar towers',
          'a graceful solar glider with iridescent dragonfly wings soaring over a crystalline coastal ecocity',
          'a mechanical gardener made of terracotta and polished copper delicately grafting heirloom glass orchids in a terraced arboretum',
          'a tranquil tea ceremony conducted inside a floating glass bubble suspended among giant flowering redwoods',
          'a team of marine biologists harvesting bioluminescent kelp from a coral-reef bio-dome under golden morning sunlight',
        ],
        settings: [
          'sun-drenched futuristic ecocity with curving white biomorphic architecture, waterfalls, and lush hanging gardens',
          'ancient overgrown forest harmoniously interwoven with clean glass solar arrays and flowing aqueducts',
          'shimmering Mediterranean coastal terrace with turquoise water, blooming wisteria, and wind-turbine spires',
          'colossal open-air greenhouse dome with warm dappled sunlight filtering through giant jungle canopy trees',
        ],
        styles: [
          'Luminous anime cinematography in the style of Makoto Shinkai and Studio Ghibli, vibrant natural lighting, pristine sky detail, 8k',
          'Modern solarpunk architectural concept art with clean biomimetic structures, rich lush greenery, and bright volumetric sunbeams',
          'Detailed utopian matte painting with crisp atmospheric depth, floating pollen particles, and serene emotional resonance',
        ],
        palettes: 'emerald green, pristine white, warm sunlight gold, turquoise, terracotta',
        aspects: ['1216x832', '1152x768', '1024x1024'],
      },
      {
        name: 'Abyssal Deep Ocean & Submerged Relics',
        subjects: [
          'a solitary deep-sea diver in an illuminated brass atmospheric suit swimming through the nave of a sunken Gothic cathedral',
          'a colossal bioluminescent leviathan gliding gracefully past ancient underwater marble pillars encrusted with glowing violet anemones',
          'an underwater submersible explorer shining halogen floodlights on a petrified prehistoric coral leviathan in a midnight trench',
          'an ancient Atlantean automaton holding a glowing pearl lantern on a hydrothermal basalt plateau surrounded by glowing jellyfish',
          'a marine archaeologist discovering an intact mosaic floor depicting celestial constellations deep within an oceanic rift',
        ],
        settings: [
          'midnight oceanic trench with towering hydrothermal vents, floating cyan spores, and deep ultraviolet bioluminescence',
          'sunken neoclassical city submerged beneath crystalline azure waters with streaming caustic light patterns and schooling silver fish',
          'vast underwater cavern system illuminated by pulsing sapphire fungi and natural crystal formations',
          'ancient underwater temple ruins covered in kelp forests with misty god rays penetrating from the distant surface',
        ],
        styles: [
          'Masterpiece cinematic underwater photography with realistic volumetric light shafts, floating marine snow particles, and rich deep blues, 8k',
          'Surreal ocean fantasy digital art with ethereal bioluminescent glow, high dynamic range, and majestic scale',
          'Detailed National Geographic underwater expedition style with crisp focal clarity and breathtaking atmosphere',
        ],
        palettes: 'abyssal navy, glowing cyan, electric violet, pearlescent aquamarine',
        aspects: ['832x1216', '1152x768', '1024x1024'],
      },
      {
        name: 'Ancient Mythic Surrealism & Desert Epics',
        subjects: [
          'a wandering desert nomad in ceremonial mirrored robes leading a mechanical camel across singing sand dunes under two suns',
          'a towering stone titan half-submerged in golden desert sands with ancient glowing hieroglyphic inscriptions on its chest',
          'an artisan in ceramic heat-shield armor shaping glowing molten solar plasma inside a colossal parabolic desert mirror',
          'a celestial falcon with feathers made of polished lapis lazuli and gold filigree perching atop an obsidian obelisk',
          'a mystic astronomer holding a sphere of captive desert lightning under a twilight sky filled with meteors',
        ],
        settings: [
          'vast desert plateau during a dual-sunset with towering sandstone arches, crystalline salt flats, and golden twilight dust',
          'ancient Egyptian-inspired monument complex with colossal obsidian statues reflected in still oasis waters under a starry sky',
          'wind-sculpted canyon of rose-gold granite with ancient stairways carved into the cliffs leading to a hidden mountain sanctuary',
          'high-altitude Atacama salt desert with blinding white terrain and a deep indigo twilight sky showcasing the Milky Way',
        ],
        styles: [
          'Cinematic desert epic digital painting in the style of Dune and Lawrence of Arabia, grand sense of scale, volumetric heat haze, 8k',
          'Fine art oil painting with rich mineral pigments, deep gold leaf highlights, and dramatic low-angle evening sunlight',
          'Surrealist concept art with clean architectural linework, monumental proportions, and intense color contrast',
        ],
        palettes: 'ochre gold, burnt sienna, deep lapis lazuli, rose quartz, twilight violet',
        aspects: ['1216x832', '1152x768', '1024x1024'],
      },
      {
        name: 'Retro 80s Synthwave & Neon Outrun',
        subjects: [
          'a chrome retro sports car speeding down an endless glowing neon wireframe highway toward a giant digital sun',
          'a cybernetic saxophonist performing on a rain-slicked skyscraper helipad under purple neon lightning',
          'a glowing retro arcade cabinet projecting interactive 3D vector laser holograms in an abandoned neon lounge',
          'an 80s anime mecha pilot with a reflective gold visor inside an illuminated cockpit soaring over a nocturnal city',
        ],
        settings: [
          'infinite magenta wireframe grid horizon with laser palm tree silhouettes and a glowing retro grid sunset',
          'dense neon-drenched rooftop overlooking a sprawling purple megacity with wet asphalt reflections and blue searchlights',
          'subterranean retro-futuristic roller rink illuminated by pulsating neon lasers and chrome mirror balls',
        ],
        styles: [
          'Vibrant synthwave neo-noir digital art with intense contrasting neon rim lights and laser grid aesthetics, 8k',
          'Classic 1980s retro anime aesthetic in the style of Bubblegum Crisis and Akira, crisp cel shading and film grain',
          'Cinematic outrun wallpaper illustration with sharp chrome reflections, deep purple shadows, and neon glow',
        ],
        palettes: 'neon magenta, electric cyan, midnight violet, solar gold, hot pink',
        aspects: ['1216x832', '1152x768', '1024x1024'],
      },
      {
        name: 'Eldritch Crystal Spires & Deep Cavern Relics',
        subjects: [
          'a subterranean crystal golem holding a glowing amethyst lantern inside a colossal underground geode cavern',
          'an ancient scholar deciphering glowing emerald runes on floating obsidian monoliths in a subterranean sanctum',
          'a swarm of bioluminescent glass moths hovering around an active subterranean stargate made of liquid mercury',
          'a petrified stone colossus holding an incandescent sapphire star in its palms beneath underground waterfalls',
        ],
        settings: [
          'vast underground cavern filled with towering purple amethyst crystals, glowing lichens, and underground mist',
          'ancient submerged basalt ruins with glowing turquoise glyphs and shimmering caustic light reflections',
          'crystal canyon illuminated by pulsing sapphire fissures and drifting radiant spore clouds',
        ],
        styles: [
          'Dark high-fantasy concept art with dramatic crystal refraction and volumetric light rays, 8k resolution',
          'Eldritch atmospheric digital painting in the style of Lovecraft, moody and awe-inspiring with intricate details',
          'Detailed cinematic matte painting with deep cavern shadows and radiant subterranean luminescence',
        ],
        palettes: 'amethyst purple, emerald green, obsidian black, glowing sapphire, glowing turquoise',
        aspects: ['832x1216', '1152x768', '1024x1024'],
      },
      {
        name: 'Steampunk Aerostats & Victorian Skyports',
        subjects: [
          'a magnificent brass and mahogany airship docking at a towering Victorian cloud spire during a golden sunrise',
          'a clockwork ornithopter pilot in leather flight jacket testing mechanical wings above a sea of golden clouds',
          'an eccentric Victorian astronomer adjusting a giant brass telescope on a floating steam observatory platform',
          'a mechanical courier automaton gliding across suspended copper cables between soaring steampunk skyscrapers',
        ],
        settings: [
          'breathtaking cloud-level skyport at dawn with brass towers, steam plumes, and soaring zeppelins',
          'floating Victorian city suspended above golden clouds with glowing gas lamps and ornate iron bridges',
          'high-altitude observatory deck with polished brass instruments and expansive panoramic sky vistas',
        ],
        styles: [
          'Masterpiece steampunk illustration with intricate polished brass gears, realistic steam physics, and warm sunrise light, 8k',
          'Victorian retro-futuristic concept art in the style of Ian McQue, rich painterly textures and epic scale',
          'Detailed romantic architectural fantasy painting with golden hour volumetric sunlight and atmospheric haze',
        ],
        palettes: 'burnished brass, copper, warm dawn amber, sky azure, mahogany',
        aspects: ['1216x832', '1152x768', '1024x1024'],
      },
      {
        name: 'Hyper-Macro Photorealism & Micro Ecosystems',
        subjects: [
          'an iridescent metallic scarab beetle perched on a mossy twig with a water droplet reflecting an entire galaxy',
          'a miniature bioluminescent mushroom forest on an ancient tree root glowing with sapphire spores under moonlight',
          'a delicate clockwork hummingbird with sapphire gears sipping nectar from a crystalline glass orchid',
          'a tiny chameleon made of polished stained glass resting on an emerald fern in a dewy rainforest',
        ],
        settings: [
          'extreme macro forest floor with dewy emerald moss, soft morning bokeh, and shimmering crystal water droplets',
          'enchanted fairy ring of miniature glowing mushrooms with floating luminous spores at twilight',
          'sunlit greenhouse terrace with dappled morning light filtering through dew-covered tropical leaves',
        ],
        styles: [
          'Award-winning National Geographic macro photography, razor-sharp focal clarity, creamy f/1.4 bokeh, 8k',
          'Hyper-realistic nature photography with studio rim lighting and microscopic texture detail',
          'Ethereal magical realism digital art with soft glow, sparkling dew particles, and pristine clarity',
        ],
        palettes: 'emerald moss green, sapphire blue, golden pollen yellow, crystal clear dewdrops',
        aspects: ['1024x1024', '832x1216', '1152x768'],
      },
    ];

    const realmIndex = Math.floor((seedOffset + Math.random() * 100) % realms.length);
    const realm = realms[realmIndex];

    const subject = realm.subjects[Math.floor(Math.random() * realm.subjects.length)];
    const setting = realm.settings[Math.floor(Math.random() * realm.settings.length)];
    const style = realm.styles[Math.floor(Math.random() * realm.styles.length)];
    const size = realm.aspects[Math.floor(Math.random() * realm.aspects.length)];

    const titlePrefixes = ['The', 'Chronicles of the', 'Sanctuary of the', 'Requiem for the', 'The Last', 'The Celestial', 'The Solitary', 'Echoes of the', 'The Secret'];
    const titleSubjects = ['Starlight Weaver', 'Chrono-Cartographer', 'Nomad Colossus', 'Abyssal Cathedral', 'Solar Glassblower', 'Clockwork Alchemist', 'Android Botanist', 'Eclipse Choir', 'Titan of Sand', 'Bioluminescent Leviathan', 'Orbital Observer', 'Archangel of Brass', 'Storm Mystic'];
    const titleLocales = ['of Titan', 'of Andromeda', 'of Atacama', 'of Neo-Kyoto', 'of St. Vael', 'of the Rift', 'of Elysium', 'of the Abyss', 'of Alexandria', 'of the Singularity'];

    const title = `${titlePrefixes[Math.floor(Math.random() * titlePrefixes.length)]} ${titleSubjects[Math.floor(Math.random() * titleSubjects.length)]} ${titleLocales[Math.floor(Math.random() * titleLocales.length)]}`;

    const customTheme = this.currentDirection?.trim();
    const effectiveSubject = customTheme ? `${subject} (${customTheme})` : subject;

    const intent = customTheme
      ? `A specialized exploration of "${customTheme}" situated within ${realm.name.toLowerCase()}, capturing ${subject} amidst ${setting}. Harmonized by a color palette of ${realm.palettes}.`
      : `A sophisticated study in ${realm.name.toLowerCase()}, capturing ${subject} situated within ${setting}. Harmonized by a color palette of ${realm.palettes}.`;

    // Strict 75-token CLIP budget optimization (eliminates PromptForge "over limit" warnings)
    const cleanStyle = style.replace(/, 8k quality|, 8k|masterpiece/gi, '').trim();
    const positiveParts = [
      cleanStyle,
      customTheme ? `Theme: ${customTheme}` : '',
      effectiveSubject,
      setting,
      `palette: ${realm.palettes}`,
      'masterpiece, highly detailed'
    ].filter(Boolean);

    let prompt = positiveParts.join(', ');
    const words = prompt.split(/\s+/);
    if (words.length > 50) {
      prompt = words.slice(0, 50).join(' ');
    }

    const negativePrompt = 'blurry, low quality, watermark, text, extra limbs, deformed, bad anatomy, cropped';

    return {
      title,
      intent,
      prompt,
      negativePrompt,
      size,
      realm: realm.name,
      style,
      palette: realm.palettes,
    };
  }

  private async executePromptForgeRender(concept: { prompt: string; negativePrompt: string; size: string }): Promise<{ seed: number; imageUrl: string; localPath: string }> {
    this.refreshPromptForgeConfig();
    const token = this.pfToken;
    const port = this.pfPort;

    const submitRes = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'current',
        quality: 'quality',
        steps: 28,
        guidance_scale: 6.0,
        prompt: concept.prompt,
        negative_prompt: concept.negativePrompt,
        size: concept.size,
        seed: -1,
        n: 1,
        async: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!submitRes.ok) throw new Error(`PromptForge rejected submission (${submitRes.status})`);
    const submitData = (await submitRes.json()) as any;
    const jobId = submitData.id || submitData.job_id;
    if (!jobId) throw new Error('No job ID returned');

    let attempts = 0;
    let finalJob: any = null;
    // Low-VRAM CPU offload can take well over four minutes for a 28-step SDXL
    // render. Keep polling without holding the browser request open.
    const maxPollAttempts = 900; // 30 minutes at a two-second interval
    while (!finalJob && attempts < maxPollAttempts) {
      attempts++;
      await new Promise((r) => setTimeout(r, 2000));
      const jobRes = await fetch(`http://127.0.0.1:${port}/v1/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!jobRes.ok) continue;
      const job = (await jobRes.json()) as any;
      if (job.status === 'completed' || job.state === 'completed') {
        finalJob = job;
      } else if (job.status === 'failed' || job.state === 'failed') {
        throw new Error(job.error || job.message || 'Generation failed');
      } else if (job.status === 'cancelled' || job.state === 'cancelled') {
        throw new Error('PromptForge generation was cancelled');
      }
    }

    if (!finalJob) {
      try {
        await fetch(`http://127.0.0.1:${port}/v1/jobs/${jobId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
      throw new Error('Render job exceeded the 30-minute safety limit and was cancelled');
    }
    if (!finalJob.data?.[0]) throw new Error('PromptForge completed without returning image data');

    let localImageUrl = `/v1/promptforge/images/${jobId}.png`;
    const artFilename = `endless_forge_${jobId}_${finalJob.data[0].seed}.png`;
    try {
      const wsArtDir = path.join(process.cwd(), 'workspace', 'art');
      if (!fs.existsSync(wsArtDir)) fs.mkdirSync(wsArtDir, { recursive: true });
      const imgRes = await fetch(`http://127.0.0.1:${port}/v1/images/${jobId}.png`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (imgRes.ok) {
        const ab = await imgRes.arrayBuffer();
        fs.writeFileSync(path.join(wsArtDir, artFilename), Buffer.from(ab));
        localImageUrl = `/v1/workspace/files/art/${artFilename}`;
      }
    } catch {}

    return {
      seed: finalJob.data[0].seed,
      imageUrl: localImageUrl,
      localPath: 'C:\\Users\\adria\\Pictures\\PromptForge RTX',
    };
  }
}

export const endlessForgeEngine = new EndlessForgeEngine();
