/**
 * Тесты миграции настроек (src/lib/settings.ts) — чистая часть, без React и IndexedDB.
 *
 * migrateSettings трогает живые настройки владельца PWA при каждом обновлении:
 * ошибка здесь не падает с исключением, а тихо портит устройство — теряет токен,
 * возвращает удалённый ключ или забывает донести дефолт. Явных проверок не было
 * ни одной, поэтому набор гоняет каждую ступень отдельно и всю цепочку целиком.
 *
 * Запуск: `npm run test:settings` (esbuild бандлит файл и node его исполняет).
 */
import { migrateSettings } from '../src/lib/settings'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, type Settings } from '../src/lib/types'

let passed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function group(name: string): void { console.log(`  ✓ ${name}`); passed++ }

// ── T1: v7 → текущая — newPerDay/newPerLesson уходят, остальное остаётся ----
function dropsNewPerFields(): void {
  const saved = {
    v: 7,
    pat: 'ghp_xxx',
    owner: 'кто-то',
    repo: 'своя-колода',
    branch: 'feature',
    basePath: 'Своя/Папка',
    requestRetention: 0.85,
    pauseFrom: '2026-01-01',
    pauseTo: '2026-01-02',
    homeOffset: '180',
    typing: false,
    sound: false,
    coachToken: 'tok',
    newPerDay: 15,
    newPerLesson: 5
  } as unknown as Partial<Settings>
  const s = migrateSettings(saved) as Settings & { newPerDay?: number; newPerLesson?: number }
  assert(!('newPerDay' in s), 'newPerDay пережил миграцию v8')
  assert(!('newPerLesson' in s), 'newPerLesson пережил миграцию v8')
  // прочие поля — не тронуты и не заменены дефолтами
  assert(s.pat === 'ghp_xxx', 'pat потерян при миграции с v7')
  assert(s.owner === 'кто-то', 'owner потерян при миграции с v7')
  assert(s.repo === 'своя-колода', 'repo затёрт дефолтом — ступень v5 применяется только к тем, кто идёт через неё')
  assert(s.branch === 'feature', 'branch затёрт дефолтом — ступень v5 применяется только к тем, кто идёт через неё')
  assert(s.basePath === 'Своя/Папка', 'basePath потерян при миграции с v7')
  assert(s.requestRetention === 0.85, 'requestRetention потерян при миграции с v7')
  assert(s.pauseFrom === '2026-01-01', 'pauseFrom затёрт дефолтом — ступень v2 применяется только к тем, кто идёт через неё')
  assert(s.pauseTo === '2026-01-02', 'pauseTo затёрт дефолтом — ступень v2 применяется только к тем, кто идёт через неё')
  assert(s.homeOffset === '180', 'homeOffset затёрт дефолтом — ступень v2 применяется только к тем, кто идёт через неё')
  assert(s.typing === false, 'typing затёрт дефолтом — ступень v3 применяется только к тем, кто идёт через неё')
  assert(s.sound === false, 'sound затёрт дефолтом — ступень v6 применяется только к тем, кто идёт через неё')
  assert(s.coachToken === 'tok', 'coachToken потерян при миграции с v7')
  assert(s.v === SETTINGS_VERSION, 'версия после миграции не поднята до текущей')
  group('T1: настройки v7 теряют newPerDay/newPerLesson, всё прочее сохраняется')
}

// ── T2: самый старый случай — поля версии нет вовсе -------------------------
function noVersionAtAll(): void {
  const saved = { pat: 'старый-токен' } as unknown as Partial<Settings>
  const s = migrateSettings(saved)
  assert(s.v === SETTINGS_VERSION, 'настройки без поля версии не доехали до текущей')
  // все дефолты должны быть на месте, кроме явно сохранённого pat
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (key === 'pat' || key === 'v') continue
    assert(
      JSON.stringify(s[key]) === JSON.stringify(DEFAULT_SETTINGS[key]),
      `поле ${String(key)} не получило дефолт при миграции с нулевой версии`
    )
  }
  assert(s.pat === 'старый-токен', 'pat потерян при миграции с нулевой версии')
  group('T2: настройки без версии (самый старый случай) доезжают до текущей и получают дефолты')
}

// ── T3: идемпотентность — настройки текущей версии не меняются --------------
function idempotent(): void {
  const current: Settings = { ...DEFAULT_SETTINGS, pat: 'уже-стоит', repo: 'моя-колода' }
  const once = migrateSettings(current)
  const twice = migrateSettings(once)
  assert(JSON.stringify(once) === JSON.stringify(current), 'миграция настроек текущей версии изменила их')
  assert(JSON.stringify(twice) === JSON.stringify(once), 'повторный прогон миграции дал другой результат')
  group('T3: настройки текущей версии проходят миграцию без изменений (идемпотентность)')
}

// ── T4: каждая ступень применяется ровно раз к своей версии ------------------
function everyStepOnce(): void {
  for (let v = 1; v <= SETTINGS_VERSION; v++) {
    const saved = { v, pat: `token-${v}` } as unknown as Partial<Settings>
    const s = migrateSettings(saved)
    assert(s.v === SETTINGS_VERSION, `настройки версии ${v} не доехали до текущей версии`)
    assert(!('newPerDay' in (s as any)) && !('newPerLesson' in (s as any)),
      `настройки версии ${v}: мёртвые ключи норм ввода не были сняты`)
    assert(!('anthropicKey' in (s as any)), `настройки версии ${v}: anthropicKey не был удалён`)
    assert(s.pat === `token-${v}`, `настройки версии ${v}: не относящееся к миграциям поле pat затронуто`)
  }
  group('T4: каждая ступень мигрирует настройки любой исходной версии (1..текущая) до валидного состояния')
}

// ── T5: принудительно доносимые поля побеждают старые сохранённые значения ---
function forcedFieldsWin(): void {
  const saved = {
    v: 1,
    typing: false,
    sound: false,
    repo: 'чужой-репозиторий',
    branch: 'чужая-ветка',
    pauseFrom: '2000-01-01',
    pauseTo: '2000-01-02',
    homeOffset: '999'
  } as unknown as Partial<Settings>
  const s = migrateSettings(saved)
  assert(s.typing === DEFAULT_SETTINGS.typing, 'typing не донесён принудительно ступенью v3')
  assert(s.sound === DEFAULT_SETTINGS.sound, 'sound не донесён принудительно ступенью v6')
  assert(s.repo === DEFAULT_SETTINGS.repo, 'repo не донесён принудительно ступенью v5')
  assert(s.branch === DEFAULT_SETTINGS.branch, 'branch не донесён принудительно ступенью v5')
  assert(s.pauseFrom === DEFAULT_SETTINGS.pauseFrom, 'pauseFrom не донесён принудительно ступенью v2')
  assert(s.pauseTo === DEFAULT_SETTINGS.pauseTo, 'pauseTo не донесён принудительно ступенью v2')
  assert(s.homeOffset === DEFAULT_SETTINGS.homeOffset, 'homeOffset не донесён принудительно ступенью v2')
  group('T5: typing/sound/repo/branch/часовой пояс/границы паузы принудительно донесены дефолтом')
}

// ── T6: anthropicKey удалён ступенью v7 и не возвращается --------------------
function anthropicKeyRemoved(): void {
  const saved = { v: 6, anthropicKey: 'sk-ant-живой-ключ' } as unknown as Partial<Settings>
  const s = migrateSettings(saved) as Settings & { anthropicKey?: string }
  assert(!('anthropicKey' in s), 'anthropicKey пережил миграцию v7 — платный токен утёк в устройство')
  group('T6: удалённый ступенью v7 ключ anthropicKey не возвращается')
}

// ── T7: незнакомые поля не роняют миграцию -----------------------------------
function unknownFieldsSurvive(): void {
  const saved = { v: 3, весёлоеПолеОтКоторогоНичегоНеЖдут: 42, другое: { вложенное: true } } as unknown as Partial<Settings>
  const s = migrateSettings(saved) as Settings & Record<string, unknown>
  assert(s.v === SETTINGS_VERSION, 'незнакомые поля уронили версию после миграции')
  assert(s['весёлоеПолеОтКоторогоНичегоНеЖдут'] === 42, 'незнакомое числовое поле пропало при миграции')
  assert(JSON.stringify(s['другое']) === JSON.stringify({ вложенное: true }), 'незнакомое вложенное поле пропало при миграции')
  group('T7: незнакомые чужие поля в сохранённом объекте не роняют миграцию')
}

function main(): void {
  console.log('SRS настройки — миграция сохранённого объекта (src/lib/settings.ts)')
  dropsNewPerFields()
  noVersionAtAll()
  idempotent()
  everyStepOnce()
  forcedFieldsWin()
  anthropicKeyRemoved()
  unknownFieldsSurvive()
  console.log(`\nВсе проверки миграции настроек пройдены (${passed} групп).`)
}

try {
  main()
} catch (e) {
  console.error('\n✗ ТЕСТ МИГРАЦИИ НАСТРОЕК УПАЛ:\n' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
