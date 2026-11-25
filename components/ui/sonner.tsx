"use client";

import { useEffect, useState } from "react";
import {
  RiCheckboxCircleLine,
  RiInformationLine,
  RiErrorWarningLine,
  RiCloseCircleLine,
  RiLoaderLine,
} from "@remixicon/react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { cn } from "@/lib/utils";

const CHOWA_PRZYCISK_ZAMKNIECIA = "[&_[data-close-button]]:hidden!";

/**
 * Przycisk zamknięcia tylko w powiadomieniach o błędzie (D47, WCAG 2.1 2.2.1:
 * błąd nie może zniknąć, zanim się go przeczyta). Sonner nie ma opcji
 * `closeButton` per typ, więc włączamy go dla wszystkich, a pozostałe typy
 * chowają go klasą. Sukces i reszta znikają same jak dotąd.
 */
export const TOAST_OPTIONS_ZAMKNIECIE_BLEDU: NonNullable<ToasterProps["toastOptions"]> = {
  closeButton: true,
  classNames: {
    success: CHOWA_PRZYCISK_ZAMKNIECIA,
    info: CHOWA_PRZYCISK_ZAMKNIECIA,
    warning: CHOWA_PRZYCISK_ZAMKNIECIA,
    loading: CHOWA_PRZYCISK_ZAMKNIECIA,
    default: CHOWA_PRZYCISK_ZAMKNIECIA,
  },
};

/**
 * Nie używamy `useTheme()` z next-themes — w projekcie nie ma `<ThemeProvider>`.
 * Bez tego przy pełnym reloadzie (hydratacja) można dostać niespójny subtree.
 *
 * SSR + pierwsza klatka: `null`. Po montażu: motyw ze `class` na `<html>`.
 */
export function Toaster(props: ToasterProps) {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const read = () =>
      setTheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
    queueMicrotask(() => {
      read();
      setMounted(true);
    });
    const mo = new MutationObserver(() => {
      queueMicrotask(read);
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => mo.disconnect();
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <Sonner
      {...props}
      theme={theme}
      className="toaster group"
      icons={{
        success: <RiCheckboxCircleLine className="size-4" />,
        info: <RiInformationLine className="size-4" />,
        warning: <RiErrorWarningLine className="size-4" />,
        error: <RiCloseCircleLine className="size-4" />,
        loading: <RiLoaderLine className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButton: TOAST_OPTIONS_ZAMKNIECIE_BLEDU.closeButton,
        ...props.toastOptions,
        classNames: {
          ...TOAST_OPTIONS_ZAMKNIECIE_BLEDU.classNames,
          ...props.toastOptions?.classNames,
          toast: cn("cn-toast", props.toastOptions?.classNames?.toast),
          title: props.toastOptions?.classNames?.title,
          description: props.toastOptions?.classNames?.description,
        },
      }}
    />
  );
}
