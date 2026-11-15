import fs from 'fs';
import path from 'path';
import type { GameRoom, ServerPlayerState } from './types.js';

export const RESTORED_ROOM_TTL_MS = 5 * 60 * 1000;

interface PersistedRoomsFile {
  savedAt: number;
  rooms: Array<Omit<GameRoom, 'clients' | 'events'>>;
}

export class RoomPersistence {
  private readonly snapshotPath: string;
  private isSaving = false;
  private lastSavedHadRooms = false;

  constructor(snapshotPath: string) {
    this.snapshotPath = snapshotPath;
  }

  private serialize(rooms: Map<string, GameRoom>): string {
    const list: Array<Omit<GameRoom, 'clients' | 'events'>> = [];
    for (const room of rooms.values()) {
      const { clients: _c, events: _e, ...rest } = room;
      list.push(rest);
    }
    const payload: PersistedRoomsFile = { savedAt: Date.now(), rooms: list };
    return JSON.stringify(payload);
  }

  async save(rooms: Map<string, GameRoom>): Promise<void> {
    if (this.isSaving) return;
    if (rooms.size === 0 && !this.lastSavedHadRooms) return;
    this.isSaving = true;
    try {
      await fs.promises.mkdir(path.dirname(this.snapshotPath), { recursive: true });
      const tmpPath = `${this.snapshotPath}.tmp`;
      await fs.promises.writeFile(tmpPath, this.serialize(rooms), 'utf8');
      await fs.promises.rename(tmpPath, this.snapshotPath);
      this.lastSavedHadRooms = rooms.size > 0;
    } catch (err) {
      console.error('Failed to save rooms snapshot:', err);
    } finally {
      this.isSaving = false;
    }
  }

  saveSync(rooms: Map<string, GameRoom>): void {
    try {
      fs.mkdirSync(path.dirname(this.snapshotPath), { recursive: true });
      const tmpPath = `${this.snapshotPath}.tmp`;
      fs.writeFileSync(tmpPath, this.serialize(rooms), 'utf8');
      fs.renameSync(tmpPath, this.snapshotPath);
    } catch (err) {
      console.error('Failed to save rooms snapshot on shutdown:', err);
    }
  }

  loadInto(rooms: Map<string, GameRoom>): void {
    if (!fs.existsSync(this.snapshotPath)) return;
    try {
      const raw = fs.readFileSync(this.snapshotPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedRoomsFile;
      if (!parsed || !Array.isArray(parsed.rooms)) return;
      const now = Date.now();
      for (const saved of parsed.rooms) {
        if (!saved || !saved.id) continue;
        if (now - (parsed.savedAt || 0) > RESTORED_ROOM_TTL_MS) continue;
        const players: [ServerPlayerState | null, ServerPlayerState | null] = [
          saved.players?.[0] || null,
          saved.players?.[1] || null
        ];
        for (const p of players) {
          if (p && !p.isBot) {
            p.awaitingReconnect = true;
          }
        }
        rooms.set(saved.id, {
          ...saved,
          clients: [],
          events: [],
          players,
          projectiles: Array.isArray(saved.projectiles) ? saved.projectiles : [],
          restoredAt: now
        });
      }
      if (rooms.size > 0) {
        this.lastSavedHadRooms = true;
        console.log(`Restored ${rooms.size} room(s) from snapshot.`);
      }
    } catch (err) {
      console.error('Failed to load rooms snapshot:', err);
    }
  }
}
