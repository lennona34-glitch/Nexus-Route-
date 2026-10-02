/**
 * Nexus Mesh Types & Interfaces
 * Pure native peer-to-peer / hub community layer for Nexus Route
 */

export interface MeshPeer {
  id: string;
  handle: string;
  avatar?: string;
  ip?: string;
  port?: number;
  isHost?: boolean;
  isResident?: boolean;
  isHuman?: boolean;
  sharedFilesCount: number;
  sharedTotalBytes: number;
  connectedAt: number;
  lastSeenAt: number;
  pingMs?: number;
  statusMessage?: string;
}

export interface MeshRoom {
  id: string;
  name: string;
  avatar: string;
  topic: string;
  isDefault?: boolean;
  pin?: string;
  createdBy?: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  peerId: string;
  handle: string;
  avatar?: string;
  text: string;
  timestamp: number;
  roomId?: string;
  isSystem?: boolean;
  isAi?: boolean;
  targetPeerId?: string; // If private message
  mediaUrl?: string;
  mediaType?: string;
  attachments?: ChatAttachment[];
}

export interface ChatAttachment {
  name: string;
  size: number;
  type: string;
  url?: string;
}

export interface FileNode {
  name: string;
  path: string; // Relative path inside share root
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  category?: 'models' | 'loras' | 'audio' | 'retro' | 'code' | 'docs' | 'image' | 'video' | 'other';
  children?: FileNode[];
}

export interface FileSearchResult {
  peerId: string;
  peerHandle: string;
  peerAvatar?: string;
  name: string;
  relPath: string;
  relativePath?: string; // Alias for relPath for frontend compatibility
  size: number;
  modifiedAt: string;
  category: string;
}

export interface TransferItem {
  id: string;
  peerId: string;
  peerHandle: string;
  fileName: string;
  relPath: string;
  direction: 'download' | 'upload';
  totalBytes: number;
  transferredBytes: number;
  speedBps: number;
  status: 'queued' | 'transferring' | 'completed' | 'failed' | 'paused';
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface MeshConfig {
  handle: string;
  avatar?: string;
  sharedDirs: string[];
  hubName: string;
  hubMotd: string;
  hubPort: number;
  hubPin?: string;
  isHosting: boolean;
  remoteHubUrl?: string;
  downloadDir: string;
}

export interface VoicePeerState {
  peerId: string;
  handle: string;
  avatar: string;
  roomId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  isListenOnly?: boolean;
  isToneActive?: boolean;
  joinedAt: number;
}

export interface VoiceSignalPayload {
  fromPeerId: string;
  toPeerId: string;
  roomId: string;
  signalType: 'offer' | 'answer' | 'candidate';
  data: any;
}
