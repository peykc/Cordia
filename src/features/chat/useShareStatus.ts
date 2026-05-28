import { useEphemeralMessagesStore } from '../../stores/ephemeralMessagesStore'
import { selectShareStatus } from '../../domain/sharing/selectors'

export function useShareStatus(sha256: string | undefined, serverSigningPubkey: string | undefined) {
  return useEphemeralMessagesStore((state) =>
    selectShareStatus({
      serverSharedSha: state.serverSharedSha,
      currentServerSigningPubkey: serverSigningPubkey,
      sha256,
    })
  )
}
