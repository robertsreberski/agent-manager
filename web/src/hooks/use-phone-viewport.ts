import { useEffect, useState } from "react";

export const PHONE_VIEWPORT_QUERY = "(max-width: 900px)";

function matchesPhoneViewport(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

export function usePhoneViewport(): boolean {
  const [phone, setPhone] = useState(matchesPhoneViewport);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const update = () => setPhone(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}
