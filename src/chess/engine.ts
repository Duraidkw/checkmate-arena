/**
 * A compact, fast 0x88 chess move generator used by the computer opponent.
 * Game rules shown to players are enforced by chess.js; this engine exists only for search speed.
 * Correctness is verified by perft tests against published node counts.
 */

// Pieces: type in low 3 bits, colour in bit 3 (0 = white, 8 = black).
const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
const WHITE = 0, BLACK = 8;

// Move encoding: from | to << 7 | promo << 14 | flags << 17
const F_EP = 1, F_CASTLE = 2, F_DOUBLE = 4;

const KNIGHT = [14, 18, 31, 33, -14, -18, -31, -33];
const KING = [1, 15, 16, 17, -1, -15, -16, -17];
const DIAG = [15, 17, -15, -17];
const ORTHO = [1, 16, -1, -16];

const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[0x00] = 15 & ~2; // a1: white queenside
CASTLE_MASK[0x07] = 15 & ~1; // h1: white kingside
CASTLE_MASK[0x04] = 15 & ~3; // e1
CASTLE_MASK[0x70] = 15 & ~8; // a8
CASTLE_MASK[0x77] = 15 & ~4; // h8
CASTLE_MASK[0x74] = 15 & ~12; // e8

const FEN_PIECES: Record<string, number> = { p: P, n: N, b: B, r: R, q: Q, k: K };
const PROMO_CHAR = ['', '', 'n', 'b', 'r', 'q'];

export const moveFrom = (m: number) => m & 0x7f;
export const moveTo = (m: number) => (m >> 7) & 0x7f;
export const movePromo = (m: number) => (m >> 14) & 7;
const moveFlags = (m: number) => m >> 17;

export function squareName(sq: number): string {
  return 'abcdefgh'[sq & 7] + String((sq >> 4) + 1);
}

interface Undo {
  move: number;
  captured: number;
  castling: number;
  ep: number;
}

export class Position {
  board = new Int8Array(128);
  side = WHITE;
  castling = 0;
  ep = -1;
  kings = [0, 0];
  private history: Undo[] = [];

  constructor(fen: string) {
    const [placement, side, castling, ep] = fen.trim().split(/\s+/);
    let rank = 7;
    let file = 0;
    for (const ch of placement) {
      if (ch === '/') { rank--; file = 0; continue; }
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const sq = rank * 16 + file;
      const color = ch === ch.toLowerCase() ? BLACK : WHITE;
      const type = FEN_PIECES[ch.toLowerCase()];
      this.board[sq] = type | color;
      if (type === K) this.kings[color >> 3] = sq;
      file++;
    }
    this.side = side === 'b' ? BLACK : WHITE;
    this.castling =
      (castling.includes('K') ? 1 : 0) | (castling.includes('Q') ? 2 : 0) |
      (castling.includes('k') ? 4 : 0) | (castling.includes('q') ? 8 : 0);
    this.ep = ep && ep !== '-' ? (Number(ep[1]) - 1) * 16 + (ep.charCodeAt(0) - 97) : -1;
  }

  /** Is `sq` attacked by side `by` (WHITE or BLACK)? */
  attacked(sq: number, by: number): boolean {
    const b = this.board;
    // Pawns
    if (by === WHITE) {
      if (!((sq - 15) & 0x88) && b[sq - 15] === (P | WHITE)) return true;
      if (!((sq - 17) & 0x88) && b[sq - 17] === (P | WHITE)) return true;
    } else {
      if (!((sq + 15) & 0x88) && b[sq + 15] === (P | BLACK)) return true;
      if (!((sq + 17) & 0x88) && b[sq + 17] === (P | BLACK)) return true;
    }
    for (const d of KNIGHT) {
      const t = sq + d;
      if (!(t & 0x88) && b[t] === (N | by)) return true;
    }
    for (const d of KING) {
      const t = sq + d;
      if (!(t & 0x88) && b[t] === (K | by)) return true;
    }
    for (const d of DIAG) {
      for (let t = sq + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (!p) continue;
        if ((p & 8) === by && ((p & 7) === B || (p & 7) === Q)) return true;
        break;
      }
    }
    for (const d of ORTHO) {
      for (let t = sq + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (!p) continue;
        if ((p & 8) === by && ((p & 7) === R || (p & 7) === Q)) return true;
        break;
      }
    }
    return false;
  }

  inCheck(): boolean {
    return this.attacked(this.kings[this.side >> 3], this.side ^ 8);
  }

  /** Pseudo-legal moves (may leave the king in check). */
  pseudoMoves(capturesOnly = false): number[] {
    const moves: number[] = [];
    const b = this.board;
    const us = this.side;
    const them = us ^ 8;
    const add = (from: number, to: number, promo = 0, flags = 0) => moves.push(from | (to << 7) | (promo << 14) | (flags << 17));

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p || (p & 8) !== us) continue;
      const type = p & 7;

      if (type === P) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;
        const one = sq + dir;
        const addPawn = (to: number, flags = 0) => {
          if (to >> 4 === promoRank) for (const pr of [Q, R, B, N]) add(sq, to, pr, flags);
          else add(sq, to, 0, flags);
        };
        if (!(one & 0x88) && !b[one] && (!capturesOnly || one >> 4 === promoRank)) {
          addPawn(one);
          const two = one + dir;
          if (!capturesOnly && sq >> 4 === startRank && !b[two]) add(sq, two, 0, F_DOUBLE);
        }
        for (const cd of [dir - 1, dir + 1]) {
          const t = sq + cd;
          if (t & 0x88) continue;
          if (b[t] && (b[t] & 8) === them) addPawn(t);
          else if (t === this.ep) add(sq, t, 0, F_EP);
        }
        continue;
      }

      const step = (dirs: number[], slide: boolean) => {
        for (const d of dirs) {
          for (let t = sq + d; !(t & 0x88); t += d) {
            const target = b[t];
            if (target) {
              if ((target & 8) === them) add(sq, t);
              break;
            }
            if (!capturesOnly) add(sq, t);
            if (!slide) break;
          }
        }
      };

      if (type === N) step(KNIGHT, false);
      else if (type === B) step(DIAG, true);
      else if (type === R) step(ORTHO, true);
      else if (type === Q) { step(DIAG, true); step(ORTHO, true); }
      else if (type === K) {
        step(KING, false);
        if (!capturesOnly) this.castleMoves(sq, add);
      }
    }
    return moves;
  }

  private castleMoves(sq: number, add: (f: number, t: number, p?: number, fl?: number) => void) {
    const b = this.board;
    const them = this.side ^ 8;
    if (this.side === WHITE && sq === 0x04) {
      if (this.castling & 1 && !b[5] && !b[6] && !this.attacked(4, them) && !this.attacked(5, them) && !this.attacked(6, them))
        add(4, 6, 0, F_CASTLE);
      if (this.castling & 2 && !b[3] && !b[2] && !b[1] && !this.attacked(4, them) && !this.attacked(3, them) && !this.attacked(2, them))
        add(4, 2, 0, F_CASTLE);
    } else if (this.side === BLACK && sq === 0x74) {
      if (this.castling & 4 && !b[0x75] && !b[0x76] && !this.attacked(0x74, them) && !this.attacked(0x75, them) && !this.attacked(0x76, them))
        add(0x74, 0x76, 0, F_CASTLE);
      if (this.castling & 8 && !b[0x73] && !b[0x72] && !b[0x71] && !this.attacked(0x74, them) && !this.attacked(0x73, them) && !this.attacked(0x72, them))
        add(0x74, 0x72, 0, F_CASTLE);
    }
  }

  /** Makes a move. Returns false (and undoes it) if it leaves the mover's king in check. */
  make(m: number): boolean {
    const b = this.board;
    const from = moveFrom(m), to = moveTo(m), promo = movePromo(m), flags = moveFlags(m);
    const piece = b[from];
    const us = this.side;
    let captured = b[to];

    this.history.push({ move: m, captured, castling: this.castling, ep: this.ep });

    if (flags & F_EP) {
      const capSq = us === WHITE ? to - 16 : to + 16;
      captured = b[capSq];
      this.history[this.history.length - 1].captured = captured;
      b[capSq] = 0;
    }
    b[to] = promo ? promo | us : piece;
    b[from] = 0;

    if (flags & F_CASTLE) {
      if (to === 6) { b[5] = b[7]; b[7] = 0; }
      else if (to === 2) { b[3] = b[0]; b[0] = 0; }
      else if (to === 0x76) { b[0x75] = b[0x77]; b[0x77] = 0; }
      else if (to === 0x72) { b[0x73] = b[0x70]; b[0x70] = 0; }
    }
    if ((piece & 7) === K) this.kings[us >> 3] = to;

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.ep = flags & F_DOUBLE ? (from + to) >> 1 : -1;
    this.side ^= 8;

    if (this.attacked(this.kings[us >> 3], this.side)) {
      this.unmake();
      return false;
    }
    return true;
  }

  unmake(): void {
    const u = this.history.pop()!;
    const b = this.board;
    this.side ^= 8;
    const us = this.side;
    const from = moveFrom(u.move), to = moveTo(u.move), promo = movePromo(u.move), flags = moveFlags(u.move);
    const moved = promo ? P | us : b[to];

    b[from] = moved;
    if (flags & F_EP) {
      b[to] = 0;
      b[us === WHITE ? to - 16 : to + 16] = u.captured;
    } else {
      b[to] = u.captured;
    }
    if (flags & F_CASTLE) {
      if (to === 6) { b[7] = b[5]; b[5] = 0; }
      else if (to === 2) { b[0] = b[3]; b[3] = 0; }
      else if (to === 0x76) { b[0x77] = b[0x75]; b[0x75] = 0; }
      else if (to === 0x72) { b[0x70] = b[0x73]; b[0x73] = 0; }
    }
    if ((moved & 7) === K) this.kings[us >> 3] = from;
    this.castling = u.castling;
    this.ep = u.ep;
  }

  legalMoves(): number[] {
    return this.pseudoMoves().filter((m) => {
      if (!this.make(m)) return false;
      this.unmake();
      return true;
    });
  }

  /** Counts leaf nodes at `depth` (move-generator correctness test). */
  perft(depth: number): number {
    if (depth === 0) return 1;
    let nodes = 0;
    for (const m of this.pseudoMoves()) {
      if (!this.make(m)) continue;
      nodes += this.perft(depth - 1);
      this.unmake();
    }
    return nodes;
  }

  pieceAt(sq: number): number {
    return this.board[sq];
  }

  captureValueOf(m: number): number {
    return this.board[moveTo(m)] & 7;
  }
}

export function moveToUci(m: number): { from: string; to: string; promotion?: string } {
  const promo = movePromo(m);
  return { from: squareName(moveFrom(m)), to: squareName(moveTo(m)), ...(promo ? { promotion: PROMO_CHAR[promo] } : {}) };
}

export const PIECE = { P, N, B, R, Q, K, WHITE, BLACK };
