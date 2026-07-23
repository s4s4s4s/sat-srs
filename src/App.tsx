import { useApp } from './lib/store'
import Home from './screens/Home'
import Review from './screens/Review'
import Summary from './screens/Summary'
import AddCard from './screens/AddCard'
import Stats from './screens/Stats'
import SettingsScreen from './screens/Settings'
import Path from './screens/Path'

export default function App() {
  const app = useApp()
  if (!app.ready) return <div className="boot">Загрузка…</div>
  const screen = (() => {
    switch (app.screen) {
      case 'review': return <Review />
      case 'summary': return <Summary />
      case 'add': return <AddCard />
      case 'stats': return <Stats />
      case 'path': return <Path />
      case 'settings': return <SettingsScreen />
      default: return <Home />
    }
  })()
  // мягкий переход между экранами
  return <div className="route" key={app.screen}>{screen}</div>
}
