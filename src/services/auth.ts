export function isSessionRoute(pathname: string): boolean {
  return pathname === "/login" || pathname === "/register";
}

export function resolveAuthRedirect(pathname: string, token: string | null): string {
  if (!token && !isSessionRoute(pathname)) {
    return "/login";
  }
  if (token && isSessionRoute(pathname)) {
    return "/";
  }
  return pathname;
}
