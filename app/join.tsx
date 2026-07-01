import { Redirect } from 'expo-router'

// Invite deep-link landing (pear://pearlist/join?... and the https equivalent).
// The real handling happens via the Linking listeners in app/index.tsx; this
// route just redirects to the shell so expo-router does not flash +not-found.
export default function JoinRoute () {
  return <Redirect href='/' />
}
