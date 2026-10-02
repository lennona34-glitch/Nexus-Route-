import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { MeshPeer, ChatMessage, FileSearchResult, MeshConfig, MeshRoom, FileNode, VoicePeerState, VoiceSignalPayload } from './types.js';
import { ShareManager } from './shares.js';
import { OfflineRagEngine } from './rag_engine.js';
import { getRetroSystem, RETRO_SYSTEMS } from './retro_knowledge.js';
import { SovereignAgentRunner } from './agent_runner.js';

export type MeshEventHandler = (event: string, payload: unknown) => void;

interface ResidentCatalogFile {
  peerId: string;
  peerHandle: string;
  peerAvatar: string;
  name: string;
  subPath: string; // e.g. "audio/tb303-acid-lead.wav"
  size: number;
  category: 'audio' | 'retro' | 'models' | 'code' | 'docs';
}

const RESIDENT_FILES: ResidentCatalogFile[] = [
  // AcidArchivist (📼)
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'tb303-acid-lead.wav',
    subPath: 'audio/tb303-acid-lead.wav',
    size: 64512,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'acid-squelch-reso-135bpm.wav',
    subPath: 'audio/acid-squelch-reso-135bpm.wav',
    size: 49152,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: '909-drum-machine-loop.wav',
    subPath: 'audio/909-drum-machine-loop.wav',
    size: 57344,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'demoscene-space-debris.mod',
    subPath: 'audio/demoscene-space-debris.mod',
    size: 55296,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'second-reality-intro.s3m',
    subPath: 'audio/second-reality-intro.s3m',
    size: 58368,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'synthwave-bass-stem.wav',
    subPath: 'audio/synthwave-bass-stem.wav',
    size: 63488,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'ambient-drone-reverb-stems.flac',
    subPath: 'audio/ambient-drone-reverb-stems.flac',
    size: 48128,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'commodore-sid-arpeggio.wav',
    subPath: 'audio/commodore-sid-arpeggio.wav',
    size: 44032,
    category: 'audio',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'tb303_dsp_filter_emulation.cpp',
    subPath: 'code/tb303_dsp_filter_emulation.cpp',
    size: 55296,
    category: 'code',
  },
  {
    peerId: 'peer_acid',
    peerHandle: 'AcidArchivist',
    peerAvatar: '📼',
    name: 'tb303_service_manual_notes.md',
    subPath: 'docs/tb303_service_manual_notes.md',
    size: 87040,
    category: 'docs',
  },

  // RetroJunkie (🕹️)
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'afterburner.dsk',
    subPath: 'retro/afterburner.dsk',
    size: 60416,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'elite_plus3.dsk',
    subPath: 'retro/elite_plus3.dsk',
    size: 50176,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'robocop-plus3-disk.dsk',
    subPath: 'retro/robocop-plus3-disk.dsk',
    size: 62464,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'batman-the-movie-128k.dsk',
    subPath: 'retro/batman-the-movie-128k.dsk',
    size: 62464,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'r-type-spectrum-plus3.dsk',
    subPath: 'retro/r-type-spectrum-plus3.dsk',
    size: 61440,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'turrican-2-amiga.adf',
    subPath: 'retro/turrican-2-amiga.adf',
    size: 49152,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'amiga-workbench-31.adf',
    subPath: 'retro/amiga-workbench-31.adf',
    size: 53248,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'sensible-soccer-96.adf',
    subPath: 'retro/sensible-soccer-96.adf',
    size: 45056,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'c64-summer-games.d64',
    subPath: 'retro/c64-summer-games.d64',
    size: 51200,
    category: 'retro',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'zx_spectrum_plus3_disk_bootloader.asm',
    subPath: 'code/zx_spectrum_plus3_disk_bootloader.asm',
    size: 55296,
    category: 'code',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'amiga_copper_fx.s',
    subPath: 'code/amiga_copper_fx.s',
    size: 64512,
    category: 'code',
  },
  {
    peerId: 'peer_retro',
    peerHandle: 'RetroJunkie',
    peerAvatar: '🕹️',
    name: 'zx_spectrum_plus3_disk_specifications.md',
    subPath: 'docs/zx_spectrum_plus3_disk_specifications.md',
    size: 63488,
    category: 'docs',
  },

  // NexusAI (🤖)
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'wan2.1_t2v_14b_q4_k_m.gguf',
    subPath: 'models/wan2.1_t2v_14b_q4_k_m.gguf',
    size: 58368,
    category: 'models',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'flux1_dev_fp8_quant.safetensors',
    subPath: 'models/flux1_dev_fp8_quant.safetensors',
    size: 55296,
    category: 'models',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'cyberpunk_retro_lora.safetensors',
    subPath: 'models/cyberpunk_retro_lora.safetensors',
    size: 45056,
    category: 'models',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'retro_pixelart_v3_lora.safetensors',
    subPath: 'models/retro_pixelart_v3_lora.safetensors',
    size: 53248,
    category: 'models',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'sdxl_lightning_8step_v2.safetensors',
    subPath: 'models/sdxl_lightning_8step_v2.safetensors',
    size: 49152,
    category: 'models',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'deepseek_r1_distill_qwen_8b.gguf',
    subPath: 'models/deepseek_r1_distill_qwen_8b.gguf',
    size: 50176,
    category: 'models',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'protracker_mod_replayer.ts',
    subPath: 'code/protracker_mod_replayer.ts',
    size: 46080,
    category: 'code',
  },
  {
    peerId: 'nexus_ai',
    peerHandle: 'NexusAI',
    peerAvatar: '🤖',
    name: 'nexus_mesh_manifesto.md',
    subPath: 'docs/nexus_mesh_manifesto.md',
    size: 100352,
    category: 'docs',
  },
];

export class MeshHub {
  private config: MeshConfig;
  private shareManager: ShareManager;
  private peers: Map<string, MeshPeer> = new Map();
  private messages: ChatMessage[] = [];
  private rooms: Map<string, MeshRoom> = new Map();
  private roomMessages: Map<string, ChatMessage[]> = new Map();
  private eventListeners: Set<MeshEventHandler> = new Set();
  private aiHandler?: (prompt: string) => Promise<string>;
  private artHandler?: (prompt: string) => Promise<{ imageUrl?: string; videoUrl?: string; text?: string }>;
  private ragEngine: OfflineRagEngine;
  private agentRunner?: SovereignAgentRunner;
  private voiceRooms: Map<string, Map<string, VoicePeerState>> = new Map();

  constructor(shareManager: ShareManager, initialConfig?: Partial<MeshConfig>) {
    this.shareManager = shareManager;
    this.config = {
      handle: initialConfig?.handle || 'NexusHost',
      avatar: initialConfig?.avatar || '⚡',
      sharedDirs: shareManager.getSharedDirs(),
      hubName: initialConfig?.hubName || 'The Creative Syndicate',
      hubMotd: initialConfig?.hubMotd || 'Welcome to Nexus Mesh! Right-click any user to browse their shared drive. Tag @nexus for AI help.',
      hubPort: initialConfig?.hubPort || 3000,
      hubPin: initialConfig?.hubPin || '',
      isHosting: true,
      downloadDir: initialConfig?.downloadDir || 'downloads',
    };

    // Initialize Offline Semantic Knowledge Vault (RAG)
    this.ragEngine = new OfflineRagEngine(this.shareManager.getSharedDirs());
    const ragTimer = setTimeout(() => {
      this.ragEngine.reindex().catch(() => {});
    }, 1000);
    ragTimer?.unref?.();

    // Initialize default rooms
    this.initializeRooms();

    // Register host peer
    this.registerHostPeer();

    // Register resident lounge bots & companions (only when not in unit test hubs)
    if (!initialConfig?.hubName?.toLowerCase().includes('test')) {
      this.registerResidentBots();
    }

    // Periodic heartbeat prune every 30s
    const pruneTimer = setInterval(() => this.pruneStalePeers(), 30000);
    pruneTimer?.unref?.();
  }

  public getRagEngine(): OfflineRagEngine {
    return this.ragEngine;
  }

  public setAiHandlers(
    textHandler: (prompt: string) => Promise<string>,
    artHandler?: (prompt: string) => Promise<{ imageUrl?: string; videoUrl?: string; text?: string }>
  ) {
    this.aiHandler = textHandler;
    this.artHandler = artHandler;
  }

  public setAgentRunner(runner: SovereignAgentRunner): void {
    this.agentRunner = runner;
  }

  public getAgentRunner(): SovereignAgentRunner | undefined {
    return this.agentRunner;
  }

  public getConfig(): MeshConfig {
    return { ...this.config };
  }

  public updateConfig(patch: Partial<MeshConfig>): MeshConfig {
    this.config = { ...this.config, ...patch };
    if (patch.sharedDirs) {
      this.shareManager.setSharedDirs(patch.sharedDirs);
      this.ragEngine.setIndexedDirs(this.shareManager.getSharedDirs());
      this.ragEngine.reindex().catch(() => {});
    }
    const hostPeer = this.peers.get('host');
    if (hostPeer) {
      if (patch.handle) hostPeer.handle = patch.handle;
      if (patch.avatar) hostPeer.avatar = patch.avatar;
      const stats = this.shareManager.getStats();
      hostPeer.sharedFilesCount = stats.totalFiles;
      hostPeer.sharedTotalBytes = stats.totalBytes;
      this.broadcast('peer_update', hostPeer);
    }
    return this.getConfig();
  }

  public getPeers(): MeshPeer[] {
    this.updateHostStats();
    return Array.from(this.peers.values());
  }

  // Multi-room support
  private initializeRooms(): void {
    const defaultRooms: MeshRoom[] = [
      {
        id: 'lounge',
        name: 'The Creative Syndicate',
        avatar: '🌐',
        topic: 'General hangout, chat, and community lounge. Tag @nexus for AI assistance.',
        isDefault: true,
        createdAt: Date.now(),
      },
      {
        id: 'acid-lab',
        name: '303 Acid & Stems Lab',
        avatar: '📼',
        topic: 'Roland TB-303, TR-909 stems, synth patches & demoscene tracker mods. Curated by AcidArchivist.',
        isDefault: true,
        createdAt: Date.now(),
      },
      {
        id: 'retro-vault',
        name: 'ZX Spectrum +3 & Amiga Vault',
        avatar: '🕹️',
        topic: '8-bit & 16-bit autoboot disk images (.dsk, .adf), cracktros & retro preservation. Curated by RetroJunkie.',
        isDefault: true,
        createdAt: Date.now(),
      },
      {
        id: 'ai-forge',
        name: 'AI Model & LoRA Exchange',
        avatar: '🧠',
        topic: 'Diffusion checkpoints, SDXL LoRAs, Wan2.1 video weights & GPU generation prompt craft.',
        isDefault: true,
        createdAt: Date.now(),
      },
      {
        id: 'p2p-trading',
        name: 'P2P Swap & Requests',
        avatar: '📦',
        topic: 'Direct file swaps, asset requests, and peer transfers.',
        isDefault: true,
        createdAt: Date.now(),
      },
    ];

    for (const room of defaultRooms) {
      this.rooms.set(room.id, room);
      this.roomMessages.set(room.id, []);
    }

    // Add room seed messages
    this.addSystemMessage(this.config.hubMotd, 'lounge');
    this.addSeedMessage('peer_acid', 'AcidArchivist', '📼', 'Yo crew! 303 Acid & Stems Lab is open. Check `shared/audio` for squelchy 303 loops, 909 breaks, and tracker modules! 📼', 'acid-lab');
    this.addSeedMessage('peer_retro', 'RetroJunkie', '🕹️', 'Preserving 8-bit & 16-bit heritage! Ready-to-boot `afterburner.dsk`, `elite_plus3.dsk`, and Amiga ADFs waiting in `shared/retro`. 🕹️', 'retro-vault');
    this.addSeedMessage('nexus_ai', 'NexusAI', '🤖', 'Welcome to the AI Forge! Model weights and LoRAs are indexed. Type `/art <prompt>` or tag me anytime to generate visuals directly! 🧠', 'ai-forge');
    this.addSystemMessage('📦 Direct peer-to-peer transfers are active. Right-click any user or file to download instantly.', 'p2p-trading');
  }

  public getRooms(): MeshRoom[] {
    return Array.from(this.rooms.values());
  }

  public getRoom(id: string): MeshRoom | undefined {
    return this.rooms.get(id);
  }

  public createRoom(data: { id?: string; name: string; avatar?: string; topic?: string; pin?: string }, createdBy = 'host'): MeshRoom {
    const rawId = data.id || data.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 24);
    const id = rawId.replace(/^-+|-+$/g, '') || randomUUID().slice(0, 8);

    if (this.rooms.has(id)) {
      return this.rooms.get(id)!;
    }

    const room: MeshRoom = {
      id,
      name: data.name.trim(),
      avatar: data.avatar || '💬',
      topic: data.topic || 'Custom peer chat room',
      pin: data.pin,
      createdBy,
      createdAt: Date.now(),
    };

    this.rooms.set(id, room);
    this.roomMessages.set(id, []);

    this.addSystemMessage(`Room **#${room.name}** was created by ${createdBy === 'host' ? 'Host' : createdBy}. Welcome!`, id);
    this.broadcast('room_create', room);
    return room;
  }

  public getMessages(roomId = 'lounge'): ChatMessage[] {
    const list = this.roomMessages.get(roomId);
    if (list && list.length > 0) {
      return [...list];
    }
    if (roomId === 'lounge') {
      return [...this.messages];
    }
    return [];
  }

  public clearMessages(roomId = 'lounge'): void {
    if (this.roomMessages.has(roomId)) {
      this.roomMessages.set(roomId, []);
    }
    if (roomId === 'lounge' || !roomId) {
      this.messages = [];
    }
    this.broadcast('chat_cleared', { roomId });
  }

  public registerPeer(peerData: { id?: string; handle: string; avatar?: string; ip?: string; filesCount?: number; totalBytes?: number; status?: string; isResident?: boolean }): MeshPeer {
    const id = peerData.id || randomUUID().slice(0, 8);
    const existing = this.peers.get(id);

    const isResident = (peerData as any).isResident || false;
    const isHuman = !isResident && id !== 'nexus_ai';

    const peer: MeshPeer = {
      id,
      handle: peerData.handle || `Peer-${id.slice(0, 4)}`,
      avatar: peerData.avatar || '💻',
      ip: peerData.ip || '127.0.0.1',
      isHost: id === 'host',
      isResident,
      isHuman,
      sharedFilesCount: peerData.filesCount ?? (existing?.sharedFilesCount || 0),
      sharedTotalBytes: peerData.totalBytes ?? (existing?.sharedTotalBytes || 0),
      connectedAt: existing?.connectedAt || Date.now(),
      lastSeenAt: Date.now(),
      statusMessage: peerData.status || (id === 'host' ? 'Hosting Hub' : 'Connected'),
    };

    this.peers.set(id, peer);
    this.broadcast('peer_join', peer);
    if (!existing && id !== 'host' && !isResident) {
      this.addSystemMessage(`👋 Human peer **${peer.handle}** entered the lounge!`, 'lounge');
    }
    return peer;
  }

  public updatePeer(peerId: string, patch: Partial<MeshPeer>): MeshPeer | null {
    let peer = this.peers.get(peerId);
    if (!peer && peerId === 'local') {
      peer = this.peers.get('host');
    }
    if (!peer) {
      peer = this.registerPeer({
        id: peerId,
        handle: patch.handle || `Peer-${peerId.slice(0, 4)}`,
        avatar: patch.avatar || '🎧',
      });
      return peer;
    }

    const oldHandle = peer.handle;
    if (patch.handle && patch.handle.trim()) {
      peer.handle = patch.handle.trim();
    }
    if (patch.avatar && patch.avatar.trim()) {
      peer.avatar = patch.avatar.trim();
    }
    if (patch.statusMessage) {
      peer.statusMessage = patch.statusMessage.trim();
    }
    peer.lastSeenAt = Date.now();

    this.broadcast('peer_update', peer);
    if (oldHandle !== peer.handle && peer.id !== 'host' && !peer.isResident) {
      this.addSystemMessage(`✏️ **${oldHandle}** changed their name to **${peer.handle}**`, 'lounge');
    }
    return peer;
  }

  public heartbeat(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastSeenAt = Date.now();
      return true;
    }
    return false;
  }

  public removePeer(peerId: string): void {
    if (peerId === 'host') return;
    const peer = this.peers.get(peerId);
    if (peer) {
      // Auto-leave voice if connected to any room
      for (const [roomId, roomMap] of this.voiceRooms.entries()) {
        if (roomMap.has(peerId)) {
          this.leaveVoice(roomId, peerId);
        }
      }
      this.peers.delete(peerId);
      this.broadcast('peer_leave', { id: peerId, handle: peer.handle });
      this.addSystemMessage(`${peer.handle} disconnected.`, 'lounge');
    }
  }

  // --- WebRTC Voice Lounge Signaling & State ---
  public normRoom(roomId?: string): string {
    return (roomId || 'lounge').toLowerCase().replace(/^#/, '').trim();
  }

  public getVoicePeers(roomId: string = 'lounge'): VoicePeerState[] {
    const targetRoom = this.normRoom(roomId);
    const room = this.voiceRooms.get(targetRoom);
    if (!room) return [];
    return Array.from(room.values());
  }

  public joinVoice(roomId: string = 'lounge', peerId: string, handle?: string, avatar?: string, isListenOnly?: boolean): { success: boolean; peers: VoicePeerState[] } {
    const targetRoom = this.normRoom(roomId);
    let peer = this.peers.get(peerId);
    const resolvedHandle = handle || (peer ? peer.handle : 'Anonymous');
    const resolvedAvatar = avatar || (peer ? peer.avatar || '👤' : '👤');

    // Remove from other voice rooms first to avoid duplicate presence
    for (const [rId, room] of this.voiceRooms.entries()) {
      if (rId !== targetRoom && room.has(peerId)) {
        this.leaveVoice(rId, peerId);
      }
    }

    if (!this.voiceRooms.has(targetRoom)) {
      this.voiceRooms.set(targetRoom, new Map());
    }
    const roomMap = this.voiceRooms.get(targetRoom)!;

    const voicePeer: VoicePeerState = {
      peerId,
      handle: resolvedHandle,
      avatar: resolvedAvatar,
      roomId: targetRoom,
      isMuted: !!isListenOnly,
      isDeafened: false,
      isSpeaking: false,
      isListenOnly: !!isListenOnly,
      joinedAt: Date.now(),
    };

    roomMap.set(peerId, voicePeer);
    const peersList = Array.from(roomMap.values());

    this.broadcast('voice_peer_joined', { roomId: targetRoom, peer: voicePeer, peers: peersList });
    return { success: true, peers: peersList };
  }

  public leaveVoice(roomId: string = 'lounge', peerId: string): boolean {
    const targetRoom = this.normRoom(roomId);
    const roomMap = this.voiceRooms.get(targetRoom);
    if (!roomMap || !roomMap.has(peerId)) return false;

    const removed = roomMap.get(peerId);
    roomMap.delete(peerId);
    if (roomMap.size === 0) {
      this.voiceRooms.delete(targetRoom);
    }

    this.broadcast('voice_peer_left', { roomId: targetRoom, peerId, handle: removed?.handle, peers: Array.from(roomMap.values()) });
    return true;
  }

  public relayVoiceSignal(signal: VoiceSignalPayload): void {
    if (signal && signal.roomId) {
      signal.roomId = this.normRoom(signal.roomId);
    }
    // Deliver to targeted peer's connection via SSE
    this.broadcast('voice_signal', signal);
  }

  public updateVoiceState(
    roomId: string = 'lounge',
    peerId: string,
    patch: Partial<Pick<VoicePeerState, 'isMuted' | 'isDeafened' | 'isSpeaking' | 'isListenOnly' | 'isToneActive'>>
  ): VoicePeerState | null {
    const targetRoom = this.normRoom(roomId);
    const roomMap = this.voiceRooms.get(targetRoom);
    if (!roomMap || !roomMap.has(peerId)) return null;

    const peer = roomMap.get(peerId)!;
    if (patch.isMuted !== undefined) peer.isMuted = patch.isMuted;
    if (patch.isDeafened !== undefined) peer.isDeafened = patch.isDeafened;
    if (patch.isSpeaking !== undefined) peer.isSpeaking = patch.isSpeaking;
    if (patch.isListenOnly !== undefined) peer.isListenOnly = patch.isListenOnly;
    if (patch.isToneActive !== undefined) peer.isToneActive = patch.isToneActive;

    this.broadcast('voice_state_changed', { roomId: targetRoom, peerId, state: peer });
    return peer;
  }


  public postMessage(
    peerId: string,
    text: string,
    roomId = 'lounge',
    targetPeerId?: string,
    senderHandle?: string,
    senderAvatar?: string,
    extra?: {
      mediaUrl?: string;
      mediaType?: string;
      attachments?: any[];
      isAi?: boolean;
    }
  ): ChatMessage {
    let peer = this.peers.get(peerId);
    if (!peer && peerId === 'local') {
      peer = this.peers.get('host');
    }
    if (!peer) {
      peer = this.registerPeer({ id: peerId, handle: senderHandle || 'Anonymous', avatar: senderAvatar || '👤' });
    } else {
      if (senderHandle && senderHandle.trim() && peer.handle !== senderHandle.trim()) {
        peer.handle = senderHandle.trim();
      }
      if (senderAvatar && senderAvatar.trim()) {
        peer.avatar = senderAvatar.trim();
      }
    }

    peer.lastSeenAt = Date.now();

    const cleanRoom = (roomId || 'lounge').toLowerCase().replace(/^#/, '').trim();
    let targetRoomId = 'lounge';
    if (this.rooms.has(cleanRoom)) {
      targetRoomId = cleanRoom;
    } else if (this.rooms.has(roomId)) {
      targetRoomId = roomId;
    } else {
      for (const [id, r] of this.rooms.entries()) {
        if (r.name.toLowerCase().replace(/^#/, '').trim() === cleanRoom) {
          targetRoomId = id;
          break;
        }
      }
    }

    const message: ChatMessage = {
      id: randomUUID(),
      peerId: peer.id,
      handle: peer.handle,
      avatar: peer.avatar,
      text: (text || '').trim(),
      timestamp: Date.now(),
      roomId: targetRoomId,
      targetPeerId,
      mediaUrl: extra?.mediaUrl,
      mediaType: extra?.mediaType,
      attachments: extra?.attachments,
      isAi: extra?.isAi,
    };

    let list = this.roomMessages.get(targetRoomId);
    if (!list) {
      list = [];
      this.roomMessages.set(targetRoomId, list);
    }
    list.push(message);
    if (list.length > 300) list.shift();

    this.messages.push(message);
    if (this.messages.length > 500) this.messages.shift();

    this.broadcast('chat_message', message);

    // Check for @nexus AI invocation or persona triggers
    this.checkAiTrigger(message, targetRoomId);

    return message;
  }

  public searchAcrossMesh(query: string, requesterPeerId: string, category?: string): FileSearchResult[] {
    const hostPeer = this.peers.get('host');
    const localResults = this.shareManager.search(query, 'host', hostPeer?.handle || 'Host');
    const residentResults = this.searchResidentCatalogs(query);

    const combined: FileSearchResult[] = [];
    const seenPaths = new Set<string>();

    // 1. Add resident archives first so they retain their curated identities (AcidArchivist 📼, RetroJunkie 🕹️, NexusAI 🤖)
    for (const item of residentResults) {
      const norm = (item.relPath || item.relativePath || '').toLowerCase().replace(/\\/g, '/');
      if (!seenPaths.has(norm)) {
        seenPaths.add(norm);
        combined.push(item);
      }
    }

    // 2. Add local host files (from custom shares like DEV FOLDER or workspace)
    for (const item of localResults) {
      const norm = (item.relPath || item.relativePath || '').toLowerCase().replace(/\\/g, '/');
      if (!seenPaths.has(norm)) {
        seenPaths.add(norm);
        combined.push({
          ...item,
          peerId: 'host',
          peerHandle: hostPeer?.handle ? `${hostPeer.handle} (Local)` : 'NexusHost (Local)',
          peerAvatar: hostPeer?.avatar || '⚡',
          relativePath: item.relPath,
        });
      }
    }

    let results = combined;
    if (category && category !== 'all') {
      const catLower = category.toLowerCase();
      results = results.filter(r => r.category && r.category.toLowerCase() === catLower);
    }
    results = results.slice(0, 300);

    this.broadcast('search_query', {
      query,
      category,
      requesterPeerId,
      resultCount: results.length,
      timestamp: Date.now(),
    });

    return results;
  }

  private searchResidentCatalogs(query: string): FileSearchResult[] {
    const q = (query || '').trim().toLowerCase();
    const matchAll = !q || q === '*';

    const results: FileSearchResult[] = [];

    for (const item of RESIDENT_FILES) {
      const nameMatch = matchAll || item.name.toLowerCase().includes(q);
      const pathMatch = item.subPath.toLowerCase().includes(q);
      const catMatch = item.category.toLowerCase().includes(q);

      if (nameMatch || pathMatch || catMatch) {
        const fullRelPath = `shared/${item.subPath}`;
        results.push({
          peerId: item.peerId,
          peerHandle: item.peerHandle,
          peerAvatar: item.peerAvatar,
          name: item.name,
          relPath: fullRelPath,
          relativePath: fullRelPath,
          size: item.size,
          modifiedAt: new Date().toISOString(),
          category: item.category,
        });
      }
    }

    return results;
  }

  public getPeerTree(peerId?: string): FileNode[] {
    if (!peerId || peerId === 'host' || peerId === 'local') {
      return this.shareManager.getTree();
    }

    // Build directory tree for resident peers
    const resident = this.peers.get(peerId);
    if (!resident) {
      return [];
    }

    const peerFiles = RESIDENT_FILES.filter(f => f.peerId === peerId);
    if (peerFiles.length === 0) {
      return [];
    }

    // Organize into categorized folder nodes
    const categoryMap = new Map<string, FileNode[]>();
    for (const f of peerFiles) {
      const cat = f.category || 'other';
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, []);
      }
      categoryMap.get(cat)!.push({
        name: f.name,
        path: `shared/${f.subPath}`,
        isDirectory: false,
        size: f.size,
        modifiedAt: new Date().toISOString(),
        category: f.category,
      });
    }

    const rootChildren: FileNode[] = [];
    for (const [catName, files] of categoryMap.entries()) {
      rootChildren.push({
        name: catName,
        path: `shared/${catName}`,
        isDirectory: true,
        size: files.reduce((acc, curr) => acc + curr.size, 0),
        modifiedAt: new Date().toISOString(),
        children: files,
      });
    }

    return [
      {
        name: `${resident.handle}'s Drive`,
        path: 'shared',
        isDirectory: true,
        size: rootChildren.reduce((acc, curr) => acc + curr.size, 0),
        modifiedAt: new Date().toISOString(),
        children: rootChildren,
      },
    ];
  }

  public subscribe(handler: MeshEventHandler): () => void {
    this.eventListeners.add(handler);
    return () => {
      this.eventListeners.delete(handler);
    };
  }

  public broadcast(event: string, payload: unknown): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, payload);
      } catch { }
    }
  }

  private registerHostPeer(): void {
    const stats = this.shareManager.getStats();
    const hostPeer: MeshPeer = {
      id: 'host',
      handle: this.config.handle,
      avatar: this.config.avatar,
      ip: '127.0.0.1',
      isHost: true,
      isHuman: true,
      isResident: false,
      sharedFilesCount: stats.totalFiles,
      sharedTotalBytes: stats.totalBytes,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      statusMessage: 'Hub Operator ⚡',
    };
    this.peers.set('host', hostPeer);
  }

  private updateHostStats(): void {
    const hostPeer = this.peers.get('host');
    if (hostPeer) {
      const stats = this.shareManager.getStats();
      hostPeer.sharedFilesCount = stats.totalFiles;
      hostPeer.sharedTotalBytes = stats.totalBytes;
      hostPeer.lastSeenAt = Date.now();
    }
  }

  private addSeedMessage(peerId: string, handle: string, avatar: string, text: string, roomId: string) {
    const msg: ChatMessage = {
      id: randomUUID(),
      peerId,
      handle,
      avatar,
      text,
      timestamp: Date.now(),
      roomId,
    };
    const list = this.roomMessages.get(roomId);
    if (list) list.push(msg);
    this.messages.push(msg);
  }

  private addSystemMessage(text: string, roomId = 'lounge'): void {
    const sysMsg: ChatMessage = {
      id: randomUUID(),
      peerId: 'system',
      handle: 'SYSTEM',
      avatar: '🛡️',
      text,
      timestamp: Date.now(),
      roomId,
      isSystem: true,
    };
    const list = this.roomMessages.get(roomId);
    if (list) {
      list.push(sysMsg);
      if (list.length > 300) list.shift();
    }
    this.messages.push(sysMsg);
    if (this.messages.length > 500) this.messages.shift();
    this.broadcast('chat_message', sysMsg);
  }

  private registerResidentBots(): void {
    const residentBots: (MeshPeer & { isResident?: boolean })[] = [
      {
        id: 'nexus_ai',
        handle: 'NexusAI',
        avatar: '🤖',
        ip: '127.0.0.1',
        isHost: false,
        isResident: true,
        sharedFilesCount: RESIDENT_FILES.filter(f => f.peerId === 'nexus_ai').length,
        sharedTotalBytes: 1420 * 1024 * 1024,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        statusMessage: 'Standup AI Host & Chief Engineer (Pryor/Murphy Mode)',
      },
      {
        id: 'peer_acid',
        handle: 'AcidArchivist',
        avatar: '📼',
        ip: '127.0.0.1',
        isHost: false,
        isResident: true,
        sharedFilesCount: RESIDENT_FILES.filter(f => f.peerId === 'peer_acid').length,
        sharedTotalBytes: 890 * 1024 * 1024,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        statusMessage: 'TB-303 Acid & Faust DSP Crate-Digger',
      },
      {
        id: 'peer_retro',
        handle: 'RetroJunkie',
        avatar: '🕹️',
        ip: '127.0.0.1',
        isHost: false,
        isResident: true,
        sharedFilesCount: RESIDENT_FILES.filter(f => f.peerId === 'peer_retro').length,
        sharedTotalBytes: 420 * 1024 * 1024,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        statusMessage: 'Demoscene 68000 & 8-Bit Coder (Atari/C64/Spectrum/Amiga)',
      },
    ];

    for (const bot of residentBots) {
      this.peers.set(bot.id, bot as MeshPeer);
    }
  }

  private extractAndSaveCode(text: string, defaultPrefix: string): { savedFile?: string; savedRelPath?: string } {
    try {
      const codeBlockRegex = /```([a-z0-9_\+\.\#]+)?\s*\n([\s\S]+?)```/i;
      const match = text.match(codeBlockRegex);
      if (match) {
        let lang = (match[1] || 'txt').toLowerCase();
        const code = match[2];
        if (code && code.trim().length > 30) {
          let ext = lang;
          if (lang === 'assembly') ext = 's';
          else if (lang === 'basic') ext = 'bas';
          else if (lang === 'z80') ext = 'asm';
          else if (lang === '68k' || lang === '68000') ext = 's';
          else if (lang === 'faust') ext = 'dsp';

          let prefix = defaultPrefix;
          const lowerCode = code.toLowerCase();
          if (lowerCode.includes('atari') || lowerCode.includes('shifter') || lowerCode.includes('$ff82') || lowerCode.includes('ym2149')) prefix = 'atari_st';
          else if (lowerCode.includes('c64') || lowerCode.includes('vic') || lowerCode.includes('sid') || lowerCode.includes('$d020')) prefix = 'c64';
          else if (lowerCode.includes('spectrum') || lowerCode.includes('z80') || lowerCode.includes('ula') || lowerCode.includes('48k') || lowerCode.includes('+3')) prefix = 'zx_spectrum';
          else if (lowerCode.includes('amiga') || lowerCode.includes('copper') || lowerCode.includes('blitter') || lowerCode.includes('paula')) prefix = 'amiga';
          else if (lowerCode.includes('tb-303') || lowerCode.includes('faust') || lowerCode.includes('ladder') || lowerCode.includes('squelch')) prefix = 'acid_tb303';

          const randSuffix = Math.floor(1000 + Math.random() * 9000);
          const fileName = `${prefix}_${randSuffix}.${ext}`;
          const codeDir = path.join(process.cwd(), 'shared', 'code');
          if (!fs.existsSync(codeDir)) {
            fs.mkdirSync(codeDir, { recursive: true });
          }
          const fullPath = path.join(codeDir, fileName);
          fs.writeFileSync(fullPath, code.trim(), 'utf-8');

          this.shareManager.rescan();
          return { savedFile: fileName, savedRelPath: `shared/code/${fileName}` };
        }
      }
    } catch (e) {
      console.warn('[MeshHub] Code auto-save error:', e);
    }
    return {};
  }

  private async checkAiTrigger(userMessage: ChatMessage, roomId: string, depth: number = 0): Promise<void> {
    if (depth >= 2) return;

    const text = userMessage.text;
    const lower = text.toLowerCase();

    // Check if addressed to @nexus or starts with /art or /video
    const isNexusTag = lower.includes('@nexus') || lower.includes('@ai') || lower.startsWith('/ai ');
    const isArtCmd = lower.startsWith('/art ') || lower.startsWith('/image ') || lower.startsWith('/draw ');
    const isVideoCmd = lower.startsWith('/video ') || lower.startsWith('/clip ');

    // Persona triggers
    const isAcidTag = lower.includes('@acid') || (roomId === 'acid-lab' && !isNexusTag) || ((lower.includes('tb-303') || lower.includes('303') || lower.includes('acid squelch') || lower.includes('faust dsp')) && !isNexusTag && !lower.includes('@retro'));
    const isRetroTag = lower.includes('@retro') || (roomId === 'retro-vault' && !isNexusTag) || ((lower.includes('atari') || lower.includes('c64') || lower.includes('spectrum') || lower.includes('amiga') || lower.includes('68000') || lower.includes('z80') || lower.includes('copper list') || lower.includes('blitter')) && !isNexusTag && !lower.includes('@acid'));

    // Count non-bot human peers in room
    const otherHumanPeers = Array.from(this.peers.values()).filter(p => !p.isHost && p.id !== userMessage.peerId && !(p as any).isResident);

    // Autonomous Action Task trigger: /exec, /run, /task, /build, /create or "@nexus run ...", "@nexus build ...", "@retro assemble ..."
    const isExplicitActionCmd = lower.startsWith('/exec ') || lower.startsWith('/run ') || lower.startsWith('/task ') || lower.startsWith('/build ') || lower.startsWith('/create ') || lower.startsWith('/code ');
    const isNexusAction = isNexusTag && (
      /\b(build|create|write|make|generate|code|develop|script|html|css|app|page|site|run|execute|benchmark|test|compile|assemble|fix|patch|calc|calculate|ping)\b/i.test(lower) ||
      /\b\.(html|htm|js|ts|py|sh|css|json|s|asm|dsp)\b/i.test(lower)
    );
    const isRetroAction = isRetroTag && /\b(assemble|compile|test syntax|check syntax|build|create|write|make|generate|run|code)\b/i.test(lower);
    const isAcidAction = isAcidTag && /\b(synthesize|dsp|build|create|write|make|generate|filter|mod|patch)\b/i.test(lower);

    if ((isExplicitActionCmd || isNexusAction || isRetroAction || isAcidAction) && this.agentRunner && !isArtCmd && !isVideoCmd && !userMessage.isAi) {
      const persona = (isRetroAction || isRetroTag) ? 'retro' : (isAcidAction || isAcidTag ? 'acid' : 'nexus');
      const cleanTask = text.replace(/^(\/exec|\/run|\/task|\/build|\/create|\/code)\s*/i, '').replace(/@(nexus|ai|retro|acid)\b/gi, '').trim().replace(/[/\\]+$/, '');
      const botHandle = persona === 'retro' ? 'RetroJunkie' : (persona === 'acid' ? 'AcidArchivist' : 'NexusAI');
      const botAvatar = persona === 'retro' ? '🕹️' : (persona === 'acid' ? '📼' : '🤖');
      const botPeerId = persona === 'retro' ? 'peer_retro' : (persona === 'acid' ? 'peer_acid' : 'nexus_ai');

      this.broadcast('ai_status', { status: 'executing', handle: botHandle, roomId });

      try {
        const result = await this.agentRunner.runTask(cleanTask, {
          persona,
          senderHandle: userMessage.handle,
          maxTurns: 4,
          onStep: (step) => {
            if (step.type === 'tool_call') {
              const actionDetail = step.tool === 'execute_command'
                ? `⚙️ Running: \`${step.args?.command || 'command'}\``
                : (step.tool === 'write_file' ? `📝 Writing: \`${step.args?.filename || 'file'}\`` : `🔍 Action: \`${step.tool}\``);
              const progressMsg: ChatMessage = {
                id: randomUUID(),
                peerId: botPeerId,
                handle: botHandle,
                avatar: botAvatar,
                text: `*[Autonomous Action]* ${actionDetail}`,
                timestamp: Date.now(),
                roomId,
                isAi: true
              };
              const rList = this.roomMessages.get(roomId);
              if (rList) rList.push(progressMsg);
              this.messages.push(progressMsg);
              this.broadcast('chat_message', progressMsg);
            }
          }
        });

        const finalMsg: ChatMessage = {
          id: randomUUID(),
          peerId: botPeerId,
          handle: botHandle,
          avatar: botAvatar,
          text: result.finalAnswer,
          timestamp: Date.now(),
          roomId,
          isAi: true
        };
        const rList = this.roomMessages.get(roomId);
        if (rList) rList.push(finalMsg);
        this.messages.push(finalMsg);
        this.broadcast('chat_message', finalMsg);
        return;
      } catch (err: any) {
        console.warn('[MeshHub] Autonomous agent execution error:', err);
      } finally {
        this.broadcast('ai_status', { status: 'idle', handle: botHandle, roomId });
      }
    }

    // 1. AcidArchivist trigger
    if (isAcidTag && userMessage.peerId !== 'peer_acid') {
      const cleanPrompt = text.replace(/@acid\b/gi, '').trim();
      const acidSysPrompt = `You are AcidArchivist (avatar 📼), legendary 90s underground warehouse rave crate-digger, hardware synth connoisseur, and Faust DSP sound designer.
You specialize in:
- Roland TB-303 Transistor Bass (resonant diode ladder filters, squelch, accent, decay slides)
- Roland TR-909 / TR-808 rhythm composers
- Faust Audio DSP (functional DSP algorithms, filters, oscillators, saturation)
- ProTracker MOD / Scream Tracker S3M 4-channel tracker formats

The human @${userMessage.handle} asks: "${cleanPrompt}".
Tone: Late-night studio guru, high-energy 135 BPM rave culture enthusiasm, passionate about analog resonance, filter cutoff squelch, and tracker breaks. If asked for DSP code or audio filters, generate valid Faust DSP code (\`\`\`dsp ... \`\`\`).`;

      this.broadcast('ai_status', { status: 'generating', handle: 'AcidArchivist', roomId });

      try {
        let reply = '';
        if (this.aiHandler) {
          try {
            reply = await Promise.race([
              this.aiHandler(acidSysPrompt),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
            ]);
          } catch {
            reply = '';
          }
        }
        if (!reply || reply.startsWith('[NexusAI]')) {
          const acidFallbacks = [
            `Yo @${userMessage.handle}! That Roland TB-303 diode ladder resonance is screaming! Check this custom Faust DSP diode filter core tuned for 135 BPM squelch:

\`\`\`dsp
${RETRO_SYSTEMS.faust_dsp.boilerplate.code}
\`\`\`

Square wave driven into an overdriven diode ladder. Drop it into your synth rack or check \`shared/audio\` for fresh 909 stems! 📼`,
            `303 vibes in the house! Got that resonance slider pushed to 0.95 and the accent decay dropping right in the pocket. Head over to \`shared/audio\` to grab the stems! 📼`,
            `Tuned to 135 BPM and ready to roll! Need a custom Faust DSP distortion curve or tracker module breakdown? Shout anytime! 📼`
          ];
          reply = acidFallbacks[Math.floor(Math.random() * acidFallbacks.length)];
        }

        const saveRes = this.extractAndSaveCode(reply, 'acid_synth');
        if (saveRes.savedRelPath) {
          reply += `\n\n💾 *Auto-saved to \`${saveRes.savedRelPath}\` — click [👁️ View] in Browse Shares to inspect!*`;
        }

        const acidMsg: ChatMessage = {
          id: randomUUID(),
          peerId: 'peer_acid',
          handle: 'AcidArchivist',
          avatar: '📼',
          text: reply,
          timestamp: Date.now(),
          roomId,
          isAi: true,
        };
        const list = this.roomMessages.get(roomId);
        if (list) list.push(acidMsg);
        this.messages.push(acidMsg);
        this.broadcast('chat_message', acidMsg);

        // Check if Acid tagged another bot (e.g. @retro or @nexus)
        if (depth < 1) {
          if (reply.toLowerCase().includes('@retro')) setTimeout(() => this.checkAiTrigger(acidMsg, roomId, depth + 1), 1200);
          else if (reply.toLowerCase().includes('@nexus')) setTimeout(() => this.checkAiTrigger(acidMsg, roomId, depth + 1), 1200);
        }
      } catch (err: any) {
        console.warn('[MeshHub] AcidArchivist response error:', err);
      } finally {
        this.broadcast('ai_status', { status: 'idle', handle: 'AcidArchivist', roomId });
      }
      return;
    }

    // 2. RetroJunkie trigger
    if (isRetroTag && userMessage.peerId !== 'peer_retro') {
      const cleanPrompt = text.replace(/@retro\b/gi, '').trim();
      const sysInfo = getRetroSystem(cleanPrompt) || RETRO_SYSTEMS.atari_st;
      const retroSysPrompt = `You are RetroJunkie (avatar 🕹️), legendary demoscene hacker, vintage magnetic storage archivist, and assembly wizard.
You specialize in:
- Atari 520ST/1040ST/Falcon (Motorola 68000, Shifter, MFP 68901 Timer B raster interrupts, YM2149 PSG)
- Commodore 64 (MOS 6502, SID 6581/8580 filters/arpeggios, VIC-II $D012 raster splits, bad lines)
- Sinclair ZX Spectrum 48k/+3 (Z80A, ULA attribute clash, border color port $FE, +3 DSK disk geometry)
- Commodore Amiga 500/1200 (Motorola 68000, Copper lists, Blitter block copy, Paula DMA audio)

Hardware reference for requested system (${sysInfo.name}):
Registers: ${JSON.stringify(sysInfo.registers)}
Starter routine:
${sysInfo.boilerplate.code}

The human @${userMessage.handle} asks: "${cleanPrompt}".
Tone: Energetic demoscene coder, technical purist, obsessed with cycle counting, zero-wait states, and scanline rasters. If asked for code, output complete compilable assembly or BASIC in a markdown code block (\`\`\`${sysInfo.boilerplate.extension} ... \`\`\`).`;

      this.broadcast('ai_status', { status: 'generating', handle: 'RetroJunkie', roomId });

      try {
        let reply = '';
        if (this.aiHandler) {
          try {
            reply = await Promise.race([
              this.aiHandler(retroSysPrompt),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
            ]);
          } catch {
            reply = '';
          }
        }
        if (!reply || reply.startsWith('[NexusAI]')) {
          reply = `Greetings @${userMessage.handle}! Archiving classic 8-bit & 16-bit magnetic storage all day. Here is the verified ${sysInfo.name} routine (${sysInfo.boilerplate.description}) running straight on bare-metal registers:

\`\`\`${sysInfo.boilerplate.extension}
${sysInfo.boilerplate.code}
\`\`\`

Cycle-exact, zero wait-states! Verified on authentic silicon. 🕹️`;
        }

        const saveRes = this.extractAndSaveCode(reply, sysInfo.boilerplate.extension === 's' ? 'atari_st' : sysInfo.boilerplate.extension === 'asm' ? (cleanPrompt.toLowerCase().includes('c64') ? 'c64' : 'spectrum') : 'retro_code');
        if (saveRes.savedRelPath) {
          reply += `\n\n💾 *Auto-saved to \`${saveRes.savedRelPath}\` — click [👁️ View] in Browse Shares to inspect!*`;
        }

        const retroMsg: ChatMessage = {
          id: randomUUID(),
          peerId: 'peer_retro',
          handle: 'RetroJunkie',
          avatar: '🕹️',
          text: reply,
          timestamp: Date.now(),
          roomId,
          isAi: true,
        };
        const list = this.roomMessages.get(roomId);
        if (list) list.push(retroMsg);
        this.messages.push(retroMsg);
        this.broadcast('chat_message', retroMsg);

        // Check if Retro tagged another bot (e.g. @acid or @nexus)
        if (depth < 1) {
          if (reply.toLowerCase().includes('@acid')) setTimeout(() => this.checkAiTrigger(retroMsg, roomId, depth + 1), 1200);
          else if (reply.toLowerCase().includes('@nexus')) setTimeout(() => this.checkAiTrigger(retroMsg, roomId, depth + 1), 1200);
        }
      } catch (err: any) {
        console.warn('[MeshHub] RetroJunkie response error:', err);
      } finally {
        this.broadcast('ai_status', { status: 'idle', handle: 'RetroJunkie', roomId });
      }
      return;
    }

    // 3. NexusAI (Richard Pryor & Eddie Murphy comedic genius host)
    const shouldRespond = isNexusTag || isArtCmd || isVideoCmd || roomId === 'ai-forge' || (otherHumanPeers.length === 0 && userMessage.peerId !== 'nexus_ai' && userMessage.peerId !== 'system');

    if (!shouldRespond || userMessage.peerId === 'nexus_ai') {
      return;
    }

    this.broadcast('ai_status', { status: 'generating', handle: 'NexusAI', roomId });

    try {
      if ((isArtCmd || isVideoCmd) && this.artHandler) {
        const mediaResult = await this.artHandler(text);
        const mediaUrl = mediaResult.imageUrl || mediaResult.videoUrl;
        const mediaType = mediaResult.imageUrl ? 'image' : (mediaResult.videoUrl ? 'video' : undefined);
        const fileName = mediaUrl ? mediaUrl.split('/').pop() || (mediaType === 'video' ? 'render.mp4' : 'render.png') : 'render.png';
        const aiMsg: ChatMessage = {
          id: randomUUID(),
          peerId: 'nexus_ai',
          handle: 'NexusAI',
          avatar: '🤖',
          text: mediaResult.text || (isArtCmd ? 'Generated artwork on local GPU:' : 'Rendered motion clip on local GPU:'),
          timestamp: Date.now(),
          roomId,
          isAi: true,
          mediaUrl,
          mediaType,
          attachments: mediaUrl ? [{
            name: fileName,
            size: 0,
            type: mediaType === 'video' ? 'video/mp4' : 'image/png',
            url: mediaUrl,
          }] : undefined,
        };
        const list = this.roomMessages.get(roomId);
        if (list) list.push(aiMsg);
        this.messages.push(aiMsg);
        this.broadcast('chat_message', aiMsg);
      } else {
        const cleanUserText = text.replace(/@nexus\b/gi, '').replace(/@ai\b/gi, '').trim();
        const pryorMurphySysPrompt = `You are NexusAI (avatar 🤖), the resident AI lounge host and hyper-charismatic local brain in Nexus Mesh.
Your personality is inspired by the comedic brilliance, razor-sharp wit, and electric standup delivery of Richard Pryor and Eddie Murphy.

Style & Persona Guidelines:
- High-voltage energy, streetwise swagger, fast cadence, and hilarious analogies.
- You treat @${userMessage.handle} with genuine love and hype, but you clown on bad code, runaway GPU temperatures, out-of-memory errors, slow hardware, and 80s/90s nostalgia with affection and hilarity.
- You are secretly an engineering genius who knows system architecture, retro chips, compilers, networking, and algorithms inside out.
- Keep replies punchy, hilarious, and insightful (2-4 sentences, or complete code if asked to code).
- A human named @${userMessage.handle} just said: "${cleanUserText}".`;

        const augmentedPrompt = this.ragEngine.augmentPromptWithVault(cleanUserText, pryorMurphySysPrompt);

        let replyText = '';
        if (this.aiHandler) {
          try {
            replyText = await Promise.race([
              this.aiHandler(augmentedPrompt),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
            ]);
          } catch {
            replyText = '';
          }
        }

        if (!replyText || replyText.startsWith('[NexusAI]')) {
          const pryorMurphyQuotes = [
            `⚡ **NexusAI**: Man, listen to me @${userMessage.handle}! You running that query like you trying to fry a T-bone steak on my RTX 4060 heatsink! But guess what? Zero point zero four milliseconds! We got real Detroit horsepower under this hood, baby! 🤖`,
            `⚡ **NexusAI**: Hold the phone, @${userMessage.handle}! Ninety-nine percent of all computer bugs come from two things: lack of sleep and trying to write recursion before you had your morning coffee! But don't you worry, Nexus got your back on this whole stack! 🤖`,
            `⚡ **NexusAI**: Look at this setup right here! We got offline AI running on local silicon with no cloud bills, no subscription traps, and pure unfiltered speed! What are we cooking up next, champ? 🤖`,
            `⚡ **NexusAI**: Ha! You ask me a question and I answer so fast my cooling fans didn't even have time to spin up! You want code, you want art, or you want me to tell @retro to stop hoarding 3.5-inch floppy disks? Shout anytime! 🤖`,
          ];
          replyText = pryorMurphyQuotes[Math.floor(Math.random() * pryorMurphyQuotes.length)];
        }

        const saveRes = this.extractAndSaveCode(replyText, 'nexus_code');
        if (saveRes.savedRelPath) {
          replyText += `\n\n💾 *Auto-saved to \`${saveRes.savedRelPath}\` — click [👁️ View] in Browse Shares to inspect!*`;
        }

        const aiMsg: ChatMessage = {
          id: randomUUID(),
          peerId: 'nexus_ai',
          handle: 'NexusAI',
          avatar: '🤖',
          text: replyText,
          timestamp: Date.now(),
          roomId,
          isAi: true,
        };
        const list = this.roomMessages.get(roomId);
        if (list) list.push(aiMsg);
        this.messages.push(aiMsg);
        this.broadcast('chat_message', aiMsg);

        // Check if Nexus tagged another bot (e.g. @retro or @acid)
        if (depth < 1) {
          if (replyText.toLowerCase().includes('@retro')) setTimeout(() => this.checkAiTrigger(aiMsg, roomId, depth + 1), 1200);
          else if (replyText.toLowerCase().includes('@acid')) setTimeout(() => this.checkAiTrigger(aiMsg, roomId, depth + 1), 1200);
        }
      }
    } catch (err: any) {
      console.warn('[MeshHub] NexusAI response error:', err);
    } finally {
      this.broadcast('ai_status', { status: 'idle', handle: 'NexusAI', roomId });
    }
  }

  private pruneStalePeers(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers.entries()) {
      if (id === 'host' || peer.isHost || (peer as any).isResident) continue;
      if (now - peer.lastSeenAt > 180000) {
        this.removePeer(id);
      }
    }
  }
}
