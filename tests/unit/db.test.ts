import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService, getStorage } from '../../src/services/db';

describe('DatabaseService', () => {
  let db: DatabaseService;

  beforeEach(() => {
    getStorage().clear();
    // @ts-expect-error reset singleton
    DatabaseService.instance = undefined;
    db = DatabaseService.getInstance();
  });


  it('initializes a default user profile with 1,000 free coins', () => {
    const profile = db.getProfile();
    expect(profile.coins).toBe(1000);
    expect(profile.rating).toBe(1200);
    expect(profile.username).toBe('Grandmaster');
    expect(profile.stats.gamesPlayed).toBe(0);
    expect(profile.history).toHaveLength(0);
  });

  it('updates display name and avatar', () => {
    db.updateProfile({ displayName: 'ChessKing', avatar: 'wq' });
    const profile = db.getProfile();
    expect(profile.displayName).toBe('ChessKing');
    expect(profile.avatar).toBe('wq');
  });

  it('claims daily 100 free coins bonus and prevents claiming twice in 24h', () => {
    const res = db.claimDailyBonus();
    expect(res.success).toBe(true);
    expect(res.coinsAdded).toBe(100);
    expect(res.newTotal).toBe(1100);

    // Try claiming again immediately
    const res2 = db.claimDailyBonus();
    expect(res2.success).toBe(false);
    expect(res2.coinsAdded).toBe(0);
    expect(res2.newTotal).toBe(1100);
  });

  it('records game wins with +50 coins and +15 ELO', () => {
    const { match, profile } = db.recordMatch({
      mode: 'ai',
      opponent: 'Computer (medium)',
      result: 'win',
      reason: 'checkmate',
      movesCount: 24,
      timeControl: '10+0',
    });

    expect(match.coinChange).toBe(50);
    expect(match.ratingChange).toBe(15);
    expect(profile.coins).toBe(1050);
    expect(profile.rating).toBe(1215);
    expect(profile.stats.wins).toBe(1);
    expect(profile.stats.winStreak).toBe(1);
    expect(profile.history).toHaveLength(1);
  });

  it('records game losses with rating reduction', () => {
    const { match, profile } = db.recordMatch({
      mode: 'ai',
      opponent: 'Computer (hard)',
      result: 'loss',
      reason: 'checkmate',
      movesCount: 30,
      timeControl: '5+0',
    });

    expect(match.coinChange).toBe(0);
    expect(match.ratingChange).toBe(-10);
    expect(profile.coins).toBe(1000);
    expect(profile.rating).toBe(1190);
    expect(profile.stats.losses).toBe(1);
    expect(profile.stats.winStreak).toBe(0);
  });

  it('exports and imports backup JSON correctly', () => {
    db.updateProfile({ displayName: 'BackupPlayer', coins: 5000 });
    const json = db.exportJson();
    expect(json).toContain('BackupPlayer');
    expect(json).toContain('5000');

    getStorage().clear();
    // @ts-expect-error reset singleton
    DatabaseService.instance = undefined;
    const db2 = DatabaseService.getInstance();
    expect(db2.getProfile().displayName).toBe('Grandmaster Player');

    const imported = db2.importJson(json);
    expect(imported).toBe(true);
    expect(db2.getProfile().displayName).toBe('BackupPlayer');
    expect(db2.getProfile().coins).toBe(5000);
  });
});
