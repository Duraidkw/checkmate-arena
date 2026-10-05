import { Chess, type Move } from 'chess.js';
import { PIECE, Position, moveFrom, movePromo, moveTo, moveToUci } from './engine';

export type Level = 'easy' | 'medium' | 'hard';

const { P, N, B, R, Q, K, WHITE } = PIECE;
// Indexed by piece type (1..6).
const VALUE = [0, 100, 320, 330, 500, 900, 0];
const MATE = 100_000;

// Piece-square tables from White's point of view, a8 first (simplified evaluation function).
// prettier-ignore
const PST: number[][] = [];
// prettier-ignore
PST[P] = [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
  0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0];
// prettier-ignore
PST[N] = [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
  -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50];
// prettier-ignore
PST[B] = [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
  -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20];
// prettier-ignore
PST[R] = [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
  -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0];
// prettier-ignore
PST[Q] = [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
  0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20];
// prettier-ignore
PST[K] = [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20];

/** Static evaluation in centipawns from the point of view of the side to move. */
export function evaluatePosition(pos: Position): number {
  let score = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = pos.board[sq];
    if (!p) continue;
    const type = p & 7;
    const rank = sq >> 4;
    const file = sq & 7;
    const white = (p & 8) === WHITE;
    const v = VALUE[type] + PST[type][white ? (7 - rank) * 8 + file : rank * 8 + file];
    score += white ? v : -v;
  }
  return pos.side === WHITE ? score : -score;
}

export function evaluate(fen: string): number {
  return evaluatePosition(new Position(fen));
}

function ordered(pos: Position, moves: number[]): number[] {
  const key = (m: number) => {
    const victim = pos.board[moveTo(m)] & 7;
    const attacker = pos.board[moveFrom(m)] & 7;
    return (victim ? 10 * VALUE[victim] - VALUE[attacker] : 0) + (movePromo(m) ? VALUE[movePromo(m)] : 0);
  };
  return moves.map((m) => [key(m), m]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
}

const TIMEOUT = Symbol('timeout');

class Search {
  nodes = 0;
  /** No deadline while the first depth is searched, so there is always a complete answer. */
  deadline = Infinity;
  constructor(private readonly pos: Position) {}

  private visit(): void {
    if ((++this.nodes & 2047) === 0 && performance.now() > this.deadline) throw TIMEOUT;
  }

  quiesce(alpha: number, beta: number, depth: number): number {
    this.visit();
    const standPat = evaluatePosition(this.pos);
    if (depth === 0 || standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    for (const m of ordered(this.pos, this.pos.pseudoMoves(true))) {
      if (!this.pos.make(m)) continue;
      const score = -this.quiesce(-beta, -alpha, depth - 1);
      this.pos.unmake();
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  negamax(depth: number, alpha: number, beta: number, ply: number): number {
    this.visit();
    if (depth === 0) return this.quiesce(alpha, beta, 6);
    let best = -Infinity;
    let legal = 0;
    for (const m of ordered(this.pos, this.pos.pseudoMoves())) {
      if (!this.pos.make(m)) continue;
      legal++;
      const score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      this.pos.unmake();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    if (!legal) return this.pos.inCheck() ? -MATE + ply : 0;
    return best;
  }
}

const DEPTH: Record<Level, number> = { easy: 2, medium: 3, hard: 4 };
const NOISE: Record<Level, number> = { easy: 150, medium: 30, hard: 0 };
const TIME_MS: Record<Level, number> = { easy: 400, medium: 1200, hard: 2500 };

/** Picks a move for the side to move. `rng` is injectable for deterministic tests. */
export function chooseMove(fen: string, level: Level, rng: () => number = Math.random): Move | null {
  const pos = new Position(fen);
  const rootMoves = ordered(pos, pos.legalMoves());
  if (!rootMoves.length) return null;

  const search = new Search(pos);
  const deadline = performance.now() + TIME_MS[level];
  let best = rootMoves[0];

  // Iterative deepening: each finished depth refines the choice. An unfinished depth is discarded.
  try {
    for (let depth = 1; depth <= DEPTH[level]; depth++) {
      let depthBest = rootMoves[0];
      let depthScore = -Infinity;
      const scores = new Map<number, number>();
      for (const m of rootMoves) {
        pos.make(m);
        let score = -search.negamax(depth - 1, -Infinity, Infinity, 1);
        pos.unmake();
        if (Math.abs(score) < MATE - 1000) score += (rng() - 0.5) * 2 * NOISE[level]; // never blur a forced mate
        scores.set(m, score);
        if (score > depthScore) {
          depthScore = score;
          depthBest = m;
        }
      }
      best = depthBest;
      if (depthScore > MATE - 1000) break; // forced mate found
      rootMoves.sort((a, b) => scores.get(b)! - scores.get(a)!); // best move first next time
      search.deadline = deadline;
      if (performance.now() > deadline) break;
    }
  } catch (e) {
    if (e !== TIMEOUT) throw e;
  }

  return new Chess(fen).move(moveToUci(best));
}

/** Whether the computer playing `color` accepts a draw offer: only when it is clearly worse. */
export function acceptsDraw(fen: string, color: 'w' | 'b'): boolean {
  const pos = new Position(fen);
  const score = evaluatePosition(pos);
  return ((pos.side === WHITE) === (color === 'w') ? score : -score) <= -150;
}
