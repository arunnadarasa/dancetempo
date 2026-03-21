import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './polyfills'
import './index.css'
import App from './App.tsx'
import BattleApp from './BattleApp.tsx'
import CoachingApp from './CoachingApp.tsx'
import BeatsApp from './BeatsApp.tsx'
import CardApp from './CardApp.tsx'
import TravelApp from './TravelApp.tsx'
import EmailApp from './EmailApp.tsx'
const SocialApp = lazy(() => import('./SocialApp.tsx'))
import MusicApp from './MusicApp.tsx'
import ParallelApp from './ParallelApp.tsx'
import WeatherApp from './WeatherApp.tsx'
import OpenAIApp from './OpenAIApp.tsx'
import AnthropicApp from './AnthropicApp.tsx'
import OpenRouterApp from './OpenRouterApp.tsx'
import PerplexityApp from './PerplexityApp.tsx'
import AlchemyApp from './AlchemyApp.tsx'
import FalApp from './FalApp.tsx'
import ReplicateApp from './ReplicateApp.tsx'
import ExtraDanceApp from './ExtraDanceApp.tsx'
import OpsApp from './OpsApp.tsx'
import KicksApp from './KicksApp.tsx'
import Tip20App from './Tip20App.tsx'
import TempoWalletApp from './TempoWalletApp.tsx'
import PurlApp from './PurlApp.tsx'
import EvvmApp from './EvvmApp.tsx'

const isBattleRoute = window.location.pathname === '/battle'
const isCoachingRoute = window.location.pathname === '/coaching'
const isBeatsRoute = window.location.pathname === '/beats'
const isCardRoute = window.location.pathname === '/card'
const isTravelRoute = window.location.pathname === '/travel'
const isEmailRoute = window.location.pathname === '/email'
const isSocialRoute = window.location.pathname === '/social'
const isMusicRoute = window.location.pathname === '/music'
const isParallelRoute = window.location.pathname === '/parallel'
const isWeatherRoute = window.location.pathname === '/weather'
const isOpenAiRoute = window.location.pathname === '/openai'
const isAnthropicRoute = window.location.pathname === '/anthropic'
const isOpenRouterRoute = window.location.pathname === '/openrouter'
const isPerplexityRoute = window.location.pathname === '/perplexity'
const isAlchemyRoute = window.location.pathname === '/alchemy'
const isFalRoute = window.location.pathname === '/fal'
const isReplicateRoute = window.location.pathname === '/replicate'
const isDanceExtrasRoute =
  window.location.pathname === '/dance-extras' || window.location.pathname.startsWith('/dance-extras/')
const isOpsRoute = window.location.pathname === '/ops'
const isKicksRoute = window.location.pathname === '/kicks'
const isTip20Route = window.location.pathname === '/tip20'
const isTempoWalletRoute = window.location.pathname === '/tempo-wallet'
const isPurlRoute = window.location.pathname === '/purl'
const isEvvmRoute = window.location.pathname === '/evvm'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBattleRoute ? (
      <BattleApp />
    ) : isCoachingRoute ? (
      <CoachingApp />
    ) : isBeatsRoute ? (
      <BeatsApp />
    ) : isCardRoute ? (
      <CardApp />
    ) : isTravelRoute ? (
      <TravelApp />
    ) : isEmailRoute ? (
      <EmailApp />
    ) : isSocialRoute ? (
      <Suspense fallback={<main className="app" style={{ padding: '2rem' }}>Loading Social…</main>}>
        <SocialApp />
      </Suspense>
    ) : isMusicRoute ? (
      <MusicApp />
    ) : isParallelRoute ? (
      <ParallelApp />
    ) : isWeatherRoute ? (
      <WeatherApp />
    ) : isOpenAiRoute ? (
      <OpenAIApp />
    ) : isAnthropicRoute ? (
      <AnthropicApp />
    ) : isOpenRouterRoute ? (
      <OpenRouterApp />
    ) : isPerplexityRoute ? (
      <PerplexityApp />
    ) : isAlchemyRoute ? (
      <AlchemyApp />
    ) : isFalRoute ? (
      <FalApp />
    ) : isReplicateRoute ? (
      <ReplicateApp />
    ) : isDanceExtrasRoute ? (
      <ExtraDanceApp />
    ) : isOpsRoute ? (
      <OpsApp />
    ) : isKicksRoute ? (
      <KicksApp />
    ) : isTip20Route ? (
      <Tip20App />
    ) : isTempoWalletRoute ? (
      <TempoWalletApp />
    ) : isPurlRoute ? (
      <PurlApp />
    ) : isEvvmRoute ? (
      <EvvmApp />
    ) : (
      <App />
    )}
  </StrictMode>,
)
