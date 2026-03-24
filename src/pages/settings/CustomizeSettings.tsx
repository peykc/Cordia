import { useTheme } from '../../contexts/ThemeContext'
import { THEME_PRESETS, type ThemeId } from '../../theme/presets'

const THEME_LABELS: Record<ThemeId, string> = {
  default: 'Cordia Dark',
}

export function CustomizeSettings() {
  const { themeId, setThemeId } = useTheme()

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
                  Neutral dark with Discord-like layering.
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
    </div>
  )
}

