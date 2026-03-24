import { LayoutDashboard } from 'lucide-react'
import { TransferCenterPanel } from '../components/TransferCenterPanel'

export default function TransfersPage() {
  return (
    <div className="h-full min-h-0 p-3 flex flex-col">
      <div className="h-full min-h-0 border-2 border-border bg-card/98 backdrop-blur-sm shadow-2xl flex flex-col rounded-xl overflow-hidden ring-1 ring-black/5 dark:ring-white/5">
        <header className="shrink-0 border-b border-border/60 px-4 py-3 flex items-start gap-3 bg-gradient-to-b from-muted/35 to-muted/5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/70">
            <LayoutDashboard className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-medium tracking-tight text-foreground">Transfer hub</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
              Same layout as the transfer popup: stats, active strips, virtualized history &amp; seeding lists, and file-type filters.
            </p>
          </div>
        </header>
        <div className="flex-1 min-h-0 p-3 flex flex-col overflow-hidden">
          <TransferCenterPanel variant="full" />
        </div>
      </div>
    </div>
  )
}
