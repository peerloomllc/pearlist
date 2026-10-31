// Links that are not pages. The iOS Share Extension opens pearlist://share only to
// bring the app forward (modules/share-intent reads the share itself). Left to the
// router it is an unknown page, so +not-found redirects to / and remounts the
// shell, which reloads the WebView and loses the share sheet it just opened. While
// running, returning nothing makes the router ignore the link; at launch it must
// return a path, so it starts at /.
export function redirectSystemPath ({ path, initial }: { path: string, initial: boolean }) {
  if (/^pearlist:\/\/share/.test(path)) return initial ? '/' : null
  return path
}
