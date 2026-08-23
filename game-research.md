# Game Research — мобільна віральна гра з мінімумом анімації

**Дата:** 2026-08-23
**Автор дослідження:** Claude (за запитом власника репо)
**Вхідні вимоги:** мобільна гра · мінімум анімації спрайтів · ассети генеруються AI · простий віральний концепт рівня Flappy Bird · MVP силами 1 людини

---

## 0. TL;DR — що я рекомендую робити

| Питання | Відповідь | Чому коротко |
|---|---|---|
| **Платформа №1** | **Telegram Mini App** (веб), потім сторі через Capacitor | Вірусність вбудована в месенджер; CPI $0.1–0.5 замість $2–6; 500 млн DAU міні-апів |
| **Рушій** | **Phaser 3/4 + TypeScript + Vite** | Білд 1–2 МБ, миттєвий старт у TMA. Godot Web = WASM, ліміти памʼяті, проблеми iOS Safari |
| **Нативний план Б** | Godot 4 (APK 15–25 МБ) або Defold (APK 4–6 МБ) | Якщо метрики підтвердяться і треба сторі + AdMob |
| **Анімація** | **НЕ GIF у рантаймі.** 4–8 PNG-кадрів усього на гру + tween/scale/rotate/particles | GIF: 256 кольорів, 1-бітна прозорість, окремий draw call, CPU-декод |
| **Роль GIF** | Проміжний формат AI-пайплайну + шеринг-кліпи для TikTok/TG | Саме тут GIF корисний, а не всередині гри |
| **AI-пайплайн** | Nano Banana Pro / Scenario (стиль) → PixelLab / Kling+rembg (кадри) → TexturePacker (атлас) | Скорочує арт з тижнів до годин, але потребує ручного проходу вирівнювання |
| **Монетизація** | Telegram Stars IAP + Adsgram rewarded; далі AdMob rewarded | Чистий ad-only hypercasual у 2026 більше не сходиться економічно |
| **Головний ризик** | Платний UA не окупається (CPI > eCPM). Тільки органіка/віральність | eCPM rewarded casual Android упав $3.60 → $3.02 за 2 роки |
| **Концепт** | Одна кнопка + **автоматичний реплей-кліп смерті** → шеринг у чат/TikTok | Кліп — це і є віральна петля, а не «просто гра» |

**Головна теза дослідження:** у 2026 віральність не робиться грою — вона робиться **артефактом, який гра виробляє** (кліп, скор-картка, виклик другу). Механіка має бути настільки простою, щоб бути зрозумілою за 3 секунди відео, а вся інженерна складність має піти в шеринг-петлю.

---

## 1. Стан ринку: чи взагалі варто робити hypercasual у 2026

### 1.1 Погані новини

- **Класичний hypercasual економічно зламався.** CPI зростав швидше за eCPM; ad-only модель перестала сходитися на низькоретеншеному інвентарі.
- **eCPM падає:** casual Android rewarded — $3.60 (H1 2023) → $3.25 (H1 2024) → **$3.02 (H1 2025)**.
- **Обсяг жанру:** hypercasual — менш ніж **$0.5 млрд**, тоді як midcore — $31 млрд, casual — $22 млрд. Це вже нішовий жанр, а не золота лихоманка.
- **Стори закрутили гайки:** Google Play агресивно ріже «rehash existing apps», «thin wrappers», «низькоцінні AI-застосунки». Нові персональні акаунти — обовʼязкові **14 днів closed testing**. Apple типово реджектить за «minimal functionality» (4.3 spam).
- **Ігри в Telegram теж просіли:** гейм-категорія міні-апів **−9%** — клікери-P2E видихлися.

### 1.2 Гарні новини

- **Hybrid casual** — жанр-наступник: hypercasual-хук + мета-шар з IAP. Топові hybrid-тайтли дають **LTV у 3–5× вище** за чистий hypercasual. Voodoo/Homa/Supersonic/Azur індустріалізували мета-шаблони.
- **Telegram:** 1 млрд MAU, **500 млн взаємодій з міні-апами щодня**, CPI **$0.1–0.5** проти $5–20 у вебі, **D7 retention 30–50%** для TMA проти 5–10% у DApps.
- **TikTok як канал відкриття:** **75% TikTok-геймерів** знаходять нові ігри саме там; UGC-креативи обходять ad fatigue.
- **AI-арт зняв головний барʼєр соло-розробника:** −90%+ часу на 2D-ассети.

### 1.3 Висновок для стратегії

Не будувати «чистий hypercasual під платний UA» — ця модель мертва для соло-розробника (CPI $0.50 у Tier-1 при ARPDAU $0.03–0.08 = окупність за 6–16 днів при D7 12%, тобто **не окупається**).

Будувати: **органічно-віральна гра в Telegram → перевірка ретеншену безкоштовно → тільки після проходження гейтів пакування у стори**.

---

## 2. Вибір платформи

### 2.1 Порівняння каналів

| Критерій | Telegram Mini App | App Store / Google Play | itch.io / веб |
|---|---|---|---|
| Час до першого гравця | **години** | 1–4 тижні (ревʼю + 14 днів тестінгу) | години |
| Вартість входу | 0 | $99/рік Apple + $25 Google | 0 |
| Вбудована віральність | **дуже висока** (шер у чат, реферали) | низька (тільки ASO/UA) | нема |
| CPI | $0.1–0.5 | $2.50–6.00 (Tier-1 hybrid) | — |
| Монетизація | Stars, TON, Adsgram | AdMob/AppLovin/IAP — **вищі eCPM** | ~0 |
| Ризик реджекту | мінімальний | **високий** для простої гри |нема |
| Розмір білда | критично (треба <5 МБ) | не критично | не критично |

### 2.2 Рекомендована послідовність

```
Тиждень 1–3   MVP у Telegram Mini App (безкоштовно, швидко, віральна петля)
Тиждень 4–5   Заміри D1/D7/K-фактор на живих гравцях
Гейт          D1 ≥ 30% і K ≥ 0.35 ?
   ├── ТАК →  Capacitor-обгортка → Google Play (closed testing) → App Store
   └── НІ  →  міняємо механіку/хук, повторюємо. Витрати ≈ 0.
```

Це ключова перевага TMA: **ітерація коштує нуль і не спалює ревʼю-репутацію в сторах.**

---

## 3. Вибір рушія

### 3.1 Порівняльна таблиця

| Рушій | Мова | Веб/TMA | Розмір мобільного білда | Реклама | Вердикт для нас |
|---|---|---|---|---|---|
| **Phaser 3/4** | TS/JS | **ідеально** (1–2 МБ, миттєвий старт) | через Capacitor/Cordova | AdMob через Capacitor-плагіни | ✅ **основний вибір** |
| **Godot 4.x** | GDScript | посередньо: тільки Compatibility/WebGL2, ліміт WASM-памʼяті, окремі баги iOS Safari, потрібні COOP/COEP-хедери | 15–25 МБ | зрілі AdMob-плагіни (poingstudios, godot-sdk-integrations), медіація до 15 мереж | 🟡 план Б, якщо йдемо нативно |
| **Defold** | Lua | добре | **4–6 МБ**, мінімум до ~1.6 МБ | є, але екосистема менша | 🟡 найкращий, якщо критичний розмір APK |
| **Unity** | C# | важкий веб | 40+ МБ | найкраща ад-екосистема, ~48% ринку моб. | 🔴 надлишок для одної кнопки |

### 3.2 Обґрунтування Phaser

1. **TMA карає за вагу.** Gif-подібний «інстант-фан» вимагає старту за <2 с на середньому Android у Telegram-вебвʼю. Godot WASM цього не дає надійно.
2. **Один код — обидві цілі.** Той самий білд працює як TMA і як нативний застосунок через Capacitor.
3. **AI-ассети інтегруються тривіально:** JSON-атлас від TexturePacker вантажиться в один рядок.
4. **Ризик:** Phaser не дає нативного перформансу — але одній кнопці й 30 спрайтам його й не треба.

> Якщо все ж хочеться Godot: цільтеся одразу в нативні стори і забудьте про Telegram як основний канал. Змішувати не вийде без болю.

---

## 4. Анімація: чому GIF — не той інструмент, і що робити замість

### 4.1 Чому GIF **не можна** у рантаймі

| Проблема | Наслідок у грі |
|---|---|
| 256 кольорів, палітра | градієнти й мʼякі тіні розсипаються в бендинг |
| **1-бітна прозорість** | брудна «облямівка» по контуру спрайта на будь-якому фоні |
| Кожна гіфка — окрема текстура | +1 **draw call** на кожен обʼєкт; 50 текстур = 50+ draw calls/кадр |
| CPU-декодування покадрово | джанк на слабких Android |
| Немає контролю над таймінгом/подіями | не можна синхронізувати з фізикою |

Для порівняння: спакувати ті самі спрайти у 1–2 **texture atlas** → **1–2 draw calls замість 50+**, менше памʼяті, одне HTTP-завантаження (критично для TMA на мобільній мережі).

### 4.2 Правильний рантайм-формат

- **PNG/WebP sprite atlas** + JSON (TexturePacker, або безкоштовний free-tex-packer).
- У Phaser: `this.load.atlas('game', 'game.png', 'game.json')` → `anims.create({ frames: ... })`.
- Один атлас **2048×2048** — вистачить на всю гру такого масштабу.

### 4.3 Бюджет анімації для нашої гри (мінімум за вимогою)

**Усього кадрів на всю гру: 8–12.** Розкладка:

| Обʼєкт | Кадрів | Як «оживає» |
|---|---|---|
| Герой | **2–4** (нейтраль + дія) | + rotation за вектором швидкості, squash&stretch на скейлі |
| Перешкоди | **1** (статика) | + повільний sin-дрейф позиції/повороту через tween |
| Фон | **2–3** шари | parallax-скрол, нуль кадрів |
| Підбираний обʼєкт | **1** | обертання + пульсація scale + tint |
| Смерть/вибух | **0** | particle emitter (крапки/квадрати) + flash + screenshake |
| UI | **0** | tween-ease на появу/зникнення |

### 4.4 «Джус» без єдиного намальованого кадру

Це те, що робить гру дорогою на вигляд при 8 кадрах арту:

1. **Squash & stretch** — стиснення на приземленні, розтягнення на стрибку. Найсильніший ефект на одиницю зусиль.
2. **Screenshake** — короткий (80–150 мс), малої амплітуди, на кожен удар/смерть. Гравець не помічає свідомо, але відчуває постійно.
3. **Hit-stop / freeze-frame** — 40–80 мс паузи на зіткненні.
4. **Частинки** — 8–15 простих квадратиків замість намальованого вибуху.
5. **Tint-flash** — білий спалах спрайта на 60 мс.
6. **Sin/cos-рух** — плаваючі монети, «дихання» перешкод, погойдування UI.
7. **Easing на всьому** — `Back.easeOut` на появі елементів UI.
8. **Звук на кожну подію** — 60% відчуття «соковитості» дає аудіо, не графіка.

> Це і є пряма відповідь на «мінімум ефектів анімації спрайтів»: **анімація трансформаціями, а не кадрами**. Дешевше, легше, надійніше — і не залежить від якості AI-генерації.

---

## 5. AI-пайплайн генерації ассетів

### 5.1 Загальна схема

```
[1] Style bible      → Nano Banana Pro / Midjourney / Flux
        ↓                 (1 еталонне зображення, фіксує стиль назавжди)
[2] Персонаж/обʼєкти → Nano Banana Pro (character sheet) або Scenario (кастомний стиль-LoRA)
        ↓                 прозорий PNG, 512×512, 2–5 с на ассет
[3] Кадри анімації   → PixelLab (skeleton/text-to-anim) АБО Kling/Wan image→video
        ↓
[4] Витяг + чистка   → ffmpeg (кадри) → rembg/BiRefNet (альфа) → вирівнювання pivot
        ↓                 ⚠️ найважливіший і найручніший крок
[5] Ручний прохід    → Aseprite / Photopea: квантизація палітри, обрізка, півоти
        ↓
[6] Пакування        → TexturePacker / free-tex-packer → atlas.png + atlas.json
        ↓
[7] Аудіо            → ElevenLabs SFX (звуки), Suno (луп-музика) → .ogg/.m4a
```

### 5.2 Інструменти під наш кейс (порівняння)

| Інструмент | Що робить | Ціна (станом на 2026) | Коли брати |
|---|---|---|---|
| **Nano Banana Pro** (Google/Gemini) | статичні ассети, character sheets, ~93% консистентності персонажа, прозорий PNG, 2–5 с на 512×512 | за API/підписку Gemini | **база для не-піксельного стилю** |
| **Scenario.gg** | тренування власного стилю → всі ассети в одному вигляді | підписка | якщо треба 50+ ассетів у єдиному стилі |
| **PixelLab.ai** | піксель-арт: 4/8 напрямків, skeleton- і text-to-animation, експорт спрайтшита | платна підписка | **якщо стиль = піксель-арт** |
| **Retro Diffusion** | піксель-арт + `rd-animation`; розширення для Aseprite | ~1¢/зображення (кредити), анімація ≈10 кредитів; Aseprite-екстеншн $65 (full) / $20 (lite) | найчистіша піксельна база |
| **Ludo.ai Sprite Generator** | 30+ стилів, експорт готових аркушів з atlas-даними під Unity/Godot/GameMaker | підписка | швидкий чорновий пайплайн |
| **Kling / Wan / Sora** (image→video) | оживлення статичного персонажа у відео | покадрова оплата | для не-піксельних, «мультяшних» рухів |
| **rembg / BiRefNet / videobgremover** | зняття фону покадрово, альфа | free / freemium | обовʼязковий крок після відео |
| **ElevenLabs SFX / Suno** | звуки й музика | freemium | останній тиждень розробки |

### 5.3 Практичні застереження (це важливо)

1. **AI-кадри «плавають».** Головна причина зламаних спрайтшитів — силует не тримає ту саму позицію в клітинці між кадрами. Вирівнювання pivot — це те, що відрізняє робочий аркуш від сміття. **Закладайте ручний прохід**, автоматика тут ще не дотягує.
2. **Тому й обираємо мінімум кадрів.** Чим менше AI-кадрів, тим менше поверхні для помилки. 2 кадри й tween завжди виглядають краще за 8 кривих AI-кадрів.
3. **Ліцензії.** Перевірте комерційні умови кожного інструмента перед релізом (особливо кредитних сервісів і моделей із «personal use» тарифами).
4. **Політика сторів щодо AI-контенту.** Google Play у 2026 окремо ріже «низькоцінні AI-застосунки». Гра має мати власну механіку й полірування — AI-арт сам по собі не рятує, а при недбалості стає причиною реджекту.
5. **Не генеруйте те, що можна намалювати кодом.** Фон із двох градієнтних прямокутників, частинки, UI — це `Graphics`, а не PNG. Це і легше, і масштабується під будь-який екран.

---

## 6. Концепт гри

### 6.1 Критерії добору

Механіка має:
- пояснюватися **без слів за 3 секунди** відео («instant clarity» — базова умова віральності);
- керуватися **одним пальцем однією дією**;
- бути **«чесною»** — смерть завжди зрозуміла гравцю (принцип Flappy Bird: однакова сила стрибка, однакова швидкість падіння, ти завжди знаєш, де помилився);
- давати **зростання скіла** — легко почати, важко освоїти;
- виробляти **артефакт для шерингу**.

### 6.2 Три кандидати

| # | Концепт | Керування | Чому віральний | Кадрів арту | Ризик |
|---|---|---|---|---|---|
| **A** | **Hook / Гак** — герой летить, тап = чіпляє гак за верхню точку і робить дугу, відпустив = летить по інерції | tap-hold-release | Момент «майже врізався» на швидкості = ідеальний кліп | ~6 | ритм складніше налаштувати |
| **B** | **Flip / Двійник** — два дзеркальні коридори, тап миттєво перекидає героя між ними, перешкоди різні | 1 тап | Максимально читабельно у відео; «мозок ламається» на швидкості | ~4 | близько до відомих клонів |
| **C** | **Ricochet / Стіни** — тап = стрибок від стіни до стіни вгору вежею, зверху наздоганяє загроза | 1 тап | Вертикальний формат = нативний під TikTok/Shorts | ~5 | жанр перенасичений |

### 6.3 Рекомендація: **A (Hook)** + віральний шар «Clip»

**Чому A:** дає найкращу криву скіла (тайминг + довжина дуги = два виміри майстерності при одній кнопці), дозволяє «near-miss»-моменти, і візуально унікальний — мотузка/трос читається у кадрі миттєво, на відміну від чергового квадратика між трубами. Мінімум арту: герой (2–4 кадри), гак-точка (1), трос — це `Graphics.lineTo`, фон — градієнт.

**Головна фіча (те, заради чого все):**
> Гра постійно тримає **ring-buffer останніх 3 секунд** ігрового стану. У момент смерті — slow-mo (0.25×) останньої секунди, і гравцю пропонується кнопка **«Поділитися кліпом»**, яка збирає **GIF/MP4 3 секунди + скор** і одразу шерить у Telegram-чат чи зберігає для TikTok.

Це:
- дає готовий вірусний контент **без зусиль гравця**;
- перетворює поразку (найчастішу подію в грі) на дію поширення;
- закриває вимогу «хочу гіфки» в місці, де GIF реально доречний.

### 6.4 Стартові параметри балансу (для першого прототипу)

Це не догма, а точка, від якої тюнити. Все — у config-файлі, щоб міняти без перезбірки.

| Параметр | Стартове значення |
|---|---|
| Гравітація | 1600 px/с² |
| Горизонтальна швидкість (старт) | 260 px/с |
| Приріст швидкості | +8 px/с кожні 10 с, стеля 520 px/с |
| Довжина троса | 120–260 px (автопідбір до найближчого анкера в конусі 60°) |
| Кутова швидкість на тросі | зберігає імпульс, без демпфування (принцип «чесності») |
| Вікно вводу | tap реєструється навіть за 80 мс до валідного анкера (input buffer) |
| Хітбокс героя | 70% від візуального розміру (прощаючий) |
| Смерть | лише зіткнення з перешкодою/землею |
| Час рестарту | **< 400 мс** — критично для петлі «ще один раз» |
| Ціль тривалості сесії | 5–7 хвилин, середній ран 15–40 с |

**Правило «чесності»:** жодної випадковості, що вбиває. Рівень генерується з сідів, але кожна перешкода має бути проходимою з будь-якого валідного стану гравця. Гравець мусить завжди сказати «я лоханувся», а не «гра підстава».

### 6.5 Мета-шар (той самий hybrid-casual, що дає ×3–5 LTV)

Мінімальний, не роздуваємо:
- **Скіни героя** (тільки перефарбування tint + 1–2 унікальні) — за Stars або за м'яку валюту.
- **Щоденний челендж** з фіксованим сідом — усі грають однакову трасу → природні порівняння в чатах.
- **Streak** — щоденна серія заходів.
- **Continue за rewarded ad** — один раз за ран.

---

## 7. Технічна архітектура MVP

```
game/
├── index.html                 # + telegram-web-app.js
├── src/
│   ├── main.ts                # Phaser.Game config, resize, DPR
│   ├── scenes/
│   │   ├── Boot.ts            # завантаження атласу (1 файл) + аудіо-спрайта
│   │   ├── Game.ts            # ядро: фізика, генерація, колізії
│   │   └── Result.ts          # скор, кліп, шеринг, рестарт
│   ├── systems/
│   │   ├── Spawner.ts         # seeded-генерація траси
│   │   ├── Juice.ts           # shake, hitstop, particles, squash
│   │   ├── ClipRecorder.ts    # ring-buffer 3 с → GIF/MP4
│   │   └── Telegram.ts        # WebApp API: haptic, share, Stars
│   ├── config/balance.ts      # ВСІ числа балансу тут
│   └── analytics.ts           # події: run_start, run_end, share, ad_view
├── assets/
│   ├── atlas.png + atlas.json # ЄДИНИЙ атлас, ≤2048×2048
│   └── sfx.m4a + sfx.json     # аудіоспрайт одним файлом
└── tools/
    ├── pack-atlas.mjs         # free-tex-packer CLI
    └── frames-from-video.sh   # ffmpeg + rembg + вирівнювання
```

**Технічні вимоги-гейти:**
- Розмір усього білда **≤ 3 МБ** (gzip), час до першого кадру **≤ 2 с** на 4G / середньому Android.
- Стабільні **60 FPS**; при просіданні — автозниження кількості частинок.
- Всі текстури — **один атлас** (1 draw call на всю сцену).
- Vertical-first: 9:16, safe-area для Telegram-хедера.
- Haptic feedback через `Telegram.WebApp.HapticFeedback` — безкоштовний джус.
- Офлайн-стійкість: скор у `localStorage` + синк на бекенд, якщо є.

**ClipRecorder — як реалізувати дешево:** не писати відео з канваса в реальному часі (дорого). Записувати **стан** (позиції обʼєктів, ~30 кадрів × кілька чисел), а після смерті **переграти** його на офскрін-канвасі й закодувати через `gif.js` у воркері або `MediaRecorder` (WebM). Займає ~300–600 мс на паузі — непомітно.

---

## 8. Монетизація

### 8.1 Telegram-фаза

| Джерело | Реалістика | Примітка |
|---|---|---|
| **Telegram Stars** (скіни, continue-паки) | основне | нативна каса, без комісій сторів |
| **Adsgram rewarded interstitial** | CTR **20–40%** (проти 0.5–2% у банерів) | але CPM низький: від ~0.1 TON ≈ **$0.35–0.50 / 1000** |
| TON / P2E | ❌ не робити | категорія просіла на 9%, регуляторний ризик, вбиває довіру |

**Тверезо:** на 100k показів реклами в TG це ~$35–50. Telegram-фаза — це **валідація й аудиторія**, а не дохід.

### 8.2 Стор-фаза (після проходження гейтів)

| Джерело | Бенчмарк 2026 |
|---|---|
| Rewarded video (AdMob/AppLovin MAX) | eCPM casual Android ≈ **$3.02** і падає |
| Interstitial | ставити рідко: 1 на 3 рани максимум |
| IAP: remove ads + скіни | те, що дає hybrid-casual ×3–5 LTV |
| ARPDAU-ціль | $0.03–0.08 (hypercasual-бенчмарк) |

**Гейт окупності UA:** платний UA має сенс лише якщо `LTV(30d) > CPI`. При CPI $0.50 (Tier-1, «ефективний» поріг) і ARPDAU $0.05 з D7 12% — LTV не дотягує. **Висновок: UA не купуємо. Ростемо органічно.**

---

## 9. Віральність і маркетинг

### 9.1 Три петлі, які треба закодити (не «зробити потім»)

1. **Share-loop (Telegram):** смерть → кліп + скор-картка → «кинути виклик» у чат → друг відкриває, одразу грає той самий сід → його результат прилітає назад у чат. Реферал винагороджує **обох** (модель Notcoin) — саме це дає CPI $0.1–0.5.
2. **Clip-loop (TikTok/Shorts):** вертикальний формат 9:16, кліп смерті експортується готовим до заливки. Гра має бути читабельною **без звуку і без пояснень**.
3. **Leaderboard-loop:** щоденний челендж з єдиним сідом → таблиця друзів у чаті, не глобальна (глобальна демотивує).

### 9.2 Контент-стратегія

- **UGC-стиль замість продакшену.** Реакційні відео від мікро-креаторів виглядають нативно і не вигорають, як полірована реклама. Тренд 2026 — сотні мікроінфлюенсерів замість одного макро.
- **Спершу органіка знаходить хук**, і лише потім (якщо взагалі) під переможні креативи ставиться бюджет.
- **Візуальний хук:** відео мають показувати «нагороджувальні» дії — руйнування, комбо, несподіваний результат, чіткий візуальний фідбек.
- **Тестувати 10–20 варіантів першого кадру** — саме перші 1.5 секунди вирішують долю ролика.

### 9.3 Що НЕ робити

- Не називати гру «Flappy щось» — і ASO-шум, і прямий шлях до реджекту за spam-політикою.
- Не запускати платний UA до підтвердженого D7.
- Не робити глобальний лідерборд на старті (читери зʼїдять мотивацію).

---

## 10. KPI і гейти рішень

| Етап | Метрика | Мінімум | Добре |
|---|---|---|---|
| Прототип (тиждень 1) | «ще один раз» на власних тестах | 10+ ранів підряд | 20+ |
| TMA-софтлонч | **D1 retention** | 27% | **33%+** |
| TMA-софтлонч | **D7 retention** | 10% | **12–15%** |
| TMA-софтлонч | Сесій/день | 2.5 | 4+ |
| TMA-софтлонч | Довжина сесії | 4 хв | 5–7 хв |
| Віральність | **K-фактор** (запрошень × конверсія) | 0.25 | **0.4+** |
| Віральність | Share rate (шер / смерть) | 2% | 5%+ |
| Реклама | Rewarded opt-in rate | 15% | 25%+ |

**Правило:** якщо після 2 ітерацій D1 < 27% — концепт не рятується полірованням. Міняти механіку, а не додавати контент.

---

## 11. Роадмап (6 тижнів, 1 розробник)

| Тиждень | Мета | Артефакт |
|---|---|---|
| **1** | Grey-box прототип: одна кнопка, фізика гака, смерть, рестарт. **Нуль арту** (прямокутники) | Playable локально; сам граю 20 ранів підряд або переробляю |
| **2** | Джус-шар: shake, hitstop, particles, squash, звуки. Seeded-генерація траси | Гра «відчувається» готовою, все ще без арту |
| **3** | AI-арт-пайплайн: style bible → 8–12 кадрів → атлас. Заміна прямокутників | atlas.png + atlas.json ≤ 500 КБ |
| **4** | Telegram-інтеграція: WebApp API, haptic, шеринг, реферали, ClipRecorder | Публічний TMA-бот, перші 100 гравців |
| **5** | Аналітика + монетизація: Stars, Adsgram rewarded, щоденний челендж | Дашборд D1/D7/K |
| **6** | **Гейт-рішення.** Або ітерація механіки, або Capacitor → Google Play closed testing (14 днів) | Рішення на даних, не на відчуттях |

---

## 12. Ризики та мітигації

| Ризик | Ймовірність | Мітигація |
|---|---|---|
| Механіка не «залипає» (D1 < 27%) | **висока** | Grey-box тиждень 1 — дізнаємось до вкладення в арт |
| Реджект у сторах за clone/minimal functionality | середня | Унікальна механіка + мета-шар + полірування; не запускати клон-нейм |
| AI-кадри «плавають», спрайтшит ламається | **висока** | Свідомо мінімум кадрів; ручний прохід вирівнювання; ставка на tween-анімацію |
| Ліцензійні обмеження AI-інструментів | середня | Перевірити комерційні умови ДО генерації фінальних ассетів |
| Продуктивність Telegram-вебвʼю на слабких Android | середня | Один атлас, 1 draw call, авто-даунгрейд частинок, тест на реальному пристрої з тижня 1 |
| Падіння eCPM робить рекламу безглуздою | висока | Ставка на IAP-мета-шар (hybrid casual), не на ad-only |
| Telegram гейм-категорія просідає | середня | TMA — це канал валідації; стори лишаються ціллю монетизації |

---

## 13. Наступний крок

Найдешевша перевірка всієї гіпотези — **grey-box прототип за 1–2 дні**: Phaser + прямокутники + фізика гака + рестарт за 400 мс. Якщо він не змушує грати 20 разів підряд без арту й звуку — жодна AI-графіка цього не виправить.

Готовий одразу зібрати цей прототип у репо, якщо даєте добро.

---

## Джерела

**Ринок і монетизація**
- [What happened to hypercasual? The market's evolution — PocketGamer.biz](https://www.pocketgamer.biz/what-happened-to-hypercasual-the-markets-evolution-over-the-past-year/)
- [Ad Monetization Benchmark Report 2026 — Tenjin](https://tenjin.com/blog/ad-mon-gaming-2026/)
- [CPI Mobile Game 2026: Benchmarks & ROAS — MegaDigital](https://megadigital.ai/en/blog/cpi-mobile-game-guide/)
- [Hybrid Casual Games 2026: Market Size & Trends — Game Growth Advisor](https://gamegrowthadvisor.com/blog/2026-04-16-hybrid-casual-game-design-strategy-2026/)
- [Hybrid Casual vs Hypercasual: Retention, LTV, Revenue — Antier](https://www.antier.com/blogs/hybrid-casual-games-vs-hypercasual-whats-driving-higher-retention-ltv-and-revenue-in-2026/)
- [Mobile Gaming by Genre: Hypercasual Report — Gamesforum Intelligence (PDF)](https://investgame.net/wp-content/uploads/2025/07/Gamesforum-Intelligence-Hypercasual-Gaming-Report.pdf)

**Ретеншен-бенчмарки**
- [D1/D7/D30 Retention Benchmarks 2026 — Playio](https://blog.playio.co/d1-d7-d30-retention-benchmarks-2026)
- [Mobile Game Retention Benchmarks 2026 — Segwise](https://segwise.ai/blog/mobile-gaming-app-user-retention-strategies)
- [Mobile Game Retention Guide 2026 — Game Growth Advisor](https://gamegrowthadvisor.com/blog/2026-03-17-mobile-game-retention-strategies-2026/)

**Telegram Mini Apps**
- [Telegram Mini App Trends & Monetization — Solar Engine](https://blog.solar-engine.com/en-blog/docs/telegram-mini-app-trends-monetization-market)
- [Viral Telegram Games in 2026: Mechanics & Strategies — PixelPlex](https://pixelplex.io/blog/viral-mechanics-on-telegram-apps/)
- [Telegram Mini Apps 2026 Monetization Guide — Merge](https://merge.rocks/blog/telegram-mini-apps-2026-monetization-guide-how-to-earn-from-telegram-mini-apps)
- [Monetization for Telegram Mini Apps — Adsgram](https://adsgram.ai/monetization)
- [2026 Telegram Mini-App Marketing Guide — ChainPeak](https://medium.com/@chainpeak/2026-telegram-mini-app-marketing-complete-guide-how-ton-ecosystem-projects-go-from-0-to-1m-users-61eb4f752b8d)

**Рушії**
- [Best Hyper Casual Game Engines 2026 — Coherent Lab](https://www.coherentlab.com/blog/hyper-casual-game-engines)
- [Best mobile game engines in 2026 — App Radar](https://appradar.com/blog/mobile-game-engines-development-platforms)
- [Godot 4 Web Export Optimization Guide 2026](https://best-games.io/blog/godot-web-export-optimization-guide)
- [Godot 4.6 Export to Web, Android, iOS — StraySpark](https://www.strayspark.studio/blog/godot-46-export-web-android-ios-guide)
- [Defold 2D Cross-Platform Guide 2026 — Generalist Programmer](https://generalistprogrammer.com/tutorials/defold-2d-game-complete-cross-platform-tutorial)
- [godot-admob-plugin — Poing Studios (GitHub)](https://github.com/poingstudios/godot-admob-plugin)
- [AppLovin MAX — Godot integration guide](https://support.applovin.com/en/max/godot/preparing-mediated-networks)

**Графіка й анімація**
- [Texture Atlases for Mobile Games: Godot & Cocos — I Love Sprites](https://ilovesprites.com/blog/texture-atlas-mobile-godot-cocos-guide)
- [Sprite Atlas vs Spritesheet — Spritesheets.ai](https://www.spritesheets.ai/blog/spritesheet-atlas-explained)
- [Export animations for mobile apps and game engines — Adobe Animate](https://helpx.adobe.com/animate/using/create-sprite-sheet.html)
- [Squeezing more juice out of your game design — GameAnalytics](https://www.gameanalytics.com/blog/squeezing-more-juice-out-of-your-game-design)
- [Game feel on the web: squash, shake, and the art of juice](https://valdemird.com/blog/game-feel-on-the-web/)
- [How to Make Your Game Feel Good — Egmatic](https://egmatic.com/blog/how-to-make-your-game-feel-good)

**AI-генерація ассетів**
- [How We Approach Sprite Sheet Animation in AI Game Development (2026) — Seeles](https://www.seeles.ai/resources/blogs/how-to-animate-sprite-sheets-ai-game-development)
- [AI Sprite Generator & Sprite Sheet Maker — Ludo.ai](https://ludo.ai/features/sprite-generator)
- [Retro Diffusion vs PixelLab — GameDev AI Hub](https://gamedevaihub.com/retro-diffusion-vs-pixellab/)
- [Best AI Pixel Art Generators 2026 — SpriteLab](https://spritelab.dev/guides/best-ai-pixel-art-generators)
- [Spin Up an AI Sprite Sheet Generator (Browser-Based, 2026) — Sorceress](https://sorceress.games/blog/spin-up-an-ai-sprite-sheet-generator-browser-based)
- [Nano Banana Pro: Consistent Character Sheets Guide — SelfieLab](https://selfielabstudio.com/blog/nano-banana-pro-consistent-character-sheets-guide-20260216)
- [28 Nano-banana Use Cases for Game Dev — Scenario](https://www.scenario.com/blog/nano-banana-use-cases-ai-content-creation)
- [How to Make Pixel Art with AI for Games — Gamine AI](https://gamineai.com/blog/how-to-make-pixel-art-with-ai-for-games)

**Дизайн і віральність**
- [Be one with Flappy Bird: The science of 'flow' — Scientific American](https://www.scientificamerican.com/article/be-one-with-flappy-bird-the-science-of-flow-in-game-design/)
- [Flappy Bird Holds the Key to Perfect Difficulty — NYU Tandon](https://engineering.nyu.edu/news/flappy-bird-holds-key-figuring-out-perfect-difficulty-video-games)
- [Game Design Analysis of Flappy Bird and Swing Copters — Thomas Palef](https://medium.com/@thomaspalef/game-design-analysis-of-flappy-bird-and-swing-copters-5c6df9fc10f0)
- [What Makes a Game Viral in 2026 — Melior Games](https://meliorgames.com/best-practices/what-makes-a-game-viral-in-2026/)
- [TikTok Organic Strategy for Mobile Games 2026 — TokPortal](https://www.tokportal.com/verticals/tiktok-organic-strategy-mobile-games)
- [Mobile Game Marketing in 2026: UA Strategies — MegaDigital](https://megadigital.ai/en/blog/mobile-game-marketing-in-2026/)

**Політики сторів**
- [Google Play Store Policy Changes 2026](https://theandroidnews.com/google-play-store-policy-changes/)
- [Google Play Tightens AI App Policies: 'Low-Value' Apps in 2026](https://appsops.store/news/google-play-ai-content-policy-low-value-apps-2026)
- [App Store Rejection Reasons Index (2026) — Push My App](https://pushmyapp.ai/blog/app-store-rejection-reasons)
- [Google Play Developer Policy Center](https://play.google/developer-content-policy/)
