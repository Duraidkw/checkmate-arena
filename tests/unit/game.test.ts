import { describe, expect, it } from 'vitest';
import { GameSession, describeResult, hasMatingMaterial } from '../../src/chess/game';
import { Chess } from 'chess.js';

const UNTIMED = { initialMs: 0, incrementMs: 0 };

function session(fen?: string, now = () => 0) {
  return new GameSession({ timeControl: UNTIMED, fen, now });
}

function playAll(s: GameSession, sans: string[]) {
  for (const san of sans) expect(s.moveSan(san), `move ${san}`).not.toBeNull();
}

describe('GameSession rules', () => {
  it('starts from the initial position with white to move', () => {
    const s = session();
    expect(s.turn).toBe('w');
    expect(s.legalMovesFrom('e2').map((m) => m.to).sort()).toEqual(['e3', 'e4']);
  });

  it('rejects illegal moves and moving out of turn', () => {
    const s = session();
    expect(s.move('e2', 'e5')).toBeNull();
    expect(s.move('e7', 'e5')).toBeNull();
    expect(s.history()).toHaveLength(0);
  });

  it("detects checkmate (fool's mate)", () => {
    const s = session();
    playAll(s, ['f3', 'e5', 'g4', 'Qh4#']);
    expect(s.result).toEqual({ winner: 'b', reason: 'checkmate' });
    expect(s.move('a2', 'a3')).toBeNull();
  });

  it('detects stalemate', () => {
    const t = session('k7/8/1Q6/8/8/8/8/7K w - - 0 1');
    t.move('b6', 'c7');
    expect(t.result).toEqual({ winner: null, reason: 'stalemate' });
  });

  it('detects insufficient material after a capture', () => {
    const t = session('8/8/8/4k3/8/8/3Kn3/8 w - - 0 1');
    t.move('d2', 'e2');
    expect(t.result).toEqual({ winner: null, reason: 'insufficient' });
  });

  it('detects threefold repetition', () => {
    const s = session();
    playAll(s, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']);
    expect(s.result).toEqual({ winner: null, reason: 'threefold' });
  });

  it('detects the fifty-move rule', () => {
    const s = session('8/8/8/4k3/8/8/R7/4K3 w - - 99 80');
    s.move('a2', 'a3');
    expect(s.result).toEqual({ winner: null, reason: 'fifty-move' });
  });

  it('handles castling, en passant and promotion', () => {
    const castle = session('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(castle.move('e1', 'g1')?.san).toBe('O-O');
    expect(castle.move('e8', 'c8')?.san).toBe('O-O-O');

    const ep = session();
    playAll(ep, ['e4', 'a6', 'e5', 'd5']);
    expect(ep.move('e5', 'd6')?.flags).toContain('e');

    const promo = session('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    expect(promo.isPromotion('a7', 'a8')).toBe(true);
    expect(promo.move('a7', 'a8', 'n')?.san).toBe('a8=N');
  });

  it('finds the checked king square', () => {
    const s = session();
    playAll(s, ['e4', 'f5', 'Qh5+']);
    expect(s.checkedKing()).toBe('e8');
  });

  it('handles resignation and draw agreement', () => {
    const s = session();
    s.resign('w');
    expect(s.result).toEqual({ winner: 'b', reason: 'resign' });
    s.agreeDraw(); // ignored: game already over
    expect(s.result?.reason).toBe('resign');

    const t = session();
    t.agreeDraw();
    expect(t.result).toEqual({ winner: null, reason: 'agreement' });
  });

  it('notifies listeners on moves', () => {
    const s = session();
    let calls = 0;
    s.onChange(() => calls++);
    s.moveSan('e4');
    expect(calls).toBe(1);
  });
});

describe('GameSession clocks', () => {
  it('starts after the first move, applies increment and flags on timeout', () => {
    let t = 0;
    const s = new GameSession({ timeControl: { initialMs: 60_000, incrementMs: 2_000 }, now: () => t });
    t = 5_000;
    s.moveSan('e4'); // white's first move costs no time
    expect(s.timeLeft('w')).toBe(60_000);
    t = 15_000;
    s.moveSan('e5'); // black spent 10s, +2s increment
    expect(s.timeLeft('b')).toBe(52_000);
    t = 15_000 + 60_000;
    expect(s.tick()).toEqual({ winner: 'b', reason: 'timeout' });
  });

  it('declares a draw on timeout when the opponent cannot mate', () => {
    let t = 0;
    const s = new GameSession({
      timeControl: { initialMs: 10_000, incrementMs: 0 },
      fen: '8/8/8/4k3/8/8/3P4/3K3n w - - 0 1',
      now: () => t,
    });
    s.move('d1', 'e1'); // white moves, black's clock (lone knight) starts
    s.move('h1', 'g3');
    t = 20_000; // white flags; black only has a knight
    expect(s.tick()).toEqual({ winner: null, reason: 'insufficient' });
  });
});

describe('helpers', () => {
  it('hasMatingMaterial', () => {
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/8/K6N w - - 0 1'), 'w')).toBe(false);
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/8/K5BN w - - 0 1'), 'w')).toBe(true);
    expect(hasMatingMaterial(new Chess('8/8/8/4k3/8/8/P7/K7 w - - 0 1'), 'w')).toBe(true);
  });

  it('describeResult', () => {
    expect(describeResult({ winner: 'w', reason: 'checkmate' })).toEqual({ title: 'White wins', detail: 'by checkmate' });
    expect(describeResult({ winner: null, reason: 'stalemate' }).title).toBe('Draw');
  });
});
