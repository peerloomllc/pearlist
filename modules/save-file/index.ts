import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

// Android "save as" (ACTION_CREATE_DOCUMENT). See android/.../SaveFileModule.kt for
// why neither the share sheet nor SAF directory permissions can do this job.
//
// Android only. On iOS the share sheet's "Save to Files" is the same choose-a-
// folder flow, so the shell uses that instead and this module is absent.
const SaveFile = requireOptionalNativeModule<{
  saveText(filename: string, content: string, mimeType: string | null): Promise<SaveResult>
}>('SaveFile')

export type SaveResult = { canceled: true } | { canceled: false, uri: string, name: string }

export const saveFileSupported = Platform.OS === 'android' && !!SaveFile

// Presents the system save dialog with `filename` pre-filled, then writes
// `content` to wherever the user chose - Downloads included, which is the whole
// point. Resolves { canceled: true } if they back out; that is a decision, not an
// error, so it does not throw. A real write failure DOES throw: a backup that
// silently did not happen is the worst outcome available here.
export async function saveTextFile (filename: string, content: string, mimeType = 'application/json'): Promise<SaveResult> {
  if (!saveFileSupported) throw new Error('saving files is not supported on this platform')
  return await SaveFile!.saveText(filename, content, mimeType)
}
