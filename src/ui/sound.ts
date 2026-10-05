type SoundKind = 'move' | 'capture' | 'check' | 'end';

let ctx: AudioContext | null = null;
let muted = false;

try {
  muted = localStorage.getItem('ca-muted') === '1';
} catch {
  /* storage unavailable */
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem('ca-muted', value ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

const TONES: Record<SoundKind, [freq: number, ms: number, type: OscillatorType][]> = {
  move: [[520, 45, 'triangle']],
  capture: [[300, 70, 'square']],
  check: [[660, 60, 'triangle'], [880, 90, 'triangle']],
  end: [[440, 120, 'sine'], [550, 120, 'sine'], [660, 220, 'sine']],
};

/** Short synthesized sounds: no audio files to download. */
export function play(kind: SoundKind): void {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    let t = ctx.currentTime;
    for (const [freq, ms, type] of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + ms / 1000);
      t += ms / 1000;
    }
  } catch {
    /* audio unavailable */
  }
}
