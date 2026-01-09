import * as React from "react"
import { cn } from "../../lib/utils"
import { ChevronDown } from "lucide-react"

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative group">
        <select
          className={cn(
            "flex h-11 w-full bg-secondary/50 border-0 border-b-2 border-foreground/30 px-0 py-3 pr-8 text-sm focus:outline-none focus:border-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50 appearance-none cursor-pointer",
            "hover:bg-secondary/70 hover:border-foreground/50",
            className
          )}
          style={{ backgroundImage: 'none' }}
          ref={ref}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none transition-colors group-hover:text-foreground" />
      </div>
    )
  }
)
Select.displayName = "Select"

export { Select }

