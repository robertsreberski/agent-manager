export function relativeEditorPath(root: string | null, path: string): string | null {
  const candidate = path.startsWith("/")
    ? (() => {
        if (!root) return null;
        const normalizedRoot = root.replace(/\/+$/u, "");
        return path.startsWith(`${normalizedRoot}/`) ? path.slice(normalizedRoot.length + 1) : null;
      })()
    : path;
  if (!candidate || /[\u0000-\u001f\u007f\\]/u.test(candidate)) return null;
  const segments = candidate.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..") ? null : candidate;
}
