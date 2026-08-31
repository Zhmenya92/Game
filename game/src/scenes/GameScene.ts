import Phaser from 'phaser';
import { BALANCE } from '../config/balance.ts';
import { Simulation } from '../sim/Simulation.ts';
import { InputTrace } from '../sim/InputTrace.ts';
import { selectVisible } from '../sim/Web.ts';
import { selectTarget } from '../sim/Targeting.ts';
import { buildSwarm, type Attempt, type ReplayTrack } from '../sim/Replay.ts';
import { buildFromTraces } from '../sim/Web.ts';
import { api, type RemoteRun } from '../net/api.ts';
import { telegram } from '../net/telegram.ts';
import type { Segment } from '../sim/types.ts';
import { COL, skinHero, skinTrail } from '../config/palette.ts';
import { ads } from '../net/ads.ts';
import { SpritePool } from '../render/SpritePool.ts';
import * as S from '../render/scene.ts';
import type { View } from '../render/scene.ts';

/**
 * Рендер і джус.
 *
 * Тиждень 2 дав джус (squash & stretch, hit-stop, частинки, спалах, тряска)
 * і РІЙ НЕВДАЧ — усі спроби на сіді програються одночасно; прецедент —
 * Multi-Play у Super Meat Boy.
 *
 * Тиждень 5 замінив негайне малювання `Graphics` на спрайти одного атласа
 * (`tools/makeAtlas.ts`). Причина не косметична: кожна зміна стилю в
 * `Graphics` скидає пакет WebGL, тобто коштує окремого виклику малювання, а
 * технічний гейт плану — 1–2 виклики на сцену. Усе ігрове поле тепер іде
 * однією текстурою.
 *
 * Симуляція нічого не знає ні про Phaser, ні про екран. Сцена тільки читає стан.
 */

/** Зум камери й скільки світу він показує — потрібно для замощення.
 *  Одна константа на обидва місця: розʼїхавшись, вони дали б смугу
 *  незамощеного фону на краю екрана. */
const ZOOM = 0.78;
const VIEW_W = BALANCE.viewWidth / ZOOM;
const VIEW_H = BALANCE.bandHeight / ZOOM;

/**
 * 'offer' — коротка пропозиція продовжити після хорошого рану (тиждень 6).
 * Окремий стан, бо звичайна смерть мусить лишатися МИТТЄВОЮ: гейт 1 вимагає
 * рестарту менше ніж за 400 мс, і пропозиція на кожну смерть його вбила б.
 */
type Mode = 'play' | 'dead' | 'offer' | 'swarm';
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; c: number };

export class GameScene extends Phaser.Scene {
  private sim!: Simulation;
  private trace!: InputTrace;
  private mode: Mode = 'play';
  private accumulator = 0;
  private pointerDown = false;
  private seed = 1;
  private day = 0;
  private best = 0;
  private markedAt = -1;
  private hitStopUntil = 0;
  private flash = 0;

  private foreignWeb: Segment[] = [];
  private trail: { x: number; y: number }[] = [];
  private particles: Particle[] = [];

  /** Усі спроби на поточному сіді — з них будується рій. */
  private attempts: Attempt[] = [];
  private swarm: ReplayTrack[] = [];
  private swarmFrame = 0;

  /** Мережа: чужі рани цього чату на цьому сіді. */
  private remoteRuns: RemoteRun[] = [];
  private online = false;
  private netNote = '';

  /** Віральна петля: вхідний виклик і власний останній ран для вихідного. */
  private incomingToken: string | null = null;
  private challengerScore = 0;
  private lastRunId: string | null = null;
  private shareNote = '';
  private btnShare!: Phaser.GameObjects.Text;

  /** Монетизація й аналітика, тиждень 6. */
  private revives = 0;
  private skin: string | null = null;
  private offerUntil = 0;
  private offerNote = '';
  private busy = false;
  private runStartedAt = 0;
  /** Найкращий чужий рахунок на цьому сіді — для події ghost_beaten. */
  private rivalBest = 0;
  private beatenSent = false;
  private starsAvailable = false;
  private devGrant = false;
  private btnContinue!: Phaser.GameObjects.Text;
  private btnAd!: Phaser.GameObjects.Text;

  private atlasError = '';
  /** Гра не запустилась: симуляції немає, цикл не має чого крутити. */
  private broken = false;
  private gSky!: Phaser.GameObjects.Graphics;
  /** Чужа павутина не змінюється протягом рану — окремий пул, що не
   *  перебудовується щокадру. */
  private bg!: SpritePool;
  private webPool!: SpritePool;
  private world!: SpritePool;
  private txtScore!: Phaser.GameObjects.Text;
  private txtSub!: Phaser.GameObjects.Text;
  private txtHint!: Phaser.GameObjects.Text;

  constructor() { super('game'); }

  preload(): void {
    // Один атлас на всю гру. Формат Phaser «JSON Hash» — той самий, що видає
    // TexturePacker, тож справжній арт ляже сюди без правок коду.
    this.load.atlas('atlas', 'atlas.png', 'atlas.json');
    // Без атласа кожен спрайт малюється зеленим квадратом-заглушкою, і екран
    // виглядає зламаним без жодного повідомлення. Краще сказати прямо.
    this.load.on('loaderror', (f: { key?: string }) => {
      this.atlasError = `не завантажився ${f?.key ?? 'атлас'}`;
    });
  }

  create(): void {
    const w = BALANCE.viewWidth;
    const h = BALANCE.bandHeight;

    // Небо лишається `Graphics`: це один статичний прямокутник, який
    // малюється раз і ніколи не перебудовується. Запікати градієнт у
    // текстуру заради одного виклику малювання невигідно.
    this.gSky = this.add.graphics().setScrollFactor(0).setDepth(-20);
    this.gSky.fillGradientStyle(COL.skyTop, COL.skyTop, COL.skyBottom, COL.skyBottom, 1);
    this.gSky.fillRect(-w, -h, w * 3, h * 3);

    // Два пули, обидва на одному атласі: доки між ними немає нічого з
    // іншою текстурою, GPU бачить їх одним пакетом.
    this.bg = new SpritePool(this, -10);
    this.webPool = new SpritePool(this, 0);
    this.world = new SpritePool(this, 1);

    this.txtScore = this.add.text(w / 2, 54, '0', {
      fontFamily: 'ui-monospace, "SF Mono", monospace', fontSize: '96px', color: '#ffffff',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(20);

    this.txtSub = this.add.text(w / 2, 158, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '30px', color: '#8fa8a4',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(20);

    this.txtHint = this.add.text(w / 2, h * 0.62, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '40px', color: '#ffffff', align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(20);

    // Кнопка виклику. Живе лише на екрані рою: саме там є що надсилати —
    // рекорд і всі спроби, що до нього привели.
    this.btnShare = this.add.text(w / 2, h - 130, 'КИНУТИ ВИКЛИК', {
      fontFamily: 'ui-monospace, monospace', fontSize: '44px', color: '#0a1420',
      backgroundColor: '#4fd1bc', padding: { x: 44, y: 22 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(25).setVisible(false).setInteractive();
    this.btnShare.on('pointerdown', (_p: unknown, _x: number, _y: number, e: { stopPropagation: () => void }) => {
      e?.stopPropagation?.();
      void this.share();
    });

    // Дві кнопки пропозиції. Живуть лише в режимі 'offer'.
    this.btnContinue = this.add.text(w / 2, h * 0.52, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '40px', color: '#0a1420',
      backgroundColor: '#ffe9a8', padding: { x: 34, y: 18 }, align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(25).setVisible(false).setInteractive();
    this.btnContinue.on('pointerdown', (_p: unknown, _x: number, _y: number, e: { stopPropagation: () => void }) => {
      e?.stopPropagation?.();
      void this.useContinue();
    });

    this.btnAd = this.add.text(w / 2, h * 0.62, '', {
      fontFamily: 'ui-monospace, monospace', fontSize: '34px', color: '#0a1420',
      backgroundColor: '#4fd1bc', padding: { x: 30, y: 16 }, align: 'center',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(25).setVisible(false).setInteractive();
    this.btnAd.on('pointerdown', (_p: unknown, _x: number, _y: number, e: { stopPropagation: () => void }) => {
      e?.stopPropagation?.();
      void this.earnContinue();
    });

    const down = () => { this.onPress(); };
    const up = () => { this.pointerDown = false; };
    this.input.on('pointerdown', down);
    this.input.on('pointerup', up);
    this.input.on('pointerupoutside', up);
    this.input.keyboard?.on('keydown-SPACE', down);
    this.input.keyboard?.on('keyup-SPACE', up);
    this.input.keyboard?.on('keydown-R', () => this.newSeed());

    if (this.atlasError || !this.textures.exists('atlas')) {
      // Далі йти немає сенсу: без текстури гра показала б порожні квадрати.
      this.broken = true;
      this.txtHint.setText(`АТЛАС НЕ ЗАВАНТАЖИВСЯ
${this.atlasError || 'немає текстури atlas'}

запустіть npm run atlas`);
      return;
    }

    this.cameras.main.setZoom(ZOOM);
    telegram.init();
    this.restart(1);
    void this.connect();
  }

  /**
   * Підключення до бекенду. Гра вже йде — мережа лише додає чужі лінії.
   * Жоден збій тут не має ламати гру, тому все через м'які фолбеки.
   */
  private async connect(): Promise<void> {
    const ses = await api.session();
    this.online = !!ses?.ok;
    void api.event('app_open');
    if (!this.online) { this.netNote = 'офлайн'; return; }
    this.revives = ses?.revives ?? 0;
    this.skin = ses?.skin ?? null;
    const sh = await api.shop();
    if (sh?.ok) {
      this.revives = sh.revives;
      this.skin = sh.skin ?? this.skin;
      this.starsAvailable = sh.starsAvailable;
      this.devGrant = !!sh.devGrant;
    }
    this.netNote = telegram.inside ? `Telegram ${telegram.version}` : 'браузер';

    // Діп-лінк: t.me/<bot>/<app>?startapp=<токен> (plan.md, 8.2).
    // Якщо гру відкрили за викликом — грається ТА САМА траса, і саме це
    // робить порівняння чесним.
    const token = telegram.startParam();
    if (token) {
      const c = await api.openChallenge(token);
      if (c) {
        this.incomingToken = token;
        this.challengerScore = c.score;
        void api.event('challenge_opened');
        await this.loadSeed(c.seed);
        return;
      }
    }

    const d = await api.daily();
    await this.loadSeed(d?.seed ?? this.seed);
  }

  /** Кинути виклик: створити посилання на цей сід із власним рахунком. */
  private async share(): Promise<void> {
    if (!this.online || !this.lastRunId) { this.shareNote = 'нема що надсилати'; return; }
    const c = await api.challenge(this.seed, this.lastRunId);
    if (!c) { this.shareNote = 'сервер не дав виклику'; return; }
    // ДЕФЕКТ 40. Подія йшла ДО створення виклику, тож натискання, яке нічим
    // не закінчилось, усе одно потрапляло в чисельник share rate. Гейт 3
    // міряє шери, а не наміри, — тому подія лише коли посилання існує.
    void api.event('share_click');

    const text = `Мій рахунок ${c.score}. Та сама траса, спробуй обійти.`;
    const nav = navigator as Navigator & { share?: (d: unknown) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ text, url: c.link });
        this.shareNote = 'надіслано';
        return;
      } catch (e) {
        // ДЕФЕКТ 41. Будь-яка відмова вважалася скасуванням і глушила
        // фолбек. У вебв'ю Telegram share падає з NotAllowedError, коли
        // виклик не визнано жестом користувача, — і гравець лишався без
        // посилання взагалі. Скасування — це лише AbortError; решта
        // провалюється в копіювання нижче.
        if ((e as { name?: string })?.name === 'AbortError') {
          this.shareNote = 'скасовано';
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${c.link}`);
      this.shareNote = 'посилання скопійовано';
    } catch {
      // Без HTTPS буфера обміну немає — показуємо саме посилання, щоб його
      // можна було переписати вручну.
      this.shareNote = c.link;
    }
  }

  /** Забрати чужі рани для сіду й перебудувати павутину. */
  private async loadSeed(seed: number): Promise<void> {
    this.remoteRuns = await api.runs(seed);
    // З ким саме змагаємось. Якщо прийшли за викликом — з тим, хто кинув;
    // інакше — з найкращим чужим раном на цій трасі.
    this.rivalBest = this.incomingToken
      ? this.challengerScore
      : this.remoteRuns.reduce((m, r) => Math.max(m, r.score), 0);
    this.attempts = [];
    this.best = 0;
    // Рекорд належав минулій трасі — виклик за ним кинути вже не можна.
    this.lastRunId = null;
    this.seed = seed;
    this.rebuildForeignWeb();
    this.restart(seed);
  }

  /** Павутина з чужих ранів. Той самий код, що й на сервері, — інакше
   *  верифікація відхилятиме чесні рани. */
  private rebuildForeignWeb(): void {
    if (!this.remoteRuns.length) return;
    const traces = this.remoteRuns
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(r => ({
        ownerId: r.ownerId,
        trace: InputTrace.deserialize(Uint8Array.from(atob(r.traceB64), c => c.charCodeAt(0))),
        day: r.day,
      }));
    this.foreignWeb = selectVisible(buildFromTraces(this.seed, traces), BALANCE.foreignLineLimit);
  }

  /** Натискання означає різне залежно від стану. */
  private onPress(): void {
    if (this.mode === 'swarm') { this.endSwarm(); return; }
    // Тап повз кнопки = «ні, дякую». Пропозиція не має ставати перешкодою.
    if (this.mode === 'offer') { this.declineOffer(); return; }
    this.pointerDown = true;
  }

  private newSeed(): void {
    this.attempts = [];
    this.foreignWeb = [];
    this.day = 0;
    this.best = 0;
    // ДЕФЕКТ 39. Гравець, що прийшов за викликом, після зміни траси більше
    // не відповідає на нього: інакше у reply rate потрапляв би ран з
    // іншого сіду. Сервер це теж перевіряє — тут просто не брешемо йому.
    this.lastRunId = null;
    this.incomingToken = null;
    this.restart(this.seed + 1);
  }

  private restart(seed: number): void {
    // Павутина минулого рану стає «чужою»: так у тижні 1 перевіряється ідея К4
    // без бекенду — чужі лінії симулюються власним попереднім раном.
    if (!this.online && this.sim && this.sim.ownWeb.length && seed === this.seed) {
      this.foreignWeb = selectVisible(
        this.foreignWeb.concat(this.sim.ownWeb.map(s => ({ ...s, ownerId: 1, bornDay: this.day }))),
        BALANCE.foreignLineLimit,
      );
      this.day++;
    }
    this.seed = seed;
    this.sim = new Simulation(seed, this.foreignWeb);
    this.trace = new InputTrace();
    this.mode = 'play';
    this.accumulator = 0;
    this.markedAt = -1;
    this.trail.length = 0;
    this.particles.length = 0;
    this.runStartedAt = this.time.now;
    this.beatenSent = false;
    this.bakeWeb();
    if (this.online) void api.event('run_start', { seed, attempt: this.attempts.length + 1 });
  }


  // ── Джус ──────────────────────────────────────────────────────────────
  private burst(x: number, y: number, n: number, color: number, power: number): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = power * (0.4 + Math.random() * 0.9);
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - power * 0.2,
        life: 1, max: 0.35 + Math.random() * 0.4, c: color,
      });
    }
  }

  private buzz(kind: 'light' | 'heavy' | 'fail'): void {
    telegram.haptic(kind);
  }

  private onDeath(): void {
    const s = this.sim.state;
    this.mode = 'dead';
    this.markedAt = this.time.now;
    this.hitStopUntil = this.time.now + 70;     // hit-stop 70 мс
    this.flash = 0.55;
    this.cameras.main.shake(180, 0.014);
    this.burst(s.px, s.py, 22, COL.chase, 520);
    this.buzz('fail');

    const cause = this.sim.result()?.deathReason ?? 'fell';
    if (this.online) {
      void api.event('run_end', {
        score: s.score,
        ms: Math.round(this.time.now - this.runStartedAt),
        cause,
        revives: s.revives,
      });
    }

    // Пропозиція продовжити — тільки після ЗМІСТОВНОГО рану. Інакше вона
    // з'являлася б на кожній смерті через дві секунди й перетворила б
    // миттєвий рестарт (гейт 1) на клікер по банерах.
    if (this.canOffer(s.score)) {
      this.mode = 'offer';
      this.offerUntil = this.time.now + 4000;
      this.offerNote = '';
      this.refreshOffer();
      return;
    }

    this.finishRun();
  }

  /**
   * Ран остаточно завершено: спроба лягає в рій, ран іде на сервер.
   *
   * Окремий метод, бо викликається з двох місць — звичайної смерті й
   * відмови від продовження. Поки це був хвіст `onDeath`, друге місце
   * просто не надсилало ран, і рекорд із продовженням зникав.
   */
  private finishRun(): void {
    const s = this.sim.state;
    this.attempts.push({
      trace: this.trace, frames: s.frame, score: s.score, index: this.attempts.length + 1,
    });
    if (this.attempts.length > 60) this.attempts.shift();
    void this.submit(s.score, s.frame);

    // Рій показуємо на рекорді — саме тоді він і є історією: «ось усі рази,
    // коли я ламався, і ось цей». В інших випадках рестарт миттєвий.
    if (s.score > this.best && this.attempts.length >= 3) {
      this.best = s.score;
      this.startSwarm();
    } else if (s.score > this.best) {
      this.best = s.score;
    }
  }

  // ── Продовження (plan.md, 10.2) ───────────────────────────────────────

  /**
   * Чи пропонувати продовження. Три умови, і кожна має причину:
   *   • ран був змістовним — інакше банер вискакує кожні дві секунди й
   *     ламає миттєвий рестарт, якого вимагає гейт 1;
   *   • стеля воскресінь на ран не вибрана — її перевіряє й сервер;
   *   • є чим продовжити або є де взяти.
   */
  private canOffer(score: number): boolean {
    if (!this.online) return false;
    if (this.sim.state.revives >= BALANCE.reviveMaxPerRun) return false;
    if (score < Math.max(60, Math.floor(this.best * 0.7))) return false;
    return this.revives > 0 || ads.configured || this.starsAvailable || this.devGrant;
  }

  private refreshOffer(): void {
    const canBuy = this.starsAvailable || this.devGrant;
    this.btnContinue.setVisible(this.revives > 0)
      .setText(`ПРОДОВЖИТИ  ×${this.revives}`);
    if (ads.configured) {
      this.btnAd.setVisible(true).setText('РЕКЛАМА  +1');
    } else if (canBuy) {
      this.btnAd.setVisible(true).setText('3 ПРОДОВЖЕННЯ  25 ⭐');
    } else {
      this.btnAd.setVisible(false);
    }
  }

  private hideOffer(): void {
    this.btnContinue.setVisible(false);
    this.btnAd.setVisible(false);
  }

  /** Відмова або таймаут: ран завершується як звичайна смерть. */
  private declineOffer(): void {
    if (this.mode !== 'offer') return;
    this.mode = 'dead';
    this.markedAt = this.time.now;
    this.hideOffer();
    this.finishRun();
  }

  /**
   * Витратити продовження.
   *
   * Воскресіння записується В ТРЕК. Без цього сервер переграє ран без
   * воскресіння, отримає менший рахунок і відхилить ЧЕСНИЙ ран як накрутку.
   */
  private async useContinue(): Promise<void> {
    if (this.busy || this.mode !== 'offer') return;
    if (this.revives <= 0) { this.offerNote = 'продовжень немає'; return; }
    this.busy = true;
    // Спершу оплата, потім воскресіння. Зворотний порядок — це дірка
    // в економіці: гравець воскресає й просто не надсилає ран (дефект 51).
    const paid = await api.reserveRevive();
    if (!paid?.ok) {
      this.offerNote = paid?.reason ?? 'сервер не підтвердив';
      this.busy = false;
      return;
    }
    this.revives = paid.revives ?? Math.max(0, this.revives - 1);
    if (this.sim.revive()) {
      this.trace.record(this.sim.state.frame, 'revive');
      this.mode = 'play';
      this.offerUntil = 0;
      this.hideOffer();
      this.flash = Math.max(this.flash, 0.35);
      this.buzz('heavy');
      this.burst(this.sim.state.px, this.sim.state.py, 14, COL.anchorLive, 260);
    } else {
      this.offerNote = 'більше не можна';
    }
    this.busy = false;
  }

  /**
   * Дістати продовження: реклама, якщо налаштована, інакше покупка.
   *
   * Реклама НЕ нараховує нічого сама: нарахування робить серверний колбек
   * Adsgram із секретом. Тому після показу баланс просто перечитується —
   * якщо колбек не прийшов, продовження не буде, і це правильно.
   */
  private async earnContinue(): Promise<void> {
    if (this.busy || this.mode !== 'offer') return;
    this.busy = true;
    this.offerUntil = this.time.now + 60000;   // поки триває реклама чи оплата
    try {
      if (ads.configured) {
        void api.event('ad_offer', { score: this.sim.state.score });
        this.offerNote = 'реклама…';
        const shown = await ads.show();
        if (!shown) { this.offerNote = 'реклами немає'; return; }
        this.offerNote = 'зараховуємо…';
        await this.refreshWallet(1500);
      } else {
        this.offerNote = 'оплата…';
        const inv = await api.invoice('revive3');
        if (!inv?.ok) { this.offerNote = inv?.reason ?? 'магазин недоступний'; return; }
        if (inv.dev) {
          this.revives = inv.revives ?? this.revives;
          this.offerNote = inv.note ?? 'видано в режимі розробки';
        } else if (inv.link) {
          const st = await telegram.openInvoice(inv.link);
          if (st !== 'paid') { this.offerNote = st === 'cancelled' ? 'скасовано' : st; return; }
          void api.event('iap_purchased', { product: 'revive3' });
          await this.refreshWallet(0);
        }
      }
      if (this.revives > 0) this.offerNote = '';
    } finally {
      this.busy = false;
      this.offerUntil = this.time.now + 6000;
      this.refreshOffer();
    }
  }

  /** Перечитати баланс із сервера. Клієнт свій баланс не вигадує. */
  private async refreshWallet(delayMs: number): Promise<void> {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    const sh = await api.shop();
    if (sh?.ok) this.revives = sh.revives;
  }

  /** Рахунок перевіряє сервер, переграючи трек. Клієнту не вірять. */
  private async submit(score: number, frames: number): Promise<void> {
    if (!this.online) return;
    const bytes = this.trace.serialize();
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const r = await api.submit({
      seed: this.seed,
      traceB64: btoa(bin),
      score, frames,
      webRunIds: this.remoteRuns.map(x => x.id),
      challengeToken: this.incomingToken,
    });
    if (r && r.ok === false) this.netNote = `сервер відхилив: ${r.reason ?? '?'}`;
    if (r && r.ok && r.id) this.lastRunId = r.id;
    void api.event('run_end');
    // ДЕФЕКТ 42. Подія летіла на КОЖНОМУ рані, доки токен був виставлений,
    // хоча відповідь зараховується лише перша. Сервер повертає repliedTo
    // тільки коли справді зарахував — на нього й спираємось.
    if (r && r.ok && r.repliedTo) {
      void api.event('challenge_replied');
      this.incomingToken = null;
    }
  }

  private startSwarm(): void {
    this.mode = 'swarm';
    this.swarm = buildSwarm(this.seed, this.attempts, this.foreignWeb);
    this.swarmFrame = 0;
    this.shareNote = '';
    this.btnShare.setVisible(this.online);
  }

  private endSwarm(): void {
    this.swarm = [];
    this.btnShare.setVisible(false);
    this.restart(this.seed);
  }

  // ── Цикл ──────────────────────────────────────────────────────────────
  update(_t: number, delta: number): void {
    if (this.broken) return;          // симуляції не існує — крутити нічого
    const now = this.time.now;

    if (this.mode === 'swarm') {
      this.stepSwarm();
      this.drawSwarm();
      this.decayParticles(delta);
      return;
    }

    const s = this.sim.state;
    if (this.mode === 'play' && now >= this.hitStopUntil) {
      this.accumulator += Math.min(delta, 100) / 1000;
      let steps = 0;
      while (this.accumulator >= BALANCE.dt && steps < BALANCE.maxStepsPerFrame) {
        if (this.trace.isDownAt(s.frame) !== this.pointerDown) {
          this.trace.record(s.frame, this.pointerDown ? 'down' : 'up');
        }
        const wasAttached = s.attached;
        this.sim.step(this.pointerDown);
        if (!wasAttached && s.attached) {          // щойно зачепився
          this.flash = Math.max(this.flash, 0.18);
          this.burst(s.ax, s.ay, 7, COL.anchorLive, 190);
          this.buzz('light');
        }
        this.accumulator -= BALANCE.dt;
        steps++;
        this.trail.push({ x: s.px, y: s.py });
        if (this.trail.length > 26) this.trail.shift();
        if (!s.alive) { this.onDeath(); break; }
      }
    } else if (this.mode === 'dead' && now - this.markedAt > BALANCE.restartDelayMs) {
      this.restart(this.seed);
    } else if (this.mode === 'offer' && now > this.offerUntil) {
      // Мовчання — теж відповідь. Гра не має чекати рішення нескінченно.
      this.declineOffer();
    }

    const cam = this.cameras.main;
    cam.scrollX = s.px - (BALANCE.viewWidth / cam.zoom) * BALANCE.cameraPlayerX;
    cam.scrollY = s.py - (BALANCE.bandHeight / cam.zoom) * 0.5;

    this.decayParticles(delta);
    this.draw();
  }

  private stepSwarm(): void {
    // Рій іде трохи швидше за реальний час: 3 кроки на кадр ≈ 1.5×.
    for (let i = 0; i < 3; i++) {
      let anyLeft = false;
      for (const t of this.swarm) { if (!t.done) { t.step(); anyLeft = true; } }
      this.swarmFrame++;
      if (!anyLeft) break;
    }
  }

  private decayParticles(delta: number): void {
    const dt = Math.min(delta, 60) / 1000;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt / p.max;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy += 1400 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  // ── Малювання ─────────────────────────────────────────────────────────
  //
  // Сама розкладка живе в `render/scene.ts` і про Phaser не знає. Тут лише
  // те, що без рушія неможливе: пули спрайтів, камера й текст HUD.

  private view(): View {
    const cam = this.cameras.main;
    return { camX: cam.scrollX, camY: cam.scrollY, w: VIEW_W, h: VIEW_H };
  }

  /** Чужа павутина за рану не змінюється — розкладається раз на рестарті. */
  private bakeWeb(): void {
    this.webPool.begin();
    S.drawForeignWeb(this.webPool, this.foreignWeb);
    this.webPool.end();
  }

  private draw(): void {
    const s = this.sim.state;
    const p = this.world;
    const v = this.view();

    this.bg.begin();
    S.drawBackground(this.bg, v, s.killX, s.frame);
    this.bg.end();

    p.begin();
    const live = s.attached ? null
      : selectTarget(s.px, s.py, this.sim.track.candidates(s.px), this.foreignWeb.concat(this.sim.ownWeb));
    S.drawAnchors(p, this.sim.track.anchors, s.px, live, s.frame);
    S.drawOwnWeb(p, this.sim.ownWeb);
    S.drawTrail(p, this.trail, skinTrail(this.skin));
    S.drawRope(p, s, live);
    S.drawShadow(p, s.px, s.py);
    S.drawBody(p, s.px, s.py, s.vx, s.vy, s.alive ? skinHero(this.skin) : COL.chase, 1);
    S.drawParticles(p, this.particles);
    S.drawFlash(p, v, this.flash);
    this.flash *= 0.82;
    p.end();

    if (s.score > this.best && this.mode === 'play') this.best = s.score;
    // «Обійшов конкретного друга» — прямий вимір того, чи працює
    // диференціація (plan.md, 10.1). Шлеться один раз за ран.
    if (!this.beatenSent && this.online && this.rivalBest > 0 && s.score > this.rivalBest) {
      this.beatenSent = true;
      void api.event('ghost_beaten', { score: s.score, rival: this.rivalBest });
    }
    this.txtScore.setText(String(s.score));
    this.txtSub.setText(`рекорд ${this.best}   спроба ${this.attempts.length + 1}   ліній ${this.sim.ownWeb.length + this.foreignWeb.length}` + (this.netNote ? `   ${this.netNote}` : ''));
    this.txtHint.setText(
      this.mode === 'offer'
        ? `ЩЕ РАЗ ІЗ ЦЬОГО МІСЦЯ?\nрахунок ${s.score} лишається${this.offerNote ? '\n' + this.offerNote : ''}`
      : this.mode === 'dead' ? ''
      : s.frame < 150 && this.incomingToken
        ? `ТЕБЕ ВИКЛИКАЛИ\nйого рахунок ${this.challengerScore}\nта сама траса`
      : s.frame < 150 && !s.attached ? 'ТРИМАЙ — чіпляєшся\nВІДПУСТИ — летиш'
      : '',
    );
  }

  private drawSwarm(): void {
    const p = this.world;

    // Камера йде за найдальшим із рою — це і є «переможець».
    let lead = this.swarm[0];
    for (const t of this.swarm) if (t.sim.state.px > lead.sim.state.px) lead = t;
    const ls = lead.sim.state;
    const cam = this.cameras.main;
    cam.scrollX = ls.px - (BALANCE.viewWidth / cam.zoom) * BALANCE.cameraPlayerX;
    cam.scrollY = ls.py - (BALANCE.bandHeight / cam.zoom) * 0.5;
    const v = this.view();

    this.bg.begin();
    S.drawBackground(this.bg, v, ls.killX, this.swarmFrame);
    this.bg.end();

    p.begin();
    S.drawAnchors(p, lead.sim.track.anchors, ls.px, null, this.swarmFrame);

    let died = 0;
    for (const t of this.swarm) {
      const st = t.sim.state;
      const isLead = t === lead;
      if (!st.alive) died++;
      if (st.attached) {
        p.line(st.ax, st.ay, st.px, st.py, isLead ? 4 : 2,
          isLead ? COL.rope : COL.ghost, isLead ? 1 : 0.25);
      }
      S.drawBody(p, st.px, st.py, st.vx, st.vy,
        !st.alive ? COL.chase : isLead ? COL.player : COL.ghost,
        !st.alive ? 0.35 : isLead ? 1 : 0.4,
        isLead ? 19 : 13);
    }

    S.drawParticles(p, this.particles);
    S.drawFlash(p, v, this.flash);
    this.flash *= 0.82;
    p.end();

    this.txtScore.setText(String(lead.attempt.score));
    this.txtSub.setText(`${this.swarm.length} спроб одночасно · загинуло ${died}`
      + (this.shareNote ? `  ·  ${this.shareNote}` : ''));
    this.txtHint.setText('НОВИЙ РЕКОРД\nусі твої спроби разом\n\nтапни, щоб грати');
  }
}
