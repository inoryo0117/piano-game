// piano-logic.js — ピアノ音ゲーの純ロジック（DOM非依存）。
// ブラウザでは <script type="module"> で、Node では import で読む（jitou-logic.js と同じ流儀）。
// 仕様: ピアノ音ゲー仕様書 §2, §3

// ---------------------------------------------------------------------------
// 基礎
// ---------------------------------------------------------------------------
export const A4_MIDI = 69;
export const A4_FREQ = 440;
export const MIN_PIANO_MIDI = 21; // A0
export const MAX_PIANO_MIDI = 108; // C8

export function midiToFreq(midi) {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

// 白鍵かどうか（C,D,E,F,G,A,B）
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
export function isWhiteKey(midi) {
  return WHITE_PC.has(((midi % 12) + 12) % 12);
}

// ---------------------------------------------------------------------------
// FFT（自前・Hann窓・radix-2 iterative Cooley-Tukey）
// ---------------------------------------------------------------------------
const hannCache = new Map();
export function hannWindow(n) {
  let w = hannCache.get(n);
  if (w) return w;
  w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache.set(n, w);
  return w;
}

// re, im: Float64Array/Float32Array 同じ長さ n（2の冪）。in-place。
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ai = i + k, bi = i + k + half;
        const ur = re[ai], ui = im[ai];
        const vr = re[bi] * curWr - im[bi] * curWi;
        const vi = re[bi] * curWi + im[bi] * curWr;
        re[ai] = ur + vr; im[ai] = ui + vi;
        re[bi] = ur - vr; im[bi] = ui - vi;
        const nwr = curWr * wr0 - curWi * wi0;
        const nwi = curWr * wi0 + curWi * wr0;
        curWr = nwr; curWi = nwi;
      }
    }
  }
}

// timeSamples: 長さ N（2の冪）の時間波形。Hann窓をかけてFFT→振幅スペクトル（長さ N/2）を返す。
export function computeSpectrum(timeSamples, sampleRate) {
  const n = timeSamples.length;
  const w = hannWindow(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = timeSamples[i] * w[i];
  fftInPlace(re, im);
  const half = n >> 1;
  const mags = new Float64Array(half);
  for (let i = 0; i < half; i++) mags[i] = Math.hypot(re[i], im[i]);
  return { mags, fftSize: n, sampleRate, binHz: sampleRate / n };
}

// 指定した周波数帯[freqLo,freqHi]内の最大振幅（帯が範囲外なら0）
export function bandMaxAmp(spectrum, freqLo, freqHi) {
  const { mags, binHz } = spectrum;
  if (freqHi <= 0 || freqLo >= (mags.length - 1) * binHz) return 0;
  let loBin = Math.max(0, Math.floor(freqLo / binHz));
  let hiBin = Math.min(mags.length - 1, Math.ceil(freqHi / binHz));
  if (loBin > hiBin) return 0;
  let m = 0;
  for (let i = loBin; i <= hiBin; i++) if (mags[i] > m) m = mags[i];
  return m;
}

// ---------------------------------------------------------------------------
// salience（スコア付き検出の核）
// ---------------------------------------------------------------------------
const EPS = 1e-6;
const QUARTER_SEMITONE_RATIO = Math.pow(2, 0.25 / 12);

// 音 midi の強さ。倍音 k=1..harmonics を ±1/4半音の帯で探し、最大振幅×1/kを合計。
// f0Db/k2Db は k=1・k=2 それぞれ単独の強さ（オンセット判定でのオクターブ・隣接半音の誤検出対策に使う）。
export function salience(spectrum, midi, harmonics = 6) {
  const f0 = midiToFreq(midi);
  const nyquist = spectrum.sampleRate / 2;
  let total = 0;
  let f0Amp = 0;
  let k2Amp = 0;
  for (let k = 1; k <= harmonics; k++) {
    const center = f0 * k;
    if (center >= nyquist) continue;
    const lo = center / QUARTER_SEMITONE_RATIO;
    const hi = center * QUARTER_SEMITONE_RATIO;
    const amp = bandMaxAmp(spectrum, lo, hi);
    if (k === 1) f0Amp = amp;
    if (k === 2) k2Amp = amp;
    total += amp / k;
  }
  return {
    totalDb: 20 * Math.log10(total + EPS),
    f0Db: 20 * Math.log10(f0Amp + EPS),
    k2Db: 20 * Math.log10(k2Amp + EPS),
    totalLinear: total,
    f0Linear: f0Amp,
    k2Linear: k2Amp,
  };
}

// 自由演奏モード用の簡易版：全鍵盤域から上位N音を返す。
export function detectFree(spectrum, opts = {}) {
  const minMidi = opts.minMidi ?? MIN_PIANO_MIDI;
  const maxMidi = opts.maxMidi ?? MAX_PIANO_MIDI;
  const harmonics = opts.harmonics ?? 6;
  const topN = opts.topN ?? 6;
  const minDb = opts.minDb ?? -Infinity;
  const out = [];
  for (let m = minMidi; m <= maxMidi; m++) {
    const s = salience(spectrum, m, harmonics);
    if (s.totalDb >= minDb) out.push({ midi: m, totalDb: s.totalDb, f0Db: s.f0Db });
  }
  out.sort((a, b) => b.totalDb - a.totalDb);
  return out.slice(0, topN);
}

// ---------------------------------------------------------------------------
// オンセット検出（ノイズフロア追跡つき）
// ---------------------------------------------------------------------------
export function createOnsetDetector(opts = {}) {
  const harmonics = opts.harmonics ?? 6;
  const thresholdDb = opts.thresholdDb ?? 12; // フロア＋この値を超えたら候補
  const jumpDb = opts.jumpDb ?? 6; // 約80ms前から跳ねる量
  const jumpWindowMs = opts.jumpWindowMs ?? 80;
  const f0ThresholdDb = opts.f0ThresholdDb ?? 6; // オクターブ誤検出対策：f0単独もフロア+6dB要求
  const floorAlpha = opts.floorAlpha ?? 0.1;
  const debounceMs = opts.debounceMs ?? 150; // 減衰中の倍音干渉による二重発火を避ける（連打0.25秒間隔より十分短い）
  const historyKeepMs = opts.historyKeepMs ?? 500;

  const states = new Map(); // midi -> {floorDb,floorF0Db,floorK2Db,history:[...],lastOnsetT,pendingArmT}

  function getOrInit(midi) {
    let st = states.get(midi);
    if (!st) {
      st = { floorDb: null, floorF0Db: null, floorK2Db: null, history: [], lastOnsetT: -Infinity, pendingArmT: null };
      states.set(midi, st);
    }
    return st;
  }

  function findPast(history, targetT) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].t <= targetT) return history[i];
    }
    return null;
  }

  // t: 秒（このフレームの時刻）, spectrum: computeSpectrum() の戻り値
  // watchMidis: このフレームで評価する音高の配列/Set
  // expectedMidis: このフレームで「鳴るはず」として判定待ちの音高の Set（フロア更新をスキップする対象）
  function step(t, spectrum, watchMidis, expectedMidis) {
    const events = [];
    const expected = expectedMidis || new Set();
    for (const midi of watchMidis) {
      const st = getOrInit(midi);
      const sal = salience(spectrum, midi, harmonics);
      const isExpected = expected.has(midi);
      if (!isExpected) {
        st.floorDb = st.floorDb === null ? sal.totalDb : st.floorDb * (1 - floorAlpha) + sal.totalDb * floorAlpha;
        st.floorF0Db = st.floorF0Db === null ? sal.f0Db : st.floorF0Db * (1 - floorAlpha) + sal.f0Db * floorAlpha;
        st.floorK2Db = st.floorK2Db === null ? sal.k2Db : st.floorK2Db * (1 - floorAlpha) + sal.k2Db * floorAlpha;
      }
      if (st.floorDb === null) st.floorDb = sal.totalDb;
      if (st.floorF0Db === null) st.floorF0Db = sal.f0Db;
      if (st.floorK2Db === null) st.floorK2Db = sal.k2Db;

      st.history.push({ t, totalDb: sal.totalDb, f0Db: sal.f0Db });
      const keepFrom = t - historyKeepMs / 1000;
      while (st.history.length && st.history[0].t < keepFrom) st.history.shift();

      const past = findPast(st.history, t - jumpWindowMs / 1000);
      const condFloor = sal.totalDb > st.floorDb + thresholdDb;
      const condJump = past !== null && sal.totalDb - past.totalDb >= jumpDb;
      const cooldownOk = t - st.lastOnsetT >= debounceMs / 1000;

      // 候補の「仮検知」：フロア＋跳ねだけで捉える（時刻はここで確定＝backdateする）。
      if (st.pendingArmT === null && condFloor && condJump && cooldownOk) {
        st.pendingArmT = t;
      }

      if (st.pendingArmT !== null) {
        // FFT窓長（fftSize/sampleRate）だけ待ってから確定判定する：
        // 発音直後は解析窓が「無音／別の音」と「今の音」の境目にまたがり、隣の半音の帯にも
        // 一時的にエネルギーが漏れる（オンセット直後だけの一過性のにじみ）。窓が完全に
        // 今の音で埋まるまで待ってから f0・k2 のゲートを見ることで、隣接半音の誤検出
        // （例：D4を待っているのにC4を弾いた）を抑える。判定が遅れても、イベントの時刻は
        // 仮検知した時刻（pendingArmT）に遡らせるので、得点判定上の遅れは増えない。
        const windowSec = spectrum.fftSize / spectrum.sampleRate;
        const elapsed = t - st.pendingArmT;
        if (elapsed >= windowSec) {
          // オクターブ誤検出対策：f0（k=1）単独もフロア+6dBを要求（仕様）。
          // さらに k=2 単独でもフロア+6dBを要求する（2倍音は基音の半音隣接より周波数間隔が
          // 広く分離できるため。隣接半音の誤検出対策・仕様の拡張・要確認）。
          const condF0 = sal.f0Db > st.floorF0Db + f0ThresholdDb;
          const condK2 = sal.k2Linear === 0 && st.floorK2Db <= 20 * Math.log10(EPS) + 1
            ? true // k=2が帯域外（ナイキスト超）で常に無音の音高は、このゲートを免除する
            : sal.k2Db > st.floorK2Db + f0ThresholdDb;
          if (condF0 && condK2) {
            events.push({ midi, t: st.pendingArmT, totalDb: sal.totalDb, f0Db: sal.f0Db, k2Db: sal.k2Db });
            st.lastOnsetT = t;
          }
          st.pendingArmT = null;
        }
      }
    }
    return events;
  }

  function getState(midi) {
    const st = states.get(midi);
    return st ? { floorDb: st.floorDb, floorF0Db: st.floorF0Db, floorK2Db: st.floorK2Db } : null;
  }

  function reset() {
    states.clear();
  }

  return { step, getState, reset };
}

// ---------------------------------------------------------------------------
// 判定・得点
// ---------------------------------------------------------------------------
export const JUDGE_PERFECT_MS = 70;
export const JUDGE_GOOD_MS = 150;

export function classifyTiming(diffMs, opts = {}) {
  const perfectMs = opts.perfectMs ?? JUDGE_PERFECT_MS;
  const goodMs = opts.goodMs ?? JUDGE_GOOD_MS;
  const a = Math.abs(diffMs);
  if (a <= perfectMs) return 'PERFECT';
  if (a <= goodMs) return 'GOOD';
  return 'MISS';
}

// comboBefore: このヒット前までのコンボ数
export function scoreForHit(kind, comboBefore) {
  if (kind === 'PERFECT') return 100 * (1 + Math.min(comboBefore, 50) / 100);
  if (kind === 'GOOD') return 50 * (1 + Math.min(comboBefore, 50) / 100);
  return 0;
}

// ---------------------------------------------------------------------------
// 鍵盤範囲
// ---------------------------------------------------------------------------
export function computeKeyboardRange(minMidi, maxMidi, marginWhite = 2) {
  let lo = minMidi;
  while (!isWhiteKey(lo)) lo--;
  let hi = maxMidi;
  while (!isWhiteKey(hi)) hi++;
  for (let i = 0; i < marginWhite; i++) {
    do { lo--; } while (!isWhiteKey(lo));
    do { hi++; } while (!isWhiteKey(hi));
  }
  lo = Math.max(MIN_PIANO_MIDI, lo);
  hi = Math.min(MAX_PIANO_MIDI, hi);
  return { lo, hi };
}

// ---------------------------------------------------------------------------
// 和音グループ化・ゲーム進行（「ながれる」「まつ」共通の時計とスコア）
// ---------------------------------------------------------------------------
const GROUP_EPS_SEC = 0.0005;

export function buildChordGroups(notes, hand = 'both') {
  const filtered = hand === 'both' ? notes.slice() : notes.filter((n) => n.h === hand);
  const sorted = filtered.slice().sort((a, b) => a.t - b.t || a.m - b.m);
  const groups = [];
  for (const n of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.t - n.t) < GROUP_EPS_SEC) last.notes.push(n);
    else groups.push({ t: n.t, notes: [n] });
  }
  return groups;
}

const JUDGE_WINDOW_SEC = JUDGE_GOOD_MS / 1000;

// chart: 譜面JSON（§2）。opts: {hand,mode,offsetMs,speed}
export function createGame(chart, opts = {}) {
  const hand = opts.hand || 'both';
  const mode = opts.mode || 'flow'; // 'flow'=ながれる / 'wait'=まつ
  const offsetMs = opts.offsetMs || 0;
  const speed = opts.speed || 1;

  const scaledNotes = chart.notes.map((n) => ({ ...n, t: n.t / speed, d: n.d / speed }));
  const groups = buildChordGroups(scaledNotes, hand);
  const hitSets = groups.map(() => new Set());

  let clock = 0;
  let idx = 0;
  let combo = 0;
  let maxCombo = 0;
  let score = 0;
  const counts = { PERFECT: 0, GOOD: 0, MISS: 0 };

  function resolveGroupDone(gi) {
    const g = groups[gi];
    return !!g && hitSets[gi].size >= g.notes.length;
  }

  function advance(dtSec) {
    if (mode === 'wait') {
      const g = groups[idx];
      if (!g) { clock += dtSec; return; }
      if (clock < g.t) {
        clock = Math.min(g.t, clock + dtSec);
      } else if (resolveGroupDone(idx)) {
        clock += dtSec;
      }
      // else: 判定待ちの和音がまだ揃っていない → 時計は止まる
    } else {
      clock += dtSec;
      while (idx < groups.length && clock - groups[idx].t > JUDGE_WINDOW_SEC) {
        const g = groups[idx];
        for (const n of g.notes) {
          if (!hitSets[idx].has(n.m)) {
            counts.MISS++;
            combo = 0;
          }
        }
        idx++;
      }
    }
  }

  // midi: 検出された音, tHit: そのオンセットのゲームクロック時刻（省略時は現在のclockを使う）
  function onOnset(midi, tHit) {
    const useT = tHit === undefined ? clock : tHit;
    for (let gi = idx; gi < groups.length && groups[gi].t <= useT + JUDGE_WINDOW_SEC; gi++) {
      const g = groups[gi];
      if (Math.abs(useT - g.t) > JUDGE_WINDOW_SEC) continue;
      if (hitSets[gi].has(midi)) continue;
      if (!g.notes.some((n) => n.m === midi)) continue;

      hitSets[gi].add(midi);
      let kind;
      if (mode === 'wait') {
        kind = 'PERFECT';
      } else {
        const diffMs = (useT - offsetMs / 1000 - g.t) * 1000;
        kind = classifyTiming(diffMs);
      }
      if (kind === 'MISS') {
        counts.MISS++;
        combo = 0;
      } else {
        counts[kind]++;
        score += scoreForHit(kind, combo);
        combo++;
        if (combo > maxCombo) maxCombo = combo;
      }
      if (gi === idx && resolveGroupDone(idx)) idx++;
      return { groupIndex: gi, kind };
    }
    return null;
  }

  function getState() {
    return {
      score, combo, maxCombo,
      counts: { ...counts },
      clock, resolvedGroups: idx, totalGroups: groups.length,
    };
  }

  function isFinished() {
    return idx >= groups.length;
  }

  // 現在の時計から windowSec 以内にある、まだ当たっていない音高（判定対象＝マイク検出の対象を絞るため）
  function getPendingMidis(windowSec = 0.3) {
    const set = new Set();
    for (let gi = idx; gi < groups.length && groups[gi].t <= clock + windowSec; gi++) {
      const g = groups[gi];
      if (Math.abs(clock - g.t) > windowSec) continue;
      for (const n of g.notes) if (!hitSets[gi].has(n.m)) set.add(n.m);
    }
    return set;
  }

  return { advance, onOnset, getState, isFinished, getPendingMidis, groups };
}
