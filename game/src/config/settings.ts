import type { Difficulty } from '../sim/Simulation.ts';

/**
 * Налаштування гравця.
 *
 * З'явилися після евристичної самоперевірки з `testing-plan.md`: у грі не
 * було **жодного** налаштування, що порушує і евристику Pinelle про
 * можливість налаштувати складність, і базовий рівень
 * Game Accessibility Guidelines.
 *
 * Три з чотирьох пунктів — суто подача й нічого не міняють у симуляції.
 * Четвертий, складність, міняє: вона їде разом із раном на сервер, і сервер
 * переграє ран саме з нею.
 */
export type Settings = {
  /** Швидкість стіни. Єдиний пункт, що впливає на симуляцію. */
  difficulty: Difficulty;
  /**
   * Форма замість кольору. Чужі лінії стають пунктирними завжди, а тут
   * додатково знебарвлюються до світлого, щоб не спиратися на пару
   * бірюзовий/помаранчевий — саме її плутають при дейтеранопії.
   */
  colorSafe: boolean;
  /** Крупний текст HUD. Розмір тексту — у трійці найчастіших скарг. */
  bigText: boolean;
  /** Тактильний відгук. Комусь він заважає, комусь недоступний. */
  haptics: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'normal',
  colorSafe: false,
  bigText: false,
  haptics: true,
};

const KEY = 'pav.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const j = JSON.parse(raw) as Partial<Settings>;
    return {
      difficulty: j.difficulty === 'calm' ? 'calm' : 'normal',
      colorSafe: j.colorSafe === true,
      bigText: j.bigText === true,
      haptics: j.haptics !== false,
    };
  } catch {
    // Приватний режим, вимкнене сховище, зіпсований JSON — гра має
    // працювати в усіх трьох випадках.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* нічого страшного */ }
}

/**
 * Що гравець уже вміє. Підказки зникають за ДІЄЮ, а не за таймером:
 * базовий рівень Game Accessibility Guidelines вимагає, щоб текст ішов у
 * темпі гравця. Раніше підказка гасла через 150 кадрів незалежно від того,
 * чи встиг хтось її прочитати.
 */
export type Learned = { attached: boolean; released: boolean };

const LEARN_KEY = 'pav.learned';

export function loadLearned(): Learned {
  try {
    const raw = localStorage.getItem(LEARN_KEY);
    if (!raw) return { attached: false, released: false };
    const j = JSON.parse(raw) as Partial<Learned>;
    return { attached: j.attached === true, released: j.released === true };
  } catch {
    return { attached: false, released: false };
  }
}

export function saveLearned(l: Learned): void {
  try { localStorage.setItem(LEARN_KEY, JSON.stringify(l)); } catch { /* дрібниця */ }
}
