import { type PerformanceProfile, useTheme } from '../../contexts/ThemeContext'
import { THEME_PRESETS, type ThemeId } from '../../theme/presets'

const THEME_LABELS: Record<ThemeId, string> = {
  default: 'Cordia Dark',
  amoled: 'Amoled Dark',
}

const PERFORMANCE_LABELS: Record<PerformanceProfile, { label: string; description: string }> = {
  quality: {
    label: 'Quality',
    description: 'Full visual effects and normal media behavior.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Keeps the look while preparing for reduced work in busy views.',
  },
  'low-end': {
    label: 'Low-end',
    description: 'Reduces blur, shimmer, heavy shadows, transitions, and costly media effects.',
  },
}

export function CustomizeSettings() {
  const { themeId, setThemeId, performanceProfile, setPerformanceProfile } = useTheme()

  const handleChange = (id: ThemeId) => {
    setThemeId(id)
  }

  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-light tracking-tight">Appearance</h2>
          <p className="text-xs text-muted-foreground">
            Choose a preset colorway for Cordia&apos;s background, cards, friends list, and composer. Changes apply only
            on this device.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(THEME_PRESETS) as ThemeId[]).map((id) => {
          const preset = THEME_PRESETS[id]
          const selected = id === themeId
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleChange(id)}
              className={`w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                selected ? 'border-foreground bg-background/60' : 'border-border/70 hover:border-foreground/60'
              }`}
            >
              <div className="h-10 w-14 rounded-sm border border-border/60 overflow-hidden flex-shrink-0">
                <div
                  className="h-1/2 w-full"
                  style={{ backgroundColor: `hsl(${preset.background})` }}
                  aria-hidden
                />
                <div className="h-1/2 w-full flex">
                  <div
                    className="flex-1"
                    style={{ backgroundColor: `hsl(${preset.card})` }}
                    aria-hidden
                  />
                  <div
                    className="w-2"
                    style={{ backgroundColor: `hsl(${preset.accent})` }}
                    aria-hidden
                  />
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-light truncate">{THEME_LABELS[id]}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {id === 'default' ? 'Neutral dark with Discord-like layering.' : 'Ultra-dark contrast for OLED screens.'}
                </p>
              </div>
              <div
                className={`h-2 w-2 rounded-full border ${
                  selected ? 'bg-foreground border-foreground' : 'bg-transparent border-muted-foreground'
                }`}
                aria-hidden
              />
            </button>
          )
        })}
      </div>

      <div className="border-t border-border/50 pt-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium tracking-tight">Performance Profile</h3>
          <p className="text-xs text-muted-foreground">
            Quality keeps Cordia looking the same. Low-end mode disables expensive visual effects for weaker hardware.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(PERFORMANCE_LABELS) as PerformanceProfile[]).map((profile) => {
            const selected = profile === performanceProfile
            const item = PERFORMANCE_LABELS[profile]
            return (
              <button
                key={profile}
                type="button"
                onClick={() => setPerformanceProfile(profile)}
                className={`rounded-md border px-3 py-2 text-left transition-colors ${
                  selected ? 'border-foreground bg-background/60' : 'border-border/70 hover:border-foreground/60'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-light">{item.label}</p>
                  <span
                    className={`h-2 w-2 rounded-full border ${
                      selected ? 'bg-foreground border-foreground' : 'bg-transparent border-muted-foreground'
                    }`}
                    aria-hidden
                  />
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{item.description}</p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

