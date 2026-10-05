import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

// Pill controls with tracked uppercase labels. The primary action is sky blue; everything else is ink.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-[0.68rem] font-medium tracking-[0.08em] whitespace-nowrap uppercase transition-[color,background-color,border-color,box-shadow] duration-300 ease-out-cubic outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-sky-ink text-white hover:bg-[color-mix(in_oklch,var(--sky-ink),black_14%)] dark:text-[#10182b] dark:hover:bg-[color-mix(in_oklch,var(--sky-ink),white_12%)]",
        outline:
          "border-foreground/25 bg-transparent text-foreground hover:border-foreground hover:bg-foreground hover:text-background aria-expanded:bg-muted",
        secondary: "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)]",
        ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive hover:text-white focus-visible:ring-destructive/20 dark:bg-destructive/20",
        link: "rounded-none tracking-normal normal-case text-sky-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 gap-2 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        xs: "h-6 gap-1 px-3 text-[0.6rem] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-4 text-[0.64rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-7 text-[0.72rem]",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
