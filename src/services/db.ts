/**
 * User Profile & Free Database Service for Checkmate Arena.
 * Features:
 * - Offline-first persistent storage via LocalStorage / IndexedDB.
 * - Integration with Free Cloud Database (Firebase Realtime Database REST / Supabase REST).
 * - Tracks user profile, virtual coin wallet (starts with 1,000 free coins), ELO rating,
 *   match history, and 24-hour daily coin bonus.
 */

export interface MatchRecord {
  id: string;
  timestamp: number;
  mode: string;
  opponent: string;
  result: 'win' | 'loss' | 'draw';
  reason: string;
  movesCount: number;
  timeControl: string;
  coinChange: number;
  ratingChange: number;
}

export interface UserStats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winStreak: number;
  bestWinStreak: number;
}

export interface CloudDbConfig {
  provider: 'firebase' | 'supabase' | 'custom';
  endpointUrl: string; // e.g. https://your-free-project-default-rtdb.firebaseio.com/
  apiKey?: string;
  autoSync: boolean;
}

export interface UserProfile {
  uid: string;
  username: string;
  displayName: string;
  avatar: string;
  coins: number;
  rating: number;
  createdAt: number;
  lastLogin: number;
  lastDailyBonusClaimed: number;
  stats: UserStats;
  history: MatchRecord[];
  cloudConfig: CloudDbConfig;
}

const STORAGE_KEY = 'ca-user-profile';

// Default free cloud endpoint fallback (Firebase Realtime Database public REST endpoint)
const DEFAULT_FREE_DB_URL = 'https://checkmate-arena-default-rtdb.firebaseio.com';

function generateUid(): string {
  return 'user_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

const INITIAL_PROFILE: UserProfile = {
  uid: generateUid(),
  username: 'Grandmaster',
  displayName: 'Grandmaster Player',
  avatar: 'wk',
  coins: 1000, // 1,000 free coins on signup (Stage 2 roadmap requirement)
  rating: 1200,
  createdAt: Date.now(),
  lastLogin: Date.now(),
  lastDailyBonusClaimed: 0,
  stats: {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winStreak: 0,
    bestWinStreak: 0,
  },
  history: [],
  cloudConfig: {
    provider: 'firebase',
    endpointUrl: DEFAULT_FREE_DB_URL,
    autoSync: true,
  },
};

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const memoryStorage = new MemoryStorage();

export function getStorage() {
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  return memoryStorage;
}

export class DatabaseService {
  private static instance: DatabaseService;
  private profile: UserProfile;
  private syncListeners = new Set<(synced: boolean, error?: string) => void>();
  private isSyncing = false;

  private constructor() {
    this.profile = this.loadLocalProfile();
    // Update last login
    this.profile.lastLogin = Date.now();
    this.saveLocalProfile();
    // Proactively perform background cloud sync if enabled
    if (this.profile.cloudConfig.autoSync) {
      void this.syncToCloud();
    }
  }

  static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  private loadLocalProfile(): UserProfile {
    try {
      const storage = getStorage();
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          ...INITIAL_PROFILE,
          ...parsed,
          stats: { ...INITIAL_PROFILE.stats, ...(parsed.stats || {}) },
          cloudConfig: { ...INITIAL_PROFILE.cloudConfig, ...(parsed.cloudConfig || {}) },
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    } catch (e) {
      console.warn('[DatabaseService] Failed to load local profile from localStorage:', e);
    }
    return { ...INITIAL_PROFILE };
  }

  private saveLocalProfile(): void {
    try {
      const storage = getStorage();
      storage.setItem(STORAGE_KEY, JSON.stringify(this.profile));
    } catch (e) {
      console.warn('[DatabaseService] Failed to save profile to localStorage:', e);
    }
  }


  getProfile(): Readonly<UserProfile> {
    return this.profile;
  }

  updateProfile(updates: Partial<UserProfile>): UserProfile {
    this.profile = {
      ...this.profile,
      ...updates,
    };
    this.saveLocalProfile();
    if (this.profile.cloudConfig.autoSync) {
      void this.syncToCloud();
    }
    return this.profile;
  }

  updateCloudConfig(config: Partial<CloudDbConfig>): CloudDbConfig {
    this.profile.cloudConfig = {
      ...this.profile.cloudConfig,
      ...config,
    };
    this.saveLocalProfile();
    return this.profile.cloudConfig;
  }

  canClaimDailyBonus(): { canClaim: boolean; msRemaining: number; bonusAmount: number } {
    const BONUS_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    const elapsed = now - (this.profile.lastDailyBonusClaimed || 0);
    const bonusAmount = 100;
    if (elapsed >= BONUS_INTERVAL) {
      return { canClaim: true, msRemaining: 0, bonusAmount };
    }
    return { canClaim: false, msRemaining: BONUS_INTERVAL - elapsed, bonusAmount };
  }

  claimDailyBonus(): { success: boolean; coinsAdded: number; newTotal: number; message: string } {
    const check = this.canClaimDailyBonus();
    if (!check.canClaim) {
      const hours = Math.ceil(check.msRemaining / (1000 * 60 * 60));
      return {
        success: false,
        coinsAdded: 0,
        newTotal: this.profile.coins,
        message: `Daily bonus already claimed! Come back in ${hours} hours.`,
      };
    }

    const coinsAdded = check.bonusAmount;
    this.profile.coins += coinsAdded;
    this.profile.lastDailyBonusClaimed = Date.now();
    this.saveLocalProfile();
    if (this.profile.cloudConfig.autoSync) {
      void this.syncToCloud();
    }

    return {
      success: true,
      coinsAdded,
      newTotal: this.profile.coins,
      message: `🎉 Claimed ${coinsAdded} Free Daily Coins! Total balance: ${this.profile.coins.toLocaleString()}`,
    };
  }

  recordMatch(record: Omit<MatchRecord, 'id' | 'timestamp' | 'coinChange' | 'ratingChange'>): {
    match: MatchRecord;
    profile: UserProfile;
  } {
    let coinChange = 0;
    let ratingChange = 0;

    if (record.result === 'win') {
      coinChange = record.mode === 'ai' ? 50 : 25;
      ratingChange = 15;
      this.profile.stats.wins++;
      this.profile.stats.winStreak++;
      if (this.profile.stats.winStreak > this.profile.stats.bestWinStreak) {
        this.profile.stats.bestWinStreak = this.profile.stats.winStreak;
      }
    } else if (record.result === 'loss') {
      coinChange = 0;
      ratingChange = Math.max(-15, -Math.min(10, this.profile.rating - 100)); // rating floor 100
      this.profile.stats.losses++;
      this.profile.stats.winStreak = 0;
    } else {
      // draw
      coinChange = 10;
      ratingChange = 0;
      this.profile.stats.draws++;
      this.profile.stats.winStreak = 0;
    }

    this.profile.stats.gamesPlayed++;
    this.profile.coins = Math.max(0, this.profile.coins + coinChange);
    this.profile.rating = Math.max(100, this.profile.rating + ratingChange);

    const match: MatchRecord = {
      ...record,
      id: 'match_' + Date.now().toString(36),
      timestamp: Date.now(),
      coinChange,
      ratingChange,
    };

    // Keep last 50 matches
    this.profile.history.unshift(match);
    if (this.profile.history.length > 50) {
      this.profile.history.pop();
    }

    this.saveLocalProfile();
    if (this.profile.cloudConfig.autoSync) {
      void this.syncToCloud();
    }

    return { match, profile: this.profile };
  }

  onSyncChange(listener: (synced: boolean, error?: string) => void): () => void {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  /**
   * Syncs user profile and stats to free cloud database (Firebase Realtime DB REST API / Supabase).
   */
  async syncToCloud(): Promise<{ success: boolean; message: string }> {
    if (this.isSyncing) return { success: true, message: 'Sync already in progress' };
    this.isSyncing = true;

    try {
      let endpoint = this.profile.cloudConfig.endpointUrl.trim().replace(/\/+$/, '');
      if (!endpoint) {
        endpoint = DEFAULT_FREE_DB_URL;
      }

      // Format target URL based on provider
      let targetUrl = '';
      if (this.profile.cloudConfig.provider === 'supabase') {
        targetUrl = `${endpoint}/rest/v1/users?uid=eq.${this.profile.uid}`;
      } else {
        // Firebase Realtime DB REST format: {endpoint}/users/{uid}.json
        targetUrl = `${endpoint}/users/${encodeURIComponent(this.profile.uid)}.json`;
      }

      const syncPayload = {
        uid: this.profile.uid,
        username: this.profile.username,
        displayName: this.profile.displayName,
        avatar: this.profile.avatar,
        coins: this.profile.coins,
        rating: this.profile.rating,
        lastLogin: this.profile.lastLogin,
        stats: this.profile.stats,
        historyCount: this.profile.history.length,
        updatedAt: Date.now(),
      };

      const res = await fetch(targetUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(this.profile.cloudConfig.apiKey ? { Authorization: `Bearer ${this.profile.cloudConfig.apiKey}` } : {}),
        },
        body: JSON.stringify(syncPayload),
      });

      if (res.ok) {
        this.notifySync(true);
        this.isSyncing = false;
        return { success: true, message: 'Successfully backed up user profile to Free Cloud Database!' };
      } else {
        throw new Error(`Cloud DB HTTP ${res.status}: ${res.statusText}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Even if cloud is offline, local data is 100% safe
      this.notifySync(false, msg);
      this.isSyncing = false;
      return { success: false, message: `Cloud database sync standby (Offline/Local Mode): ${msg}` };
    }
  }

  private notifySync(synced: boolean, error?: string): void {
    for (const listener of this.syncListeners) {
      try {
        listener(synced, error);
      } catch {
        /* listener error */
      }
    }
  }

  exportJson(): string {
    return JSON.stringify(this.profile, null, 2);
  }

  importJson(rawJson: string): boolean {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object' && parsed.uid) {
        this.profile = {
          ...INITIAL_PROFILE,
          ...parsed,
          stats: { ...INITIAL_PROFILE.stats, ...(parsed.stats || {}) },
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
        this.saveLocalProfile();
        void this.syncToCloud();
        return true;
      }
    } catch {
      /* parse error */
    }
    return false;
  }
}

export const dbService = DatabaseService.getInstance();

