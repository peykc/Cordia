import * as React from "react"
import { cn } from "../../lib/utils"

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  value?: number
  onValueChange?: (value: number) => void
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, value = 0, onValueChange, onChange, min = 0, max = 1, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseFloat(e.target.value)
      onValueChange?.(newValue)
      onChange?.(e)
    }

    const percentage = ((value - Number(min)) / (Number(max) - Number(min))) * 100
    // Account for thumb width (3px = 1.5px radius) so fill extends to center of thumb
    const thumbRadius = 1.5
    const fillWidth = `calc(${percentage}% + ${thumbRadius}px)`

    return (
      <div className="relative w-full">
        {/* Track background */}
        <div className="absolute inset-0 h-1 bg-secondary/50 rounded-full" />
        {/* Filled track - extends to thumb center */}
        <div
          className="absolute left-0 top-0 h-1 bg-foreground/30 rounded-full"
          style={{ width: fillWidth }}
        />
        {/* Slider input */}
        <input
          type="range"
          className={cn(
            "relative w-full h-1 bg-transparent appearance-none cursor-pointer",
            "focus:outline-none",
            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-10",
            "[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:relative [&::-moz-range-thumb]:z-10",
            className
          )}
          ref={ref}
          value={value}
          min={min}
          max={max}
          onChange={handleChange}
          {...props}
        />
      </div>
    )
  }
)
Slider.displayName = "Slider"

export { Slider }

