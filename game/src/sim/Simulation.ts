import { BALANCE } from '../config/balance.ts';
import { len } from './MathDet.ts';
import { integrate, baseSpeedAt } from './physics.ts';
import { Track } from './Track.ts';
import { makeTrack } from './trackFactory.ts';
import { selectTarget } from './Targeting.ts';
import type { Segment, Target } from './types.ts';

export type SimState = {
  frame: number;
  px: number; py: number;
  vx: number; vy: number;
  attached: boolean;
  /** Точка кріплення — анкер або точка на лінії. */
  ax: number; ay: number;
  ropeLen: number;
  /** true, якщо чіплялися за авторський анкер. Тільки такі породжують лінію. */
  attachedToAnchor: boolean;
  alive: boolean;
  score: number;
  /** Ліва межа смерті, що їде за гравцем. */
  killX: number;
};

export type SimResult = {
  score: number;
  frames: number;
  deathReason: 'fell' | 'left';
};

/**
 * Детермінована симуляція з фіксованим кроком.
 *
 * Фізика троса — позиційне обмеження, БЕЗ тригонометрії: точка проєктується
 * на коло радіуса ropeLen навколо анкера, радіальна складова швидкості
 * обнуляється. Тільки +, −, ×, ÷ і sqrt, тобто операції, точно задані
 * IEEE 754 і однакові в будь-якому JS-рушії. Див. MathDet.ts.
 */
export class Simulation {
  readonly track: Track;
  readonly state: SimState;

  /** Чужа павутина — вхід симуляції, не змінюється під час рану. */
  private foreignWeb: Segment[];
  /** Лінії, породжені цим раном. */
  readonly ownWeb: Segment[] = [];

  private prevDown = false;
  private bufferUntilFrame = -1;
  private currentTarget: Target | null = null;
  private releaseIndex = 0;
  private result_: SimResult | null = null;

  constructor(seed: number, foreignWeb: readonly Segment[] = [], track?: Track) {
    this.track = track ?? makeTrack(seed);
    this.foreignWeb = foreignWeb.slice();
    this.state = {
      frame: 0,
      px: BALANCE.startX,
      py: BALANCE.startY,
      vx: BALANCE.baseSpeed,
      vy: 0,
      attached: false,
      ax: 0, ay: 0,
      ropeLen: 0,
      attachedToAnchor: false,
      alive: true,
      score: 0,
      killX: BALANCE.startX - BALANCE.chaseHeadStart,
    };
  }

  /** Базова швидкість на поточному кадрі: +8 од/с кожні 10 с, стеля 520. */
  private baseSpeedNow(): number {
    return baseSpeedAt(this.state.frame);
  }

  /** Усі цілі-відрізки: чужі плюс власні цього рану. */
  private allSegments(): Segment[] {
    return this.foreignWeb.concat(this.ownWeb);
  }

  private tryAttach(): void {
    const s = this.state;
    const t = selectTarget(s.px, s.py, this.track.candidates(s.px), this.allSegments());
    if (!t) return;
    s.attached = true;
    s.ax = t.x;
    s.ay = t.y;
    s.ropeLen = t.dist;
    s.attachedToAnchor = t.kind === 'anchor';
    this.currentTarget = t;
    this.bufferUntilFrame = -1;
    if (t.kind === 'segment') t.segment.hooks += 1;
  }

  private release(): void {
    const s = this.state;
    if (!s.attached) return;
    // Правило рекурсії (бриф, 4.5): лінію лишає ТІЛЬКИ зачеплення за анкер.
    if (s.attachedToAnchor) {
      this.ownWeb.push({
        id: `0:${this.releaseIndex++}`,
        ax: s.ax, ay: s.ay,
        bx: s.px, by: s.py,
        ownerId: 0,
        hooks: 0,
        bornDay: 0,
      });
    }
    // Поштовх на зриві (дефект 29): компенсує втрату висоти за замах.
    const sp = len(s.vx, s.vy);
    const boosted = sp * BALANCE.releaseBoost;
    const capped = boosted > BALANCE.maxSpeed ? BALANCE.maxSpeed : boosted;
    if (sp > 0) { const k = capped / sp; s.vx *= k; s.vy *= k; }
    s.attached = false;
    s.attachedToAnchor = false;
    this.currentTarget = null;
  }

  /** Рівно один крок 1/120 с. Приймає СТАН кнопки, а не подію. */
  step(pointerDown: boolean): void {
    const s = this.state;
    if (!s.alive) return;

    // ── Ввід ────────────────────────────────────────────────────────────
    //
    // ДЕФЕКТ 17, знайдений тестом чесності на день 1.
    // У брифі модель була: тап → якщо цілі немає, буфер 80 мс → і все.
    // З нею УТРИМАННЯ кнопки не робить нічого після закінчення буфера, тому
    // гравець не чіплявся ніколи: перша ціль стає валідною на кадрі ~12, а
    // буфер закінчувався на кадрі 10. Усі 1000 сідів падали за 1.05 с.
    //
    // Правильна модель — як у жанрі: утримання постійно «стріляє» тросом.
    // wantAttach = кнопка натиснута АБО ще діє буфер після короткого тапу.
    // ДЕФЕКТ 24: буфер НЕ можна озброювати на відпусканні. Інакше гравець
    // автоматично перечіплюється протягом 80 мс після зриву, і відпустити трос
    // стає неможливо — у трейсі сіду 1 гравець висів на одному тросі 460 кадрів
    // і його наздогнала межа. Буфер існує лише для натискання без цілі.
    if (!pointerDown && this.prevDown) {
      this.release();
      this.bufferUntilFrame = -1;
    }
    if (pointerDown && !this.prevDown) {
      this.bufferUntilFrame = s.frame + BALANCE.inputBufferFrames;
    }
    const wantAttach = pointerDown || s.frame <= this.bufferUntilFrame;
    if (wantAttach && !s.attached) this.tryAttach();
    this.prevDown = pointerDown;

    // ── Фізика ── спільний крок із генератором траси (physics.ts)
    const dt = BALANCE.dt;
    integrate(s, s.attached, s.ax, s.ay, s.ropeLen, this.baseSpeedNow());

    s.killX += this.baseSpeedNow() * BALANCE.chaseSpeedScale * dt;
    s.frame += 1;
    const score = Math.floor(s.px / 10);
    if (score > s.score) s.score = score;

    // ── Смерть ──────────────────────────────────────────────────────────
    if (s.py > BALANCE.bandHeight) {
      s.alive = false;
      this.result_ = { score: s.score, frames: s.frame, deathReason: 'fell' };
    } else if (s.px < s.killX) {
      s.alive = false;
      this.result_ = { score: s.score, frames: s.frame, deathReason: 'left' };
    }
  }

  result(): SimResult | null {
    return this.result_;
  }

  /**
   * Копія для спекулятивного прорахунку наперед (тест прохідності).
   * Track спільний навмисно: він тільки дописує анкери й робить це
   * детерміновано, тому спільне використання не впливає на результат.
   * ownWeb копіюється поглиблено — інакше гілки псували б лічильники hooks.
   */
  clone(): Simulation {
    const c = Object.create(Simulation.prototype) as Simulation;
    (c as any).track = this.track;
    (c as any).state = { ...this.state };
    (c as any).foreignWeb = this.foreignWeb;
    (c as any).ownWeb = this.ownWeb.map(s => ({ ...s }));
    (c as any).prevDown = this.prevDown;
    (c as any).bufferUntilFrame = this.bufferUntilFrame;
    (c as any).currentTarget = this.currentTarget;
    (c as any).releaseIndex = this.releaseIndex;
    (c as any).result_ = this.result_;
    return c;
  }
}
