import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { ChessClock, formatClock } from '../../src/chess/clock';
import { acceptsDraw, chooseMove, evaluate } from '../../src/chess/ai';

describe('ChessClock', () => {
  it('is untimed when initial time is 0', () => {
    const c = new ChessClock({ initialMs: 0, incrementMs: 0 });
    c.start('w', 0);
    expect(c.timeLeft('w', 1e9)).toBe(Infinity);
    expect(c.flagged(1e9)).toBeNull();
  });

  it('runs only the active side and stops cleanly', () => {
    const c = new ChessClock({ initialMs: 10_000, incrementMs: 0 });
    c.start('w', 0);
    expect(c.timeLeft('w', 3_000)).toBe(7_000);
    expect(c.timeLeft('b', 3_000)).toBe(10_000);
    c.switchTurn(3_000);
    c.stop(4_000);
    expect(c.timeLeft('b', 99_000)).toBe(9_000);
    expect(c.active).toBeNull();
  });

  it('does not add increment to a side that already flagged', () => {
    const c = new ChessClock({ initialMs: 1_000, incrementMs: 5_000 });
    c.start('w', 0);
    c.switchTurn(2_000);
    expect(c.timeLeft('w', 2_000)).toBe(0);
  });

  it('formats times', () => {
    expect(formatClock(Infinity)).toBe('∞');
    expect(formatClock(180_000)).toBe('3:00');
    expect(formatClock(61_200)).toBe('1:02');
    expect(formatClock(9_450)).toBe('0:09.4');
  });
});

describe('AI', () => {
  const fixed = () => 0.5; // no noise

  it('evaluates the start position as roughly equal', () => {
    expect(Math.abs(evaluate(new Chess().fen()))).toBeLessThan(50);
  });

  it.each(['easy', 'medium', 'hard'] as const)('%s finds mate in one', (level) => {
    // White: Qh5 + Bc4 vs. black king on e8 with f7 weak (scholar's mate).
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
    const move = chooseMove(fen, level, fixed);
    expect(move?.san).toBe('Qxf7#');
  });

  it('captures a hanging queen', () => {
    expect(chooseMove('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1', 'medium', fixed)?.san).toBe('Rxd5');
  });

  it('always returns a legal move and null when there is none', () => {
    const chess = new Chess();
    for (let i = 0; i < 6 && !chess.isGameOver(); i++) {
      const m = chooseMove(chess.fen(), 'easy');
      expect(m).not.toBeNull();
      chess.move({ from: m!.from, to: m!.to, promotion: m!.promotion });
    }
    expect(chooseMove('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', 'easy')).toBeNull(); // checkmated
  });

  it('accepts draws only when losing', () => {
    expect(acceptsDraw(new Chess().fen(), 'b')).toBe(false);
    const whiteCrushing = '4k3/8/8/8/8/8/8/QQQQK3 w - - 0 1';
    expect(acceptsDraw(whiteCrushing, 'b')).toBe(true); // losing side accepts
    expect(acceptsDraw(whiteCrushing, 'w')).toBe(false); // winning side declines
  });
});
