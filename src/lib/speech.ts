/**
 * Произношение слов через встроенный speechSynthesis.
 * Капризы iOS: голоса подгружаются асинхронно (voiceschanged), speak() работает
 * только из жеста пользователя, utterance надо держать в ссылке (иначе GC глушит звук),
 * перед speak — cancel() (застрявшая очередь после сворачивания).
 */

let voice: SpeechSynthesisVoice | null = null
let current: SpeechSynthesisUtterance | null = null

function pickVoice() {
  try {
    const all = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().startsWith('en'))
    voice =
      all.find(v => v.lang === 'en-US' && v.localService) ??
      all.find(v => v.lang === 'en-US') ??
      all.find(v => v.localService) ??
      all[0] ?? null
  } catch { voice = null }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  pickVoice()
  try { speechSynthesis.addEventListener('voiceschanged', pickVoice) } catch { /* старые Safari */ }
}

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Озвучить английское слово/фразу. Вызывать только из обработчика тапа/клика. */
export function speak(text: string) {
  if (!canSpeak() || !text.trim()) return
  try {
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'en-US'
    if (voice) u.voice = voice
    u.rate = 0.95
    current = u // держим ссылку — iOS-баг с GC
    u.onend = () => { if (current === u) current = null }
    speechSynthesis.speak(u)
  } catch { /* нет голосов — молча */ }
}
