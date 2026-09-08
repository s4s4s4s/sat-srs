import { useApp, views, setScreen, startLesson } from '../lib/store'
import { streak, sessionAccuracy, matureRetention } from '../lib/journal'
import { homeCounts, sectionOf, newBudgetFor } from '../lib/scheduler'
import { newPerDay } from '../lib/norms'
import { dayKey } from '../lib/daytime'
import { Timer, Check, Bolt } from '../components/Icon'
import FlameBuddy from '../components/FlameBuddy'
import FjordScene from '../components/FjordScene'

export default function Summary() {
  const app = useApp()
  const r = app.session
  const pause = app.settings.pauseFrom && app.settings.pauseTo ? { from: app.settings.pauseFrom, to: app.settings.pauseTo } : null
  const st = streak(app.journal, undefined, pause)
  if (!r) {
    setScreen('home')
    return null
  }
  // точность урока — по ВСЕМ оценкам сессии. Раньше здесь стоял ретеншн по зрелым карточкам,
  // и урок из 41 упражнения с 13 «Заново» показывал «повторов 1 · точность 100%»
  const acc = sessionAccuracy(r)
  const ret = matureRetention(r)
  const mm = Math.floor(r.durMs / 60000)
  const ss = Math.floor((r.durMs % 60000) / 1000)
  // WS5b (часть 2): «до цели ещё K» - K из sessionGoal и doneToday, посчитанных Review.tsx
  // в той же точке, где выставлен goalReached (finish()), а не заново на этом экране.
  const toGoal = Math.max(0, app.sessionGoal - r.doneToday)
  /* «Ещё заход» - вторая дверь в урок, и запирается она тем же замком, что и кнопка раздела
     на главной (SectionBlock в Home.tsx: disabled при due === 0): созревшие learning, повторы
     до конца учебного дня и доступные новые в бюджете раздела. Без этой проверки цель дня,
     закрытая практикой, вела бы в пустой экран урока «Очередь пуста» вместо честного
     «раздел на сегодня закрыт». */
  const sectionCards = views().filter(v => sectionOf(v) === app.sessionSection)
  // журнал обязателен: у раздела «Логика» состояние живёт в нём, а не в FSRS (lib/logic.ts),
  // и без него «Ещё заход» обещал бы вопросы, которые сегодня уже разобраны
  const counts = homeCounts(sectionCards, newBudgetFor(sectionCards, newPerDay(app.sessionSection, 'norm'), app.journal, dayKey()), new Date(), app.journal)
  const moreAvail = counts.learnDue + counts.revDue + counts.newAvail > 0

  return (
    <div className="screen s-summary">
      <FjordScene tall />
      <div className="sum-wrap">
        <div className="sum-art"><FlameBuddy size={104} mood="party" /></div>
        <div>
          <h2 className="sum-title">{r.queueEmpty ? 'Очередь пуста!' : 'Сессия завершена'}</h2>
          <div className="sum-sub">
            {st.todayDone ? `серия ${st.days} — день зачтён` : 'день ещё не зачтён'}
            {st.todayDone && st.toFreeze > 0 && ` · до ❄ ещё ${st.toFreeze} дн`}
          </div>
          {/* зрелые повторы — отдельной строкой: это сигнал FSRS, а не описание проделанной работы */}
          {ret !== null && (
            <div className="sum-sub">зрелых повторов {r.totalRev} · ретеншн {ret}%</div>
          )}
          {/* WS5b (часть 2): цель дня закрыта - предлагаем ещё заход того же раздела вместо
              немедленного выхода на главную; цель не закрыта, а очередь не пуста - честно
              говорим, сколько осталось, а не молчим об этом. */}
          {r.goalReached && (
            <div className="sum-sub">{moreAvail ? 'Заход закрыт: цель дня выполнена' : 'Заход закрыт: цель дня выполнена, раздел на сегодня закрыт'}</div>
          )}
          {!r.goalReached && !r.queueEmpty && (
            <div className="sum-sub">До цели ещё {toGoal} упражнений</div>
          )}
          {/* L2: подсказанный ввод не входит в точность урока (sessionAccuracy) - показываем
              его отдельной строкой, а не молчим о том, что часть ответов была со скелета */}
          {(r.cued ?? 0) > 0 && (
            <div className="sum-sub">с подсказкой: {r.cued}</div>
          )}
        </div>
        <div className="tiles">
          <div className="tile tile-new">
            <div className="tile-head">Новых</div>
            <div className="tile-body"><Bolt size={17} />{r.newSeen}</div>
          </div>
          <div className="tile tile-due">
            <div className="tile-head">Упражнений</div>
            <div className="tile-body"><Check size={17} />{r.reviews}</div>
          </div>
          {acc !== null && (
            <div className="tile tile-gold">
              <div className="tile-head">Точность</div>
              <div className="tile-body">{acc}%</div>
            </div>
          )}
          <div className="tile tile-time">
            <div className="tile-head">Время</div>
            <div className="tile-body"><Timer size={16} />{mm}:{String(ss).padStart(2, '0')}</div>
          </div>
        </div>
        {r.goalReached && moreAvail ? (
          <>
            <button className="btn btn-green btn-lg" onClick={() => startLesson(app.sessionSection, false, false)}>Ещё заход</button>
            <button className="btn btn-lg" onClick={() => setScreen('home')}>На главную</button>
          </>
        ) : (
          <button className="btn btn-green btn-lg" onClick={() => setScreen('home')}>Дальше</button>
        )}
      </div>
    </div>
  )
}
