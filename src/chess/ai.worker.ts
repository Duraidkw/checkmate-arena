import { chooseMove, type Level } from './ai';

export interface AiRequest {
  id: number;
  fen: string;
  level: Level;
}

export interface AiResponse {
  id: number;
  from: string;
  to: string;
  promotion?: string;
}

self.onmessage = (e: MessageEvent<AiRequest>) => {
  const { id, fen, level } = e.data;
  const move = chooseMove(fen, level);
  if (move) {
    const response: AiResponse = { id, from: move.from, to: move.to, promotion: move.promotion };
    self.postMessage(response);
  }
};
