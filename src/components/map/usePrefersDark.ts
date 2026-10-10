import { useEffect, useState } from "react";

/** Whether the dark palette is active. Map code needs this because
    deck.gl layer colours and the basemap style are built in JS from the
    CSS tokens — anything that bakes a token into a layer must rebuild
    when the theme flips (CSS-rendered chrome gets it for free). */
export default function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
